import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import {
	count,
	eq,
	extension,
	orgLimit,
	prompt,
	trunk,
	voicemailMessage,
} from "@optimiq-voice/pbx-db";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { assertWithinLimit, usageEntry } from "./org-limits";
import type { OrgLimitName, OrgLimits, OrgUsageReport } from "./org-limits";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The quota reader, the enforcement gate and the usage report.
 *
 * ## Why enforcement is a read-then-create and not part of the write transaction
 *
 * The honest version is a `select count(*) … for update` inside the insert's transaction, and it is
 * not what this does. The reason is that the insert happens inside the SHARED repository — one
 * `Context.Service` that turns any `PbxResource` declaration into Drizzle — and threading a
 * per-resource precondition through it would either widen the descriptor with a "count this table
 * first" concept that two of thirty resources use, or fork the write path for those two. Both are a
 * larger change to the load-bearing part of this area than a quota justifies.
 *
 * What the read-then-create costs is a race: two creates that both read 49 of 50 both pass, and the
 * organization lands at 51. That is a quota overshoot of one per concurrent request, self-correcting
 * (the next create is refused), and visible in the usage report. It is the same class of
 * approximation `TrunkCapacityRegistry` documents for the per-trunk channel ceiling, and it is
 * acceptable for the same reason: a limit is a commercial boundary, not a safety one.
 *
 * The seam if it ever needs to be exact is named: a `preconditions` field on `PbxResource` carrying
 * a `(transaction, organizationId) => Promise<void>`, run by the repository between the destination
 * guards and the insert.
 *
 * ## Storage is a row-sum, not an object-store walk
 *
 * `maxStorageMb` is measured by summing `prompt.size_bytes` and `voicemail_message.size_bytes`
 * rather than by asking the object store. The store has no cheap per-tenant total — S3's answer is a
 * paginated LIST over every key with a prefix — and the rows are written by the same code that
 * writes the objects, so they agree except for orphans the purge sweeper is already responsible for.
 * A sum over an indexed column is milliseconds; the alternative is a request that gets slower as the
 * tenant grows, on a screen somebody opens to find out why they cannot upload.
 *
 * Recordings are deliberately NOT counted: they live in the CDR database, which is a different
 * connection and a different bounded context, and reaching across for a number would make this
 * endpoint fail whenever that database is slow. Named as a gap rather than half-counted — a total
 * that silently excludes the largest category would be worse than one that says what it covers.
 */
@Injectable()
export class OrgLimitsService {
	constructor(@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient) {}

	protected organizationId(session: AppSession): string {
		return requireActiveOrganizationId(session);
	}

	/** The organization's limits. An absent row is an empty set of them, which is unlimited. */
	async limitsFor(organizationId: string): Promise<OrgLimits> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction.select().from(orgLimit).limit(1);
			const row = rows[0];
			return row === undefined
				? {}
				: {
						maxExtensions: row.maxExtensions,
						maxTrunks: row.maxTrunks,
						maxConcurrentCalls: row.maxConcurrentCalls,
						maxStorageMb: row.maxStorageMb,
					};
		});
	}

	async read(session: AppSession): Promise<{ readonly data: OrgLimits }> {
		return { data: await this.limitsFor(this.organizationId(session)) };
	}

	/**
	 * Sets the organization's limits, creating the row if it has none.
	 *
	 * An upsert rather than a create/update pair, because there is exactly one row per organization
	 * and asking a caller to know whether it exists yet is asking them to model a detail of this
	 * table. `null` clears a limit, which is how a ceiling is removed.
	 */
	async write(session: AppSession, values: OrgLimits): Promise<{ readonly data: OrgLimits }> {
		const organizationId = this.organizationId(session);
		await this.database.withTenantScope(organizationId, async (transaction) => {
			const existing = await transaction.select({ id: orgLimit.id }).from(orgLimit).limit(1);
			const row = existing[0];
			if (row === undefined) {
				await transaction.insert(orgLimit).values({ organizationId, ...values } as never);
				return;
			}
			await transaction
				.update(orgLimit)
				.set(values as never)
				.where(eq(orgLimit.id, row.id));
		});
		return { data: await this.limitsFor(organizationId) };
	}

	/**
	 * Refuses a create that would exceed a quota.
	 *
	 * Called by the two services whose tables are counted. A no-op when the organization has no row
	 * or no ceiling on that axis, which is every tenant until somebody sets one.
	 */
	async assertMayCreate(session: AppSession, limit: OrgLimitName): Promise<void> {
		const organizationId = this.organizationId(session);
		const limits = await this.limitsFor(organizationId);
		const ceiling = limits[limit];
		if (ceiling === null || ceiling === undefined) {
			return;
		}
		assertWithinLimit(limit, ceiling, await this.countFor(organizationId, limit));
	}

	/** Counts and limits together, for the usage screen. */
	async usage(session: AppSession): Promise<OrgUsageReport> {
		const organizationId = this.organizationId(session);
		const limits = await this.limitsFor(organizationId);
		const [extensions, trunks, storageBytes] = await Promise.all([
			this.countFor(organizationId, "maxExtensions"),
			this.countFor(organizationId, "maxTrunks"),
			this.storageBytesFor(organizationId),
		]);
		return {
			entries: [
				usageEntry("maxExtensions", extensions, limits.maxExtensions),
				usageEntry("maxTrunks", trunks, limits.maxTrunks),
				// Not measurable from the control plane: simultaneous calls are live state the engine
				// holds, and a number this endpoint invented would be wrong the moment it was read.
				// Reported as zero-used with its ceiling so the screen can still show the ceiling, which
				// is the fact an administrator came for.
				usageEntry("maxConcurrentCalls", 0, limits.maxConcurrentCalls),
				// The comparison DIVIDES rather than multiplying, so the rounding always goes the
				// tenant's way: nobody is refused for a fraction of a megabyte.
				usageEntry("maxStorageMb", Math.floor(storageBytes / 1_048_576), limits.maxStorageMb),
			],
			storageBytes,
		};
	}

	private async countFor(organizationId: string, limit: OrgLimitName): Promise<number> {
		if (limit !== "maxExtensions" && limit !== "maxTrunks") {
			return 0;
		}
		const table = limit === "maxExtensions" ? extension : trunk;
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction.select({ total: count() }).from(table);
			return Number(rows[0]?.total ?? 0);
		});
	}

	private async storageBytesFor(organizationId: string): Promise<number> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const [prompts, messages] = await Promise.all([
				transaction.select({ bytes: prompt.sizeBytes }).from(prompt),
				transaction.select({ bytes: voicemailMessage.sizeBytes }).from(voicemailMessage),
			]);
			const sum = (rows: readonly { bytes: number | null }[]) =>
				rows.reduce((total, row) => total + (row.bytes ?? 0), 0);
			return sum(prompts) + sum(messages);
		});
	}
}
