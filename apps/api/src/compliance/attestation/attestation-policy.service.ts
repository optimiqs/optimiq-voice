import { Inject, Injectable } from "@nestjs/common";
import {
	and,
	eq,
	gt,
	isNull,
	or,
	orgSetting,
	organizationKyc,
	phoneNumber,
	verifiedCallerId,
} from "@optimiq-voice/pbx-db";
import { attestationKey, isUnverifiedCallerIdPolicy } from "@optimiq-voice/routing";
import { COMPLIANCE_SETTINGS_CATEGORY } from "../../pbx/org-settings/org-settings.catalog";
import { PBX_DATABASE } from "../../pbx/shared/pbx.tokens";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";
import type { CallerIdRightToUse, CompiledAttestationPolicy } from "@optimiq-voice/routing";

/**
 * How long a compiled policy is trusted, in milliseconds.
 *
 * Thirty seconds, which is short even by this platform's cache standards, and the reason is the
 * direction of the errors. A stale policy that is too PERMISSIVE presents a caller id the tenant no
 * longer has a right to — a compliance failure that is invisible until a traceback — and one that is
 * too restrictive attests `C` on a call that should have been `A`, which downgrades a customer's
 * delivery. Both are bad enough that the cache exists only to keep a burst of outbound legs from
 * running four queries each, not to keep the answer for any length of time. Every WRITE that can
 * change the answer also calls {@link AttestationPolicyService.invalidate}, so the TTL is the
 * backstop for the paths that cannot (a `phone_number` write in the numbers slice, a KYC decision
 * from the platform queue), not the primary mechanism.
 */
const POLICY_TTL_MS = 30_000;

/**
 * The most organizations whose policy is held at once.
 *
 * Copied from `webhook-dispatcher.service.ts`'s `CACHE_MAX_ORGANIZATIONS` deliberately, cap and
 * eviction shape included: a Map iterates in insertion order, every HIT re-inserts, so deleting from
 * the front evicts least-recently-USED rather than least-recently-filled. An unbounded map keyed on
 * a tenant id is a memory leak on a platform whose tenant count is not bounded by anything this
 * process controls.
 */
const CACHE_MAX_ORGANIZATIONS = 1_000;

interface CacheEntry {
	readonly policy: CompiledAttestationPolicy;
	readonly readAt: number;
}

/**
 * Compiles one organization's attestation policy — who they are, and what they may present.
 *
 * ## What "compiled" means here, and why it is four reads rather than a join
 *
 * `CompiledAttestationPolicy` is the input `decideAttestation` takes: a right-to-use table, the
 * policy for a caller id that is not in it, and the two KYC facts. Building it needs the tenant's
 * enabled DIDs, its non-expired verified caller ids, two org settings and the KYC decision — four
 * tables in one database, read inside one tenant scope. They are four statements rather than one
 * join because three of them are tiny and the fourth (`phone_number`) is the only one with any size,
 * and a four-way join would make the query plan depend on which tenant asked.
 *
 * ## Owned beats verified, always, and the order of the two loops is the whole rule
 *
 * A number the tenant OWNS on this platform is attested `A`: we assigned it, we know it is theirs,
 * and no piece of paper can make that less true. A verified number is `B`: somebody presented
 * evidence and somebody accepted it. When a number is both — a DID that was also filed as a verified
 * caller id, which happens when a customer ports a number they had previously LOA'd — `A` is the
 * honest answer. The owned map is therefore written LAST so it overwrites, and this ordering must
 * stay identical to the routing compiler's, which builds the same table from the same two inputs;
 * a divergence would mean the engine and the CDR ledger disagreeing about the same call.
 *
 * ## An EXPIRED verification confers nothing
 *
 * The predicate is `expires_at is null or expires_at > now()`, evaluated in the DATABASE rather than
 * in this process, so a long-lived cache entry cannot be the thing that keeps an expired
 * authorisation alive — and so the answer does not depend on this process's clock.
 */
@Injectable()
export class AttestationPolicyService {
	private readonly cache = new Map<string, CacheEntry>();

	constructor(@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient) {}

	/** Forgets a tenant's compiled policy, or all of them. The seam every compliance write calls. */
	invalidate(organizationId?: string): void {
		if (organizationId === undefined) {
			this.cache.clear();
			return;
		}
		this.cache.delete(organizationId);
	}

	/** How many policies are held. For a spec and for a metric, not for a decision. */
	get size(): number {
		return this.cache.size;
	}

	async policyFor(organizationId: string): Promise<CompiledAttestationPolicy> {
		const cached = this.cache.get(organizationId);
		const now = Date.now();
		if (cached !== undefined) {
			if (now - cached.readAt < POLICY_TTL_MS) {
				// Re-inserting moves the key to the end of the Map's insertion order, which is what makes
				// the eviction below least-recently-USED rather than least-recently-filled.
				this.cache.delete(organizationId);
				this.cache.set(organizationId, cached);
				return cached.policy;
			}
			this.cache.delete(organizationId);
		}

		const policy = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await compilePolicy(transaction, organizationId),
		);
		this.cache.set(organizationId, { policy, readAt: now });
		// Oldest first, because a Map iterates in insertion order and every hit above re-inserts.
		while (this.cache.size > CACHE_MAX_ORGANIZATIONS) {
			const oldest = this.cache.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.cache.delete(oldest.value);
		}
		return policy;
	}
}

/**
 * The right-to-use table, as a pure function of the two row sets.
 *
 * Separated from the queries so the precedence rule — the one thing here that can be wrong in a way
 * nobody notices — is testable without a database. Keys are `attestationKey()`'s normal form, so a
 * number stored as `+1 (212) 555-0100` and one presented as `12125550100` are the same entry.
 */
export function buildRightToUse(
	owned: readonly { readonly e164: string }[],
	verified: readonly { readonly e164: string }[],
): Record<string, CallerIdRightToUse> {
	const table: Record<string, CallerIdRightToUse> = {};
	for (const row of verified) {
		const key = attestationKey(row.e164);
		if (key.length > 0) {
			table[key] = "verified";
		}
	}
	// Second, so owned overwrites verified on a collision. See the class header.
	for (const row of owned) {
		const key = attestationKey(row.e164);
		if (key.length > 0) {
			table[key] = "owned";
		}
	}
	return table;
}

/** The four reads, inside a tenant scope the caller opened. */
async function compilePolicy(
	transaction: PbxDatabaseTransaction,
	organizationId: string,
): Promise<CompiledAttestationPolicy> {
	const owned = await transaction
		.select({ e164: phoneNumber.e164 })
		.from(phoneNumber)
		.where(and(eq(phoneNumber.organizationId, organizationId), eq(phoneNumber.enabled, true)));

	const verified = await transaction
		.select({ e164: verifiedCallerId.e164 })
		.from(verifiedCallerId)
		.where(
			and(
				eq(verifiedCallerId.organizationId, organizationId),
				or(isNull(verifiedCallerId.expiresAt), gt(verifiedCallerId.expiresAt, new Date())),
			),
		);

	const kyc = await transaction
		.select({ decision: organizationKyc.decision })
		.from(organizationKyc)
		.where(eq(organizationKyc.organizationId, organizationId))
		.limit(1);

	const settings = await transaction
		.select({ name: orgSetting.name, value: orgSetting.value, enabled: orgSetting.enabled })
		.from(orgSetting)
		.where(
			and(
				eq(orgSetting.organizationId, organizationId),
				eq(orgSetting.category, COMPLIANCE_SETTINGS_CATEGORY),
			),
		);

	return {
		rightToUse: buildRightToUse(owned, verified),
		unverifiedCallerIdPolicy: readUnverifiedPolicy(settings),
		kycApproved: kyc[0]?.decision === "approved",
		kycRequiredForOutbound: readRequireKyc(settings),
	};
}

/** The cascade's "a disabled row is absent" rule, applied to the two settings this policy reads. */
function settingValue(
	rows: readonly { readonly name: string; readonly value: unknown; readonly enabled: boolean }[],
	name: string,
): unknown {
	return rows.find((row) => row.enabled && row.name === name)?.value;
}

function readUnverifiedPolicy(
	rows: readonly { readonly name: string; readonly value: unknown; readonly enabled: boolean }[],
) {
	const value = settingValue(rows, "unverifiedCallerIdPolicy");
	// Falls back to the catalogue default rather than throwing: a row that no longer satisfies its
	// schema degrades to the platform answer, which is what `resolveCategory` does one layer up.
	return isUnverifiedCallerIdPolicy(value) ? value : ("allow" as const);
}

function readRequireKyc(
	rows: readonly { readonly name: string; readonly value: unknown; readonly enabled: boolean }[],
): boolean {
	return settingValue(rows, "requireKycForOutbound") === true;
}
