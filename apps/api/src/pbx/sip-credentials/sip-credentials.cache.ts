import { Injectable } from "@nestjs/common";
import type { SipCredentialResponse } from "@optimiq-voice/events/schemas";

/**
 * How long a resolved credential is reused before the database is asked again.
 *
 * The number is a backstop, not the correctness mechanism: `apps/api` is the ONLY writer of
 * `extension`, `device_line` and `org_setting`, every one of those writes goes through
 * `PbxRepository`, and `pbx.module.ts` hangs {@link SipCredentialCache.invalidateOrganization} off
 * its `onMutation` seam — so a rotation, a disable or a delete evicts the entry in the same tick it
 * commits. The TTL only bounds how long a change made AROUND the API (a psql session, a restore)
 * can be believed, which is the same exposure `routing-cache` already accepts.
 */
const POSITIVE_TTL_MS = 60_000;

/**
 * And how long a REFUSAL is reused. Much shorter, and deliberately asymmetric.
 *
 * A negative entry is keyed by an identifier an attacker chooses, so its TTL decides how long one
 * spray keeps a slot in a bounded map; and the operator-facing cost of getting it wrong is the one
 * that hurts — an extension created a moment ago must register on the next attempt, not a minute
 * later. Five seconds still collapses a thousand-phone cold start's worth of duplicate misses into
 * one query per account while staying under a phone's REGISTER retry.
 */
const NEGATIVE_TTL_MS = 5_000;

/**
 * The realm → organization directory's TTL, and why it is its own number.
 *
 * `resolveOrganizationForRealm` is the ONE query every lookup makes before it knows whose tenant it
 * is, so it is the query that cannot be avoided by any per-account key. It is also the most stable
 * fact in the path — a deployment's SIP realm changes when somebody migrates a domain, not when a
 * phone is provisioned — and its write goes through the same `org_setting` mutation seam, so it is
 * evicted exactly.
 */
const REALM_TTL_MS = 300_000;

/**
 * The cap, in entries, on each of the two maps.
 *
 * A thousand-phone fleet needs a thousand positive entries. The remaining headroom is for the
 * negative ones, whose key space is chosen by whoever is sending REGISTERs — which is why there is
 * a cap at all rather than a TTL sweep alone: a sweep bounds age, and age is not what an attacker
 * spends. Eviction is oldest-insertion-first, which a `Map` gives for nothing, and a hit re-inserts
 * so the set that survives pressure is the set actually registering.
 */
const MAX_ENTRIES = 20_000;

interface CachedCredential {
	readonly response: SipCredentialResponse;
	readonly organizationId: string;
	expiresAt: number;
}

interface CachedRealm {
	readonly organizationId: string | undefined;
	expiresAt: number;
}

export interface SipCredentialCacheStats {
	readonly hits: number;
	readonly misses: number;
	readonly evicted: number;
	readonly invalidated: number;
	readonly size: number;
	readonly realms: number;
}

/**
 * The in-process credential read cache — the thing that decides how many phones this API can
 * authenticate per second.
 *
 * ## What it is for, measured
 *
 * Uncached, one `rpc.sip.v1.credential` answer is **three transactions and eleven round trips** to
 * PostgreSQL: the untenanted realm lookup, then `begin / set local role / set_config / select
 * device_line ⋈ extension / commit`, then the same five again for the shared-line appearance. At
 * ~60 ms each and `MAX_IN_FLIGHT = 32` in the responder, that is 32 ÷ 0.06 ≈ **510 answers/s**,
 * flat from 400 concurrent upward — which is exactly the ceiling `E2E-load.md` measured. The api's
 * Node thread was 90 % IDLE while it happened, so the ceiling was never CPU and never the pool
 * (5 of 10 backends): it was eleven serialized waits per answer.
 *
 * A fleet does not make those eleven waits produce different answers. One thousand phones on a 60 s
 * expiry re-register every ~30 s against credentials that changed zero times, and every one of
 * those refreshes was a fresh eleven.
 *
 * ## Why an in-process map and not a shared cache
 *
 * The value is a digest of a secret. Putting it in Redis would move an HA1 out of the process that
 * derives it and onto a wire and a disk, for a hit rate that a per-replica map already gets — the
 * key space is the fleet, and every replica sees every account through the queue group anyway. The
 * cost of N replicas holding N copies is N cold starts, which is one query each.
 *
 * ## Invalidation is exact, so the TTL is a backstop
 *
 * See {@link POSITIVE_TTL_MS}. The one thing this class must never do is outlive a disable: an
 * account switched off must stop authenticating, and "in up to a minute" is not an answer a
 * security control gets to give. `invalidateOrganization` is called from the repository's mutation
 * seam for every table that can change an answer here, so the eviction happens on the commit, and
 * the minute is only what a change made outside the API costs.
 *
 * ## What is NOT cached
 *
 * Failures that are not answers about an account: a missing `PROVISION_SIP_SECRET_KEY`, a database
 * error, a malformed request. Caching those would turn a transient fault into a minute of refusals
 * for a fleet, which is the failure mode `E2E-load.md` reported at the other end of this RPC.
 */
@Injectable()
export class SipCredentialCache {
	private readonly entries = new Map<string, CachedCredential>();
	private readonly byOrganization = new Map<string, Set<string>>();
	private readonly realms = new Map<string, CachedRealm>();
	private hits = 0;
	private misses = 0;
	private evicted = 0;
	private invalidatedCount = 0;
	/**
	 * Injected so a spec can pin the clock. `Date.now` and not a `Clock` abstraction: two TTLs and
	 * an eviction bound do not need an interface, and the alternative is a fake timer in every test
	 * that only wanted to assert a hit.
	 */
	private now: () => number = Date.now;
	private announce: ((organizationId: string, reason: string, dropped: number) => void) | undefined;

	/** Test seam. Nothing in the application calls this. */
	setClock(now: () => number): void {
		this.now = now;
	}

	get stats(): SipCredentialCacheStats {
		return {
			hits: this.hits,
			misses: this.misses,
			evicted: this.evicted,
			invalidated: this.invalidatedCount,
			size: this.entries.size,
			realms: this.realms.size,
		};
	}

	/**
	 * The organization a realm maps to, `undefined` for "not cached", and a cached
	 * `{ organizationId: undefined }` for "cached, and the answer is that nothing maps to it".
	 *
	 * The three-state return is why this is not a plain `get`: an unmapped realm is the most common
	 * thing a misconfigured edge asks about, and re-running the untenanted `org_setting` scan for
	 * every one of those is the query this class exists to remove.
	 */
	lookupRealm(realm: string): CachedRealm | undefined {
		const cached = this.realms.get(realm);
		if (cached === undefined) {
			return undefined;
		}
		if (cached.expiresAt <= this.now()) {
			this.realms.delete(realm);
			return undefined;
		}
		return cached;
	}

	rememberRealm(realm: string, organizationId: string | undefined): void {
		if (this.realms.size >= MAX_ENTRIES && !this.realms.has(realm)) {
			this.evictOldest(this.realms);
		}
		this.realms.set(realm, {
			organizationId,
			// An unmapped realm is a deployment mistake somebody is in the middle of fixing, so it is
			// held on the negative TTL — the operator who has just written the `sip/realm` setting
			// through some other path should see phones register in seconds, not in five minutes.
			expiresAt: this.now() + (organizationId === undefined ? NEGATIVE_TTL_MS : REALM_TTL_MS),
		});
	}

	/** The cached answer for one account, or `undefined` on a miss or an expiry. */
	lookup(
		organizationId: string,
		realm: string,
		username: string,
	): SipCredentialResponse | undefined {
		const key = cacheKey(organizationId, realm, username);
		const cached = this.entries.get(key);
		if (cached === undefined) {
			this.misses += 1;
			return undefined;
		}
		if (cached.expiresAt <= this.now()) {
			this.remove(key, cached.organizationId);
			this.misses += 1;
			return undefined;
		}
		// Re-insert so the map's insertion order is a recency order and eviction sheds the accounts
		// nothing is registering rather than the ones that are.
		this.entries.delete(key);
		this.entries.set(key, cached);
		this.hits += 1;
		return cached.response;
	}

	/**
	 * Files an answer.
	 *
	 * `found: false` (no such account) takes the short TTL; a found account — enabled or disabled —
	 * takes the long one, because both of those are facts about a row this API owns and evicts on
	 * write.
	 */
	remember(
		organizationId: string,
		realm: string,
		username: string,
		response: SipCredentialResponse,
	): void {
		const key = cacheKey(organizationId, realm, username);
		if (this.entries.size >= MAX_ENTRIES && !this.entries.has(key)) {
			const oldest = this.entries.keys().next();
			if (!oldest.done) {
				const victim = this.entries.get(oldest.value);
				this.remove(oldest.value, victim?.organizationId);
				this.evicted += 1;
			}
		}
		this.entries.set(key, {
			response,
			organizationId,
			expiresAt: this.now() + (response.found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
		});
		let keys = this.byOrganization.get(organizationId);
		if (keys === undefined) {
			keys = new Set<string>();
			this.byOrganization.set(organizationId, keys);
		}
		keys.add(key);
	}

	/**
	 * Drops everything held for one tenant. Called from the repository's mutation seam, so it runs
	 * on the commit of every write that could change an answer here.
	 *
	 * Whole-organization and not per-account, because the seam reports a TABLE and an organization
	 * rather than a row identity, and because the two are not the same key space anyway: a
	 * `device_line.auth_user` edit changes which USERNAME an extension answers to, so the entry that
	 * has to go is the one under the OLD name — which the new row does not know. A tenant's worth of
	 * entries is a few thousand map deletes on a path that runs when a human clicks save.
	 *
	 * Returns the number of entries dropped, so the caller can decide whether an invalidation is
	 * worth telling the SIP edge about.
	 */
	invalidateOrganization(organizationId: string): number {
		const keys = this.byOrganization.get(organizationId);
		if (keys === undefined) {
			return 0;
		}
		for (const key of keys) {
			this.entries.delete(key);
		}
		this.byOrganization.delete(organizationId);
		this.invalidatedCount += keys.size;
		return keys.size;
	}

	/**
	 * Drops the realm → organization directory as well as the tenant's entries.
	 *
	 * A realm change is the one mutation that invalidates a mapping the cache holds under a key
	 * belonging to NO tenant: the old realm string still points at this organization. Evicting only
	 * the organization's credentials would leave the directory answering the previous domain.
	 */
	invalidateRealmDirectory(organizationId: string): number {
		this.realms.clear();
		return this.invalidateOrganization(organizationId);
	}

	/**
	 * The one entry point the repository's mutation seam calls: evict, then tell the SIP edge.
	 *
	 * The eviction is synchronous and happens whatever the announcement does, which is the ordering
	 * that matters — this API's own answer must be correct on the commit, and the edge's copy is a
	 * best-effort improvement on a TTL it already has.
	 */
	invalidate(
		organizationId: string,
		reason: string,
		options?: { readonly realmDirectory?: boolean },
	): number {
		const dropped =
			options?.realmDirectory === true
				? this.invalidateRealmDirectory(organizationId)
				: this.invalidateOrganization(organizationId);
		this.announce?.(organizationId, reason, dropped);
		return dropped;
	}

	/**
	 * Installs the `sip.cred.v1.<orgId>.invalidated` publisher.
	 *
	 * Registered by {@link SipCredentialsResponder} rather than injected, because the responder owns
	 * the only raw NATS connection this area has and a second one to publish a message that fires
	 * when somebody clicks save would be a socket for nothing. A deployment with no `NATS_URL` never
	 * registers one, and every call above degrades to the eviction alone.
	 */
	setAnnouncer(announce: (organizationId: string, reason: string, dropped: number) => void): void {
		this.announce = announce;
	}

	/** Everything. The shutdown/test path; nothing on a request path calls it. */
	clear(): void {
		this.entries.clear();
		this.byOrganization.clear();
		this.realms.clear();
	}

	private remove(key: string, organizationId: string | undefined): void {
		this.entries.delete(key);
		if (organizationId === undefined) {
			return;
		}
		const keys = this.byOrganization.get(organizationId);
		if (keys === undefined) {
			return;
		}
		keys.delete(key);
		if (keys.size === 0) {
			this.byOrganization.delete(organizationId);
		}
	}

	private evictOldest(map: Map<string, unknown>): void {
		const oldest = map.keys().next();
		if (!oldest.done) {
			map.delete(oldest.value);
			this.evicted += 1;
		}
	}
}

/**
 * `\u0000` and not `:` as the separator.
 *
 * A realm is a domain and a username is an operator-chosen auth id; both can contain a colon, and a
 * separator that either side can produce is a key collision between two different tenants' accounts.
 * A NUL cannot appear in either — PostgreSQL `text` refuses it outright.
 */
function cacheKey(organizationId: string, realm: string, username: string): string {
	return `${organizationId}\u0000${realm}\u0000${username}`;
}

/**
 * The tables whose mutation can change an answer this cache holds.
 *
 * Shaped like `QUEUE_MEMBERSHIP_TABLES` and `TRUNK_DIRECTORY_TABLES` in
 * `shared/projection-outbox.ts`, deliberately: one list per consumer of the mutation seam is what
 * keeps the seam readable as one mechanism, and a list is what makes an omission a one-line fix.
 *
 * Each name earns its place:
 *
 * - `extension` — `sip_secret_ref` (rotation), `enabled` (disable), `number` (the softphone auth
 *   user), `sip_password_ha1` and `max_registrations` are all read by `findExtension`.
 * - `device_line` — `auth_user` decides WHICH username an extension answers to, and the line's own
 *   `sip_secret_ref` and `enabled` are the device half of the same answer.
 * - `device` — deleting one cascades its lines away, and the cascade is not a `device_line`
 *   mutation the seam ever reports.
 * - `shared_line` / `shared_line_appearance` — the `sharedLineNumber` and `appearanceIndex` the
 *   reply carries. They change no credential, so a stale one lights the wrong lamp rather than
 *   authenticating the wrong phone; it is still a wrong answer this cache would otherwise hold for
 *   a minute.
 * - `org_setting` — the realm directory, below.
 *
 * `trunk` is NOT here. Carrier credentials are `TrunkCredentialsService`, which reads the KV
 * directory and never this cache.
 */
const SIP_CREDENTIAL_TABLES: readonly string[] = [
	"extension",
	"device",
	"device_line",
	"shared_line",
	"shared_line_appearance",
	"org_setting",
];

export function affectsSipCredentials(tableName: string): boolean {
	return SIP_CREDENTIAL_TABLES.includes(tableName);
}

/**
 * Whether a mutation can move the realm → organization directory.
 *
 * `org_setting` and not "the row whose name is `realm`", because the seam reports a TABLE: it does
 * not carry which setting was written, and the alternative to being coarse here is re-reading the
 * row to find out. An org-setting write is an administrator action, the cost of being coarse is
 * that the next lookup in ANY tenant re-runs one indexed `org_setting` scan, and the cost of being
 * wrong is that a migrated SIP domain keeps resolving to the old tenant for five minutes.
 */
export function changesTheSipRealm(tableName: string): boolean {
	return tableName === "org_setting";
}
