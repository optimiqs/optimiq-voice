import { Inject, Injectable } from "@nestjs/common";
import { readHierarchy } from "@optimiq-voice/db";
import { AUTH_PLATFORM } from "./auth.tokens";
import type { AuthPlatform } from "./auth.platform";

/**
 * How long a suspension verdict is trusted before it is re-read.
 *
 * Suspension is a billing action, not a security incident, so a bounded staleness is the right
 * trade against one extra control-plane read on every authorized request. Fifteen seconds is short
 * enough that an operator who suspends a tenant sees it take effect while they are still watching,
 * and long enough that a busy dashboard costs one query rather than hundreds.
 */
const SUSPENSION_TTL_MS = 15_000;

/**
 * How many organizations may be remembered before the cache is swept.
 *
 * A `Map` that only ever grows is a leak with a slow fuse; sweeping on write means the cost is paid
 * by the traffic that caused it and no interval keeps the process alive at shutdown.
 */
const SWEEP_THRESHOLD = 4_096;

interface Entry {
	readonly suspended: boolean;
	readonly expiresAt: number;
}

/**
 * Whether an organization is suspended, cached briefly.
 *
 * `ResellerService.setSuspended` can suspend a child organization for non-payment, but nothing on
 * the request path consulted `organization_hierarchy.suspendedAt` — so a suspended tenant's
 * sessions, and in particular its `x-api-key` integrations, kept full access to every PBX and CDR
 * resource. The guard now asks here for every principal, which is why the answer is cached: the
 * check has to be on the hot path to mean anything, and an uncached hierarchy read on every
 * authorized request would be a real cost for a value that changes about once a quarter.
 */
@Injectable()
export class OrganizationSuspensionService {
	private readonly cache = new Map<string, Entry>();

	constructor(@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform) {}

	async isSuspended(organizationId: string, now: number = Date.now()): Promise<boolean> {
		const cached = this.cache.get(organizationId);
		if (cached !== undefined && cached.expiresAt > now) {
			return cached.suspended;
		}

		const hierarchy = await readHierarchy(this.platform.database.adminDb, organizationId);
		// No hierarchy row is a top-level organization that was never placed under a reseller. It has
		// nothing that can suspend it, so it is not suspended.
		const suspended = hierarchy?.suspendedAt != null;

		if (this.cache.size >= SWEEP_THRESHOLD) {
			this.sweep(now);
		}
		this.cache.set(organizationId, { suspended, expiresAt: now + SUSPENSION_TTL_MS });
		return suspended;
	}

	/** Test seam, and what `ResellerService` would call to make a suspension take effect at once. */
	forget(organizationId?: string): void {
		if (organizationId === undefined) {
			this.cache.clear();
			return;
		}
		this.cache.delete(organizationId);
	}

	private sweep(now: number): void {
		for (const [key, entry] of this.cache) {
			if (entry.expiresAt <= now) {
				this.cache.delete(key);
			}
		}
	}
}
