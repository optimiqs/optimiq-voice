import { getLogger } from "@optimiq-voice/logging";
import type { RecordingRetentionPolicy } from "../../cdr/recordings/retention-policy";
import type { OrgSettingsService } from "./org-settings.service";

const logger = getLogger("api.pbx");

/**
 * How long one organization's answer is trusted before `org_setting` is asked again.
 *
 * Sixty seconds, and the number is an argument rather than a shrug. The quantity being cached is
 * a retention WINDOW measured in days (bounded at ten years), stamped onto rows at write time; a
 * stale read therefore mis-stamps at most one minute's worth of one tenant's recordings, by a
 * policy that tenant held a minute ago — noise against the thing being governed, and exactly the
 * class of skew the write-time-stamping design already accepts (`cdr-env.ts`: the moment the
 * policy is unambiguous is the write, not the sweep). Meanwhile the cost side is the whole reason
 * the port exists: both record events of every call pass through `retentionDaysFor`, and sixty
 * seconds turns "a cross-database query per recording" into "one query per active tenant per
 * minute", which is the budget the CDR module's self-containment objection demanded. Shorter
 * buys nothing a tenant can perceive; much longer starts to make the settings screen look broken
 * ("I saved 30 days and the next recording ignored it").
 */
const RETENTION_CACHE_TTL_MS = 60_000;

interface CacheEntry {
	readonly value: number | undefined;
	readonly expiresAt: number;
}

/**
 * The PBX side of {@link RecordingRetentionPolicy} — the seam that carries a tenant's
 * `recordings.retentionDays` setting into the CDR area without a cross-database import.
 *
 * Reads through `OrgSettingsService.readRecordingRetentionDays`, which is the existing
 * sessionless `withTenantScope` path (RLS is still the filter), and caches per organization.
 * `undefined` — "this tenant never set a window" — is cached on the same terms as a number,
 * because the tenants that never open the settings screen are most of them and an uncached miss
 * would put the per-recording query right back on the write path for exactly the common case.
 *
 * A read that THROWS is not cached: the caller (`recording-writer.service.ts`) logs and falls
 * back to the platform floor for that recording, and the next call retries — a `pbx-db` outage
 * degrades stamping to the env value visibly rather than freezing a possibly-wrong answer in for
 * a TTL.
 *
 * Constructed by the ports module's factory rather than decorated for DI, so the options bag
 * (clock and TTL) stays a plain test seam instead of an injection token nothing else wants.
 */
export class RecordingRetentionPolicyService implements RecordingRetentionPolicy {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(
		private readonly settings: OrgSettingsService,
		options: { readonly ttlMs?: number; readonly now?: () => number } = {},
	) {
		this.ttlMs = options.ttlMs ?? RETENTION_CACHE_TTL_MS;
		this.now = options.now ?? Date.now;
	}

	async retentionDaysFor(organizationId: string): Promise<number | undefined> {
		const at = this.now();
		const hit = this.cache.get(organizationId);
		if (hit !== undefined && hit.expiresAt > at) {
			return hit.value;
		}
		const value = await this.settings.readRecordingRetentionDays(organizationId);
		this.cache.set(organizationId, { value, expiresAt: at + this.ttlMs });
		if (this.cache.size > MAX_CACHED_ORGANIZATIONS) {
			this.evictExpired(at);
		}
		return value;
	}

	/**
	 * Bounded, lazily: expired entries are dropped when the map grows past a ceiling no realistic
	 * tenant count reaches, so a subject scan (a producer inventing org ids) cannot grow the map
	 * without bound while the normal path never pays for sweeping it.
	 */
	private evictExpired(at: number): void {
		for (const [key, entry] of this.cache) {
			if (entry.expiresAt <= at) {
				this.cache.delete(key);
			}
		}
		if (this.cache.size <= MAX_CACHED_ORGANIZATIONS) {
			return;
		}
		logger.warn(
			{ cached: this.cache.size },
			"the recording retention cache holds more organizations than expected; clearing it",
		);
		this.cache.clear();
	}
}

/** Far above any realistic tenant count; purely a memory-safety valve. */
const MAX_CACHED_ORGANIZATIONS = 10_000;
