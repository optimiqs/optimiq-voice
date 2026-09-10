import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import {
	and,
	eq,
	extension,
	extensionTollFraudOverride,
	orgSetting,
	sql,
	tollFraudCountrySeen,
	tollFraudPolicy,
} from "@optimiq-voice/pbx-db";
import { actorFromSession, insertAuditLog, serviceActor } from "../shared/audit-log";
import { PbxEntityNotFoundFailure } from "../shared/pbx.errors";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { SharedRateWindowService } from "../shared/shared-rate-window";
import { resolveE164Country } from "./e164-country";
import { FraudSignalPublisher } from "./fraud-signal.publisher";
import { evaluateTollFraud, mergeTollFraudPolicy } from "./toll-fraud.policy";
import type { AuditActor } from "../shared/audit-log";
import type {
	SuspendExtensionOutbound,
	WriteExtensionTollFraudOverride,
	WriteTollFraudPolicy,
} from "./toll-fraud.dto";
import type { TollFraudPolicy, TollFraudVerdict } from "./toll-fraud.policy";
import type { AppSession } from "@optimiq-voice/auth";
import type { SecuritySignalKind } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The scope tokens this area meters under in `shared_rate_window`. One place, so the reader and
 * the writer cannot disagree about a string.
 */
export const TOLL_FRAUD_SCOPES = {
	/** Whole minutes of international talk time. Incremented when a leg ends. */
	minutes: "intl-minutes",
	/** International legs currently up. A GAUGE: +1 on answer, -1 on hangup. */
	concurrent: "intl-concurrent",
} as const;

/** An hour and a day, in milliseconds, as the two rolling windows the ceilings are stated against. */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * The gauge's window.
 *
 * A gauge has no natural window and this one is a DAY, which needs saying: the point of the window
 * is not to expire the measurement, it is to bound the damage of a lost decrement. An international
 * leg whose hangup this deployment never saw (a replica restarted mid-call) leaves the gauge one too
 * high forever in a windowless counter, and after enough of them the ceiling is reached with no
 * calls up at all — a fraud control that has silently become an outage. A daily window means the
 * worst case self-corrects at midnight UTC instead of never.
 *
 * The cost is a real one and is accepted: a call spanning the boundary is decremented out of the new
 * window and reads as -1 there, which {@link SharedRateWindowService.consume} floors to zero. One
 * call's worth of slack, once a day, against a gauge that cannot get permanently stuck.
 */
export const GAUGE_WINDOW_MS = DAY_MS;

/**
 * The toll-fraud policy: reading it, writing it, and the gate that enforces it.
 *
 * ## Why the gate lives here and the DECISION does not
 *
 * `toll-fraud.policy.ts` is a pure function with no database in it, because `apps/engine` has to
 * reach the same verdict from the compiled artifact and the shared counter without a database
 * handle. This class is the half that only the control plane can do: resolve the extension, merge
 * the override, read the counters, and — on a refusal — write the audit row and raise the signal.
 *
 * The split is the same one `audit-log.ts` makes between shaping a ledger row and inserting it, and
 * for the same reason: the part that decides has to be testable without a pool, a broker or a
 * session.
 *
 * ## What is NOT enforced here
 *
 * This gate is the control plane's own — `POST /api/v1/calls` and anything else that originates from
 * the API. The engine's dial-time enforcement reads the same policy off the artifact and is not in
 * this file, is not in this app, and is deliberately not called from here: a control plane that had
 * to be consulted per dial would put an HTTP round trip inside every outbound call.
 */
@Injectable()
export class TollFraudService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(SharedRateWindowService) private readonly windows: SharedRateWindowService,
		@Inject(FraudSignalPublisher) private readonly signals: FraudSignalPublisher,
	) {}

	protected organizationId(session: AppSession): string {
		return requireActiveOrganizationId(session);
	}

	/** The organization's policy row, or `undefined` when it has none. Absent means unconstrained. */
	async policyFor(organizationId: string): Promise<TollFraudPolicyRow | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction.select().from(tollFraudPolicy).limit(1);
			return rows[0] as TollFraudPolicyRow | undefined;
		});
	}

	async readPolicy(session: AppSession): Promise<{ readonly data: TollFraudPolicyRow | null }> {
		return { data: (await this.policyFor(this.organizationId(session))) ?? null };
	}

	/**
	 * Sets the organization's policy, creating the row if it has none.
	 *
	 * An upsert rather than a create/update pair, exactly as `OrgLimitsService.write` does and for
	 * the same reason: there is one row per organization, and asking a caller to know whether it
	 * exists yet is asking them to model a detail of this table.
	 *
	 * The ledger row is written INSIDE the transaction rather than after it, which is the rule every
	 * `PbxResourceService` subclass follows automatically and which this class has to follow by hand
	 * because it is not one — a singleton reached without an id does not fit that base. A change to a
	 * fraud ceiling that committed without its ledger row would be exactly the change somebody comes
	 * looking for afterwards.
	 */
	async writePolicy(
		session: AppSession,
		values: WriteTollFraudPolicy,
	): Promise<{ readonly data: TollFraudPolicyRow }> {
		const organizationId = this.organizationId(session);
		const actor = actorFromSession(session);
		await this.database.withTenantScope(organizationId, async (transaction) => {
			const existing = (await transaction.select().from(tollFraudPolicy).limit(1))[0] as
				| TollFraudPolicyRow
				| undefined;
			const patch = policyPatch(values);
			if (existing === undefined) {
				const inserted = await transaction
					.insert(tollFraudPolicy)
					.values({ organizationId, ...patch } as never)
					.returning();
				await this.audit(transaction, organizationId, actor, "toll-fraud-policy.create", {
					before: null,
					after: inserted[0] as Record<string, unknown>,
					ref: (inserted[0] as { id: string } | undefined)?.id ?? null,
				});
				return;
			}
			const updated = await transaction
				.update(tollFraudPolicy)
				.set(patch as never)
				.where(eq(tollFraudPolicy.id, existing.id))
				.returning();
			await this.audit(transaction, organizationId, actor, "toll-fraud-policy.update", {
				before: existing as unknown as Record<string, unknown>,
				after: updated[0] as Record<string, unknown>,
				ref: existing.id,
			});
		});
		const row = await this.policyFor(organizationId);
		// The row was just written inside a committed transaction, so this cannot be absent; the
		// non-null assertion is avoided by refusing rather than by pretending.
		if (row === undefined) {
			throw new PbxEntityNotFoundFailure({ kind: "toll-fraud-policy", id: organizationId });
		}
		return { data: row };
	}

	/**
	 * What the organization is currently metering, against what it may.
	 *
	 * Every number here is MEASURED, unlike `/api/v1/org-limits/usage` where the concurrency line is
	 * a placeholder the response has to flag. The difference is the shared counter: these are rows
	 * this process can read, not live channel state the engines hold. That is the whole argument for
	 * the counter being a table.
	 *
	 * The concurrency gauge is the one to read with care and the response says so through
	 * `concurrentMeasuredFrom`: it is the platform's own count of international legs it saw answer
	 * and has not yet seen end, which is authoritative only for calls this deployment placed.
	 */
	async usage(session: AppSession): Promise<TollFraudUsage> {
		const organizationId = this.organizationId(session);
		const now = new Date();
		const [policy, counters] = await Promise.all([
			this.policyFor(organizationId),
			this.counters(organizationId, organizationId, now),
		]);
		return {
			concurrentInternationalCalls: counters.concurrentInternationalCalls,
			maxConcurrentInternationalCalls: policy?.maxConcurrentInternationalCalls ?? null,
			internationalMinutesLastHour: counters.internationalMinutesLastHour,
			maxInternationalMinutesPerHour: policy?.maxInternationalMinutesPerHour ?? null,
			internationalMinutesLastDay: counters.internationalMinutesLastDay,
			maxInternationalMinutesPerDay: policy?.maxInternationalMinutesPerDay ?? null,
			countriesSeen: [...(await this.seenCountries(organizationId))].sort(),
			concurrentMeasuredFrom: "gauge",
			at: now,
		};
	}

	/** Every per-extension override this organization holds, newest first. */
	async listOverrides(session: AppSession): Promise<{ readonly data: readonly OverrideRow[] }> {
		const organizationId = this.organizationId(session);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction.select().from(extensionTollFraudOverride);
			return { data: rows as OverrideRow[] };
		});
	}

	/**
	 * Sets one extension's override, creating the row if it has none.
	 *
	 * The extension is resolved FIRST and inside the same tenant scope, so an id belonging to another
	 * organization is a 404 rather than a foreign-key violation surfacing as a 500. The composite
	 * foreign key would refuse it anyway — that is what `tenantCompositeForeignKey` is for — but a
	 * database error is not an answer a caller can act on.
	 */
	async writeOverride(
		session: AppSession,
		extensionId: string,
		values: WriteExtensionTollFraudOverride,
	): Promise<{ readonly data: OverrideRow }> {
		const organizationId = this.organizationId(session);
		const actor = actorFromSession(session);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			await this.requireExtension(transaction, extensionId);
			const existing = await this.overrideRow(transaction, extensionId);
			const patch = overridePatch(values);
			const rows =
				existing === undefined
					? await transaction
							.insert(extensionTollFraudOverride)
							.values({ organizationId, extensionId, ...patch } as never)
							.returning()
					: await transaction
							.update(extensionTollFraudOverride)
							.set(patch as never)
							.where(eq(extensionTollFraudOverride.id, existing.id))
							.returning();
			const after = rows[0] as OverrideRow;
			await this.audit(
				transaction,
				organizationId,
				actor,
				existing === undefined
					? "extension-toll-fraud-override.create"
					: "extension-toll-fraud-override.update",
				{
					before: (existing as unknown as Record<string, unknown>) ?? null,
					after: after as unknown as Record<string, unknown>,
					ref: after.id,
					resourceType: "extension_toll_fraud_override",
				},
			);
			return { data: after };
		});
	}

	/**
	 * Suspends or restores one extension's outbound calling.
	 *
	 * Creates the override row when there is none, because a suspension has to be recordable for an
	 * extension nobody has ever set a ceiling on — which is every extension until somebody does. The
	 * row it creates carries NULL in every ceiling, so it inherits exactly as before and changes
	 * nothing except the suspension.
	 */
	async suspendExtension(
		session: AppSession,
		extensionId: string,
		input: SuspendExtensionOutbound,
	): Promise<{ readonly data: OverrideRow }> {
		const organizationId = this.organizationId(session);
		const actor = actorFromSession(session);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			await this.requireExtension(transaction, extensionId);
			const row = await this.applySuspension(transaction, organizationId, extensionId, actor, {
				suspended: input.suspended,
				// A restore clears the reason with the flag: a reason left behind on a live extension
				// reads, on the screen that lists them, as a phone that is still suspended.
				reason: input.suspended ? (input.reason ?? "suspended by an administrator") : null,
			});
			return { data: row };
		});
	}

	/**
	 * The gate: may this extension dial this number right now?
	 *
	 * Returns a verdict rather than throwing, because the two callers want different things from a
	 * refusal — a click-to-call turns it into a 4xx naming the reason, and the detector's auto-suspend
	 * path turns it into an event. Throwing would make the second of those an exception handler.
	 *
	 * On a refusal this writes the audit row and publishes the signal before returning, so a caller
	 * that forgets to do either still leaves a record. It is idempotent in neither direction and does
	 * not need to be: a refused call is not retried by this process.
	 */
	async evaluate(input: TollFraudGateInput): Promise<TollFraudVerdict> {
		const { organizationId, extensionId } = input;
		const policyRow = await this.policyFor(organizationId);
		if (policyRow === undefined) {
			return { allowed: true, international: false };
		}
		const [override, seenCountries, homeCountry] = await Promise.all([
			this.database.withTenantScope(organizationId, (transaction) =>
				this.overrideRow(transaction, extensionId),
			),
			this.seenCountries(organizationId),
			this.homeCountry(organizationId),
		]);
		const merged = mergeTollFraudPolicy(toPolicy(policyRow), override);
		const counters = await this.counters(organizationId, extensionId, input.now);
		const verdict = evaluateTollFraud({
			policy: merged,
			counters,
			dialedE164: input.dialedE164,
			nowUtc: input.now,
			timezone: input.timezone,
			...(homeCountry === undefined ? {} : { homeCountry }),
			seenCountries,
		});
		if (verdict.allowed) {
			return verdict;
		}
		await this.recordRefusal(input, verdict);
		return verdict;
	}

	/**
	 * The counters the ceilings are compared against.
	 *
	 * Read at the ORGANIZATION key rather than the extension's, and that is the conservative reading
	 * of a merged policy: an extension override's ceiling is a departure from the organization's
	 * number, not a separate budget, so an extension with a 60-minute ceiling inside a tenant that
	 * has burnt its hour is refused. The alternative — per-extension counters — would let a tenant
	 * with fifty extensions spend fifty times its own ceiling, which is the arithmetic every
	 * per-endpoint quota gets wrong exactly once.
	 */
	async counters(
		organizationId: string,
		_extensionId: string,
		now: Date,
	): Promise<TollFraudCountersRead> {
		const [concurrent, hour, day] = await Promise.all([
			this.windows.current({
				organizationId,
				scope: TOLL_FRAUD_SCOPES.concurrent,
				key: organizationId,
				windowMs: GAUGE_WINDOW_MS,
				now,
			}),
			this.windows.rolling({
				organizationId,
				scope: TOLL_FRAUD_SCOPES.minutes,
				key: organizationId,
				windowMs: HOUR_MS,
				now,
			}),
			this.windows.rolling({
				organizationId,
				scope: TOLL_FRAUD_SCOPES.minutes,
				key: organizationId,
				windowMs: DAY_MS,
				now,
			}),
		]);
		return {
			concurrentInternationalCalls: concurrent,
			internationalMinutesLastHour: hour,
			internationalMinutesLastDay: day,
		};
	}

	/**
	 * Records a completed international leg: its minutes, and the country it reached.
	 *
	 * Called by whatever observes a leg ending. Minutes are rounded UP per leg, which is how a
	 * carrier bills and therefore the number a spend cap should be counting; a hundred nine-second
	 * calls are a hundred minutes to the carrier and would be one and a half if this rounded the
	 * total instead.
	 *
	 * Both rolling windows are incremented, because they are separate fixed-window counters over the
	 * same events rather than one derived from the other — a day is not twenty-four readable hours,
	 * it is one row.
	 */
	async recordCompletedLeg(input: CompletedLegInput): Promise<void> {
		const minutes = Math.max(1, Math.ceil(input.durationMs / 60_000));
		await Promise.all([
			this.windows.consume({
				organizationId: input.organizationId,
				scope: TOLL_FRAUD_SCOPES.minutes,
				key: input.organizationId,
				windowMs: HOUR_MS,
				increment: minutes,
				now: input.at,
			}),
			this.windows.consume({
				organizationId: input.organizationId,
				scope: TOLL_FRAUD_SCOPES.minutes,
				key: input.organizationId,
				windowMs: DAY_MS,
				increment: minutes,
				now: input.at,
			}),
			this.rememberCountry(input.organizationId, input.dialedE164, input.at),
		]);
	}

	/** The concurrency gauge. `+1` when an international leg answers, `-1` when it ends. */
	async adjustConcurrency(organizationId: string, delta: number, now: Date): Promise<void> {
		await this.windows.consume({
			organizationId,
			scope: TOLL_FRAUD_SCOPES.concurrent,
			key: organizationId,
			windowMs: GAUGE_WINDOW_MS,
			increment: delta,
			now,
		});
	}

	/**
	 * Records that this organization has now been observed calling a country.
	 *
	 * The state behind `holdFirstCallToNewCountry`, and an upsert for the same atomicity reason the
	 * counters are: two legs to a new country landing at once must produce one row, and a
	 * read-then-insert produces two and a unique violation.
	 */
	async rememberCountry(organizationId: string, dialedE164: string, at: Date): Promise<void> {
		const country = resolveE164Country(dialedE164);
		if (country === undefined) {
			// An unresolvable prefix is deliberately never "seen": it is not a country, and recording
			// one would make the next global-network number look familiar.
			return;
		}
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await transaction
				.insert(tollFraudCountrySeen)
				.values({ organizationId, country, firstSeenAt: at, lastSeenAt: at, callCount: 1 } as never)
				.onConflictDoUpdate({
					target: [tollFraudCountrySeen.organizationId, tollFraudCountrySeen.country],
					set: {
						lastSeenAt: at,
						callCount: sql`${tollFraudCountrySeen.callCount} + 1`,
						updatedAt: new Date(),
					},
				});
		});
	}

	/** Every country this organization has been observed calling. */
	async seenCountries(organizationId: string): Promise<ReadonlySet<string>> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ country: tollFraudCountrySeen.country })
				.from(tollFraudCountrySeen);
			return new Set(rows.map((row) => row.country.trim().toUpperCase()));
		});
	}

	/**
	 * Suspends an extension on the platform's own initiative, from the anomaly detector.
	 *
	 * Separate from {@link suspendExtension} because there is no session: the actor is a service, and
	 * writing an administrator's id into the ledger for something the platform decided is how an
	 * audit trail starts attributing machine action to whoever happened to be logged in.
	 */
	async autoSuspend(
		organizationId: string,
		extensionId: string,
		reason: string,
	): Promise<OverrideRow | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const target = await this.extensionRow(transaction, extensionId);
			if (target === undefined) {
				return undefined;
			}
			return await this.applySuspension(
				transaction,
				organizationId,
				extensionId,
				serviceActor("api.fraud-anomaly-detector"),
				{ suspended: true, reason },
			);
		});
	}

	/** Writes the audit row and raises the signal for a refusal. Never throws on the publish. */
	private async recordRefusal(input: TollFraudGateInput, verdict: TollFraudVerdict): Promise<void> {
		if (verdict.allowed) {
			return;
		}
		const summary = refusalSummary(verdict);
		await this.database.withTenantScope(input.organizationId, async (transaction) => {
			await insertAuditLog(transaction, {
				organizationId: input.organizationId,
				actor: input.actor ?? serviceActor("api.toll-fraud"),
				action: "toll-fraud.refused",
				resourceType: "extension",
				resourceRef: input.extensionId,
				before: null,
				after: {
					reason: verdict.reason,
					destination: input.dialedE164,
					...(verdict.country === undefined ? {} : { country: verdict.country }),
					...(verdict.observed === undefined ? {} : { observed: verdict.observed }),
					...(verdict.threshold === undefined ? {} : { threshold: verdict.threshold }),
				},
			});
		});
		logger.warn(
			{
				organizationId: input.organizationId,
				extensionId: input.extensionId,
				reason: verdict.reason,
				country: verdict.country,
			},
			"an outbound call was refused by the toll-fraud gate",
		);
		await this.signals.publish(
			input.organizationId,
			{
				kind: signalKindFor(verdict.reason ?? ""),
				// Every gate refusal is a `warning` and none is `critical`: a refusal is the control
				// WORKING, and paging somebody because a policy did its job is how the pager gets muted.
				// The detector raises `critical`, because a detection is a control noticing something
				// nobody configured a rule for.
				severity: "warning",
				action: "call-refused",
				extensionId: input.extensionId,
				...(input.extensionNumber === undefined ? {} : { extensionNumber: input.extensionNumber }),
				destination: input.dialedE164,
				...(verdict.country === undefined ? {} : { destinationCountry: verdict.country }),
				...(verdict.observed === undefined ? {} : { observed: verdict.observed }),
				...(verdict.threshold === undefined ? {} : { threshold: verdict.threshold }),
				summary,
			},
			input.now,
		);
	}

	private async applySuspension(
		transaction: PbxDatabaseTransaction,
		organizationId: string,
		extensionId: string,
		actor: AuditActor,
		input: { readonly suspended: boolean; readonly reason: string | null },
	): Promise<OverrideRow> {
		const existing = await this.overrideRow(transaction, extensionId);
		const patch = {
			outboundSuspended: input.suspended,
			suspendedReason: input.reason,
			suspendedAt: input.suspended ? new Date() : null,
		};
		const rows =
			existing === undefined
				? await transaction
						.insert(extensionTollFraudOverride)
						.values({ organizationId, extensionId, ...patch } as never)
						.returning()
				: await transaction
						.update(extensionTollFraudOverride)
						.set(patch as never)
						.where(eq(extensionTollFraudOverride.id, existing.id))
						.returning();
		const after = rows[0] as OverrideRow;
		await this.audit(
			transaction,
			organizationId,
			actor,
			input.suspended ? "extension-outbound.suspend" : "extension-outbound.restore",
			{
				before: (existing as unknown as Record<string, unknown>) ?? null,
				after: after as unknown as Record<string, unknown>,
				ref: after.id,
				resourceType: "extension_toll_fraud_override",
			},
		);
		return after;
	}

	private async overrideRow(
		transaction: PbxDatabaseTransaction,
		extensionId: string,
	): Promise<OverrideRow | undefined> {
		const rows = await transaction
			.select()
			.from(extensionTollFraudOverride)
			.where(eq(extensionTollFraudOverride.extensionId, extensionId))
			.limit(1);
		return rows[0] as OverrideRow | undefined;
	}

	private async extensionRow(
		transaction: PbxDatabaseTransaction,
		extensionId: string,
	): Promise<{ readonly id: string; readonly number: string } | undefined> {
		const rows = await transaction
			.select({ id: extension.id, number: extension.number })
			.from(extension)
			.where(eq(extension.id, extensionId))
			.limit(1);
		return rows[0];
	}

	private async requireExtension(
		transaction: PbxDatabaseTransaction,
		extensionId: string,
	): Promise<void> {
		if ((await this.extensionRow(transaction, extensionId)) === undefined) {
			throw new PbxEntityNotFoundFailure({ kind: "extension", id: extensionId });
		}
	}

	/**
	 * The organization's own country, derived from its `defaultCallingCode` setting.
	 *
	 * Derived rather than stored, because a second column saying where the tenant is would be a
	 * second answer to a question `defaultCallingCode` already answers — and the two would disagree
	 * the first time somebody edited one. Absent when the setting is unset, which the decision
	 * function reads as "nothing is domestic": the fail-closed direction, stated at its argument.
	 */
	async homeCountry(organizationId: string): Promise<string | undefined> {
		const code = await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ value: orgSetting.value })
				.from(orgSetting)
				.where(and(eq(orgSetting.category, "routing"), eq(orgSetting.name, "defaultCallingCode")))
				.limit(1);
			const value = rows[0]?.value;
			return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
		});
		return code === undefined ? undefined : resolveE164Country(`+${code.replace(/^\+/u, "")}00000`);
	}

	private async audit(
		transaction: PbxDatabaseTransaction,
		organizationId: string,
		actor: AuditActor,
		action: string,
		change: {
			readonly before: Record<string, unknown> | null;
			readonly after: Record<string, unknown> | null;
			readonly ref: string | null;
			readonly resourceType?: string;
		},
	): Promise<void> {
		await insertAuditLog(transaction, {
			organizationId,
			actor,
			action,
			resourceType: change.resourceType ?? "toll_fraud_policy",
			resourceRef: change.ref,
			before: change.before,
			after: change.after,
		});
	}
}

/** The policy row as the database holds it. */
export interface TollFraudPolicyRow {
	readonly id: string;
	readonly organizationId: string;
	readonly enabled: boolean;
	readonly maxConcurrentInternationalCalls: number | null;
	readonly maxInternationalMinutesPerHour: number | null;
	readonly maxInternationalMinutesPerDay: number | null;
	readonly allowedCountries: readonly string[] | null;
	readonly deniedCountries: readonly string[] | null;
	readonly holdFirstCallToNewCountry: boolean;
	readonly offHoursInternationalLock: boolean;
	readonly offHoursStartMinute: number;
	readonly offHoursEndMinute: number;
	readonly offHoursTimezone: string | null;
	readonly autoSuspendOnSignal: boolean;
}

/** One extension's override row. */
export interface OverrideRow {
	readonly id: string;
	readonly organizationId: string;
	readonly extensionId: string;
	readonly enabled: boolean | null;
	readonly maxConcurrentInternationalCalls: number | null;
	readonly maxInternationalMinutesPerHour: number | null;
	readonly maxInternationalMinutesPerDay: number | null;
	readonly allowedCountries: readonly string[] | null;
	readonly deniedCountries: readonly string[] | null;
	readonly holdFirstCallToNewCountry: boolean | null;
	readonly offHoursInternationalLock: boolean | null;
	readonly outboundSuspended: boolean;
	readonly suspendedReason: string | null;
	readonly suspendedAt: Date | null;
}

/** What the usage screen answers with. `null` on a ceiling means unlimited on that axis. */
export interface TollFraudUsage {
	readonly concurrentInternationalCalls: number;
	readonly maxConcurrentInternationalCalls: number | null;
	readonly internationalMinutesLastHour: number;
	readonly maxInternationalMinutesPerHour: number | null;
	readonly internationalMinutesLastDay: number;
	readonly maxInternationalMinutesPerDay: number | null;
	/** Upper case, sorted. The set `holdFirstCallToNewCountry` compares a destination against. */
	readonly countriesSeen: readonly string[];
	/**
	 * How the concurrency figure was arrived at, so a screen never reads it as a channel census.
	 *
	 * `"gauge"` is the only value today and means: legs this platform saw answer minus legs it saw
	 * end, inside a daily window that bounds a lost decrement. It is authoritative for what this
	 * deployment placed and knows nothing about anything else.
	 */
	readonly concurrentMeasuredFrom: "gauge";
	readonly at: Date;
}

export interface TollFraudCountersRead {
	readonly concurrentInternationalCalls: number;
	readonly internationalMinutesLastHour: number;
	readonly internationalMinutesLastDay: number;
}

export interface TollFraudGateInput {
	readonly organizationId: string;
	readonly extensionId: string;
	readonly extensionNumber?: string | undefined;
	readonly dialedE164: string;
	readonly now: Date;
	/** The organization's IANA zone, for the off-hours window. */
	readonly timezone: string;
	/** The person behind the dial, when there is one. A service actor is used otherwise. */
	readonly actor?: AuditActor | undefined;
}

export interface CompletedLegInput {
	readonly organizationId: string;
	readonly dialedE164: string;
	readonly durationMs: number;
	readonly at: Date;
}

/** The row, as the pure decision function wants it: `null` collapsed to `undefined`. */
export function toPolicy(row: TollFraudPolicyRow): TollFraudPolicy {
	return {
		enabled: row.enabled,
		maxConcurrentInternationalCalls: row.maxConcurrentInternationalCalls ?? undefined,
		maxInternationalMinutesPerHour: row.maxInternationalMinutesPerHour ?? undefined,
		maxInternationalMinutesPerDay: row.maxInternationalMinutesPerDay ?? undefined,
		allowedCountries: row.allowedCountries ?? undefined,
		deniedCountries: row.deniedCountries ?? undefined,
		holdFirstCallToNewCountry: row.holdFirstCallToNewCountry,
		offHoursInternationalLock: row.offHoursInternationalLock,
		offHoursStartMinute: row.offHoursStartMinute,
		offHoursEndMinute: row.offHoursEndMinute,
		offHoursTimezone: row.offHoursTimezone ?? undefined,
	};
}

/**
 * Which signal kind a refusal reason publishes as.
 *
 * A table rather than a lowercase-and-replace, because the two vocabularies are separate contracts
 * that happen to line up today: `TollFraudRefusalReason` is what the caller is told and
 * `SecuritySignalKind` is what a webhook consumer parses, and a mechanical transform would silently
 * invent a kind the schema does not have the day somebody adds a reason.
 */
function signalKindFor(reason: string): SecuritySignalKind {
	switch (reason) {
		case "INTERNATIONAL_CONCURRENCY_EXCEEDED":
			return "international-concurrency-exceeded";
		case "INTERNATIONAL_MINUTES_EXCEEDED":
			return "international-minutes-exceeded";
		case "NEW_COUNTRY_HOLD":
			return "new-country-hold";
		case "OFF_HOURS_INTERNATIONAL_LOCK":
			return "off-hours-international-lock";
		default:
			// `DESTINATION_COUNTRY_BLOCKED` and `EXTENSION_OUTBOUND_SUSPENDED`. The suspension shares
			// the geo kind rather than getting one of its own because the SIGNAL family is about
			// destinations and thresholds, and "this phone is suspended" is already an audit fact with
			// its own action — a second kind for it would be a webhook nobody could act on differently.
			return "destination-country-blocked";
	}
}

/** One sentence for a human, assembled from the verdict alone. */
function refusalSummary(verdict: TollFraudVerdict): string {
	const where = verdict.country === undefined ? "an unresolved destination" : verdict.country;
	switch (verdict.reason) {
		case "DESTINATION_COUNTRY_BLOCKED":
			return `An international call to ${where} was refused: the destination is outside this organization's permitted countries.`;
		case "OFF_HOURS_INTERNATIONAL_LOCK":
			return `An international call to ${where} was refused: international calling is locked outside business hours.`;
		case "NEW_COUNTRY_HOLD":
			return `An international call to ${where} was held: this organization has not called that country before.`;
		case "INTERNATIONAL_CONCURRENCY_EXCEEDED":
			return `An international call to ${where} was refused: ${String(verdict.observed)} simultaneous international calls against a ceiling of ${String(verdict.threshold)}.`;
		case "INTERNATIONAL_MINUTES_EXCEEDED":
			return `An international call to ${where} was refused: ${String(verdict.observed)} international minutes against a ceiling of ${String(verdict.threshold)}.`;
		default:
			return `An outbound call to ${where} was refused: this extension's outbound calling is suspended.`;
	}
}

/**
 * The columns a policy write sets.
 *
 * Absent leaves the column alone; `null` clears a ceiling. The booleans are `notNull` in the schema,
 * so they take a value or are omitted entirely — there is no `null` to write, which is why they are
 * `.optional()` on the DTO and the two nullable-list fields are `.nullish()`.
 */
function policyPatch(values: WriteTollFraudPolicy): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) {
			patch[key] = value;
		}
	}
	return patch;
}

/** The same, for an override — where `null` means INHERIT rather than "no ceiling". */
function overridePatch(values: WriteExtensionTollFraudOverride): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) {
			patch[key] = value;
		}
	}
	return patch;
}
