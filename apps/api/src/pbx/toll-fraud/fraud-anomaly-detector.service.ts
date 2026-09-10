import {
	Inject,
	Injectable,
	Optional,
	type OnApplicationShutdown,
	type OnModuleInit,
} from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { count, eq, extension, gte, sipAuthEvent, sql } from "@optimiq-voice/pbx-db";
import { insertAuditLog, serviceActor } from "../shared/audit-log";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import { resolveE164Country } from "./e164-country";
import { FRAUD_CDR_SOURCE, SHORT_CALL_SECONDS } from "./fraud-cdr.port";
import { FraudSignalPublisher } from "./fraud-signal.publisher";
import { TollFraudService } from "./toll-fraud.service";
import type { PbxEnv } from "../shared/pbx-env";
import type { FraudCdrSource, InternationalLegGroup } from "./fraud-cdr.port";
import type { SecurityFraudSignalData } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * Prefixes that carry a revenue share to somebody, listed by the calling code the fraud advisories
 * keep naming.
 *
 * ## What this list is and, more importantly, what it is not
 *
 * It is NOT a block list, and nothing here refuses a call. It raises a signal — "somebody called a
 * destination of the kind that appears in fraud reports" — which a tenant with legitimate business
 * there will see once and ignore, and a tenant with a compromised handset will see at 04:00 and act
 * on. A block list of these would be wrong: every one of them is a real country somebody has real
 * business with, and a platform that refused calls to Latvia because Latvia is on a list would be
 * refusing calls to Latvia.
 *
 * The entries are the ranges that recur across carrier fraud bulletins — satellite and global
 * networks, the audiotext code, and the small-country ranges whose termination rates make
 * international revenue-share fraud pay. It is a heuristic, it is out of date the moment it is
 * written, and a tenant's own `deniedCountries` is the control that actually decides anything.
 */
const HIGH_RISK_PREFIXES: readonly string[] = [
	// Global networks and satellite: no country, high termination cost, the classic destination.
	"+882",
	"+883",
	"+881",
	"+870",
	// International premium / audiotext.
	"+979",
	// Small-nation ranges that recur in carrier fraud bulletins.
	"+247",
	"+290",
	"+239",
	"+678",
	"+676",
	"+677",
	"+688",
	"+681",
	"+683",
	"+690",
	"+692",
	"+509",
	"+252",
	"+240",
];

/**
 * How many legs to one destination inside the window make a "burst".
 *
 * Twelve, and it is a shape rather than a rate: twelve answered calls to ONE number in an hour, most
 * of them under twenty seconds, is a dialer. A busy sales desk calling one client twelve times in an
 * hour would trip it too — which is why the finding is a signal and not a suspension unless the
 * tenant has asked for one.
 */
const SHORT_CALL_BURST_LEGS = 12;

/** What fraction of a burst has to be short before it looks automated rather than busy. */
const SHORT_CALL_BURST_RATIO = 0.6;

/**
 * Distinct source addresses for ONE account inside the window that make a spread.
 *
 * Six. A phone moves between a desk, a VPN and a mobile network and legitimately shows two or three
 * in an hour; six distinct addresses authenticating as one account is either credential sharing or
 * a leaked password being walked through a proxy pool. The evidence is `sip_auth_event` rather than
 * CDR, because a spread shows up in REGISTER attempts long before it shows up in a call.
 */
const REGISTRATION_SOURCE_SPREAD = 6;

/**
 * The minutes-spike threshold for a tenant with no configured ceiling.
 *
 * The hourly ceiling is the honest comparison and most tenants have not set one. Rather than say
 * nothing about them, the detector uses this as a floor: three hundred international minutes in one
 * hour is five hours of talk time, which is a real thing for a call centre and a klaxon for the
 * ninety-odd percent of tenants that are not one. A tenant that finds it noisy sets a real ceiling,
 * which then takes precedence — which is the outcome this default exists to produce.
 */
const DEFAULT_MINUTES_SPIKE = 300;

/** Groups pulled from the CDR side per pass. See {@link FraudCdrSource.internationalCandidates}. */
const CANDIDATE_LIMIT = 20_000;

/**
 * The hourly pass over what actually happened, and the half of toll-fraud defence that does not
 * depend on anybody having configured anything.
 *
 * ## Why a detector exists when there is already a gate
 *
 * `TollFraudService.evaluate` refuses calls against ceilings somebody set. Its blind spot is the
 * tenant who has set none — which is every tenant on the day they sign up, and most of them
 * forever. A platform whose only fraud control is one the customer has to configure is a platform
 * whose fraud incidents all happen to customers who did not.
 *
 * So this looks backwards, over an hour of call records, for four shapes that do not need a
 * threshold to be suspicious:
 *
 * - **a minutes spike** — more international talk time in an hour than the tenant's own ceiling, or
 *   than {@link DEFAULT_MINUTES_SPIKE} when they have none;
 * - **high-risk prefixes** — a call to a satellite, global-network or audiotext range;
 * - **a short-call burst** — many answered, quickly-dropped legs to ONE destination, which is what
 *   an automated dialer walking a premium range looks like in a CDR;
 * - **a registration source spread** — one account authenticating from many addresses, which is the
 *   fact that PRECEDES the other three and is read from `sip_auth_event`, not from CDR.
 *
 * ## What it does about them
 *
 * Raises the event and writes an audit row. It suspends an extension's outbound calling only when
 * the tenant's policy says `auto_suspend_on_signal`, which defaults to off — the schema records
 * why at length, and the short version is that the detector runs on heuristics and a false positive
 * at 09:00 on a Monday is worse for most tenants than an hour of fraud.
 *
 * ## Re-entrancy, and why there is no lease
 *
 * The pass is refused rather than queued while one is running, exactly as `HotDeskSweeper` does. Two
 * replicas sweeping at once will both find the same hour and both raise the same signals, and that
 * is accepted rather than coordinated: the signals carry an idempotency key JetStream dedupes on
 * inside its duplicate window, the audit rows are append-only by design, and an auto-suspension is
 * a compare-and-set that writes the same bytes twice. A lease would be a second thing to get wrong
 * for a duplicate alert nobody is harmed by. `projection-outbox.service.ts` makes the same argument
 * at length.
 */
@Injectable()
export class FraudAnomalyDetector implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private passes = 0;
	private findings = 0;
	private suspended = 0;
	private failed = 0;

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(TollFraudService) private readonly tollFraud: TollFraudService,
		@Inject(FraudSignalPublisher) private readonly signals: FraudSignalPublisher,
		@Optional() @Inject(FRAUD_CDR_SOURCE) private readonly cdr?: FraudCdrSource,
	) {}

	get stats(): {
		readonly passes: number;
		readonly findings: number;
		readonly suspended: number;
		readonly failed: number;
	} {
		return {
			passes: this.passes,
			findings: this.findings,
			suspended: this.suspended,
			failed: this.failed,
		};
	}

	onModuleInit(): void {
		const intervalMs = this.env.PBX_FRAUD_DETECTOR_INTERVAL_MS;
		if (intervalMs === 0) {
			logger.warn(
				"PBX_FRAUD_DETECTOR_INTERVAL_MS is 0 — nothing looks backwards at this platform's call " +
					"records, so a tenant with no configured spend ceilings has no toll-fraud detection " +
					"at all.",
			);
			return;
		}
		// `unref` so a pending timer cannot hold open a process that is otherwise finished — a
		// verification script that boots the module and exits must exit.
		this.timer = setInterval(() => {
			void this.pass();
		}, intervalMs);
		this.timer.unref?.();
		logger.info({ intervalMs }, "toll-fraud anomaly detector started");
	}

	onApplicationShutdown(): void {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * One pass over the last hour. Exported for the spec and for a verification script; the timer is
	 * the only caller in production.
	 *
	 * `now` is a parameter so the spec can place a window without waiting for one.
	 */
	async pass(now: Date = new Date()): Promise<readonly FraudFinding[]> {
		if (this.running || this.stopped) {
			return [];
		}
		this.running = true;
		const findings: FraudFinding[] = [];
		try {
			const since = new Date(now.getTime() - 3_600_000);
			findings.push(...(await this.callFindings(since, now)));
			findings.push(...(await this.registrationFindings(since, now)));
			for (const finding of findings) {
				await this.report(finding, now);
			}
		} catch (error) {
			// A pass that throws must not kill the timer: the next tick is an hour away and the
			// evidence is still in the database.
			logger.error({ error }, "the toll-fraud anomaly pass failed");
			this.failed += 1;
		} finally {
			this.running = false;
			this.passes += 1;
			this.findings += findings.length;
		}
		return findings;
	}

	/** The three CDR-derived shapes. Empty when there is no CDR database. */
	private async callFindings(since: Date, until: Date): Promise<readonly FraudFinding[]> {
		if (this.cdr === undefined) {
			return [];
		}
		const groups = await this.cdr.internationalCandidates(since, until, CANDIDATE_LIMIT);
		const findings: FraudFinding[] = [];
		for (const [organizationId, rows] of groupByOrganization(groups)) {
			const homeCountry = await this.homeCountryOf(organizationId);
			const international = rows.filter((row) => isInternational(row.toNumber, homeCountry));
			if (international.length === 0) {
				continue;
			}
			findings.push(...(await this.minutesSpike(organizationId, international)));
			findings.push(...highRiskFindings(organizationId, international));
			findings.push(...burstFindings(organizationId, international));
		}
		return findings;
	}

	/**
	 * Total international minutes against the tenant's own hourly ceiling, or the default floor.
	 *
	 * The ceiling is preferred when there is one, so a call centre that told the platform it does
	 * five hundred minutes an hour is not alerted at three hundred. That is the whole point of
	 * letting the configured number win: a detector a tenant has to mute is a detector nobody reads.
	 */
	private async minutesSpike(
		organizationId: string,
		rows: readonly InternationalLegGroup[],
	): Promise<readonly FraudFinding[]> {
		const minutes = rows.reduce((total, row) => total + row.minutes, 0);
		const policy = await this.tollFraud.policyFor(organizationId);
		const threshold = policy?.maxInternationalMinutesPerHour ?? DEFAULT_MINUTES_SPIKE;
		if (minutes <= threshold) {
			return [];
		}
		return [
			{
				organizationId,
				kind: "international-minutes-spike",
				severity: "critical",
				observed: minutes,
				threshold,
				windowSeconds: 3_600,
				summary:
					`${String(minutes)} international minutes in the last hour, against a threshold of ` +
					`${String(threshold)}.`,
			},
		];
	}

	/**
	 * One account, many source addresses — read from `sip_auth_event` rather than from CDR.
	 *
	 * The events table is append-only and tenant-scoped, and the query is a `count(distinct)` per
	 * account over the window's index. Accounts with a single address are excluded in SQL rather
	 * than filtered here, so the transfer is proportional to the finding.
	 *
	 * Cross-tenant by construction: the sweep asks each organization that has events in the window.
	 * There is no platform-wide read here and there cannot be — `withTenantScope` is the only way
	 * this area touches the database.
	 */
	private async registrationFindings(since: Date, _until: Date): Promise<readonly FraudFinding[]> {
		const organizations = await this.organizationsWithAuthEvents(since);
		const findings: FraudFinding[] = [];
		for (const organizationId of organizations) {
			const spreads = await this.database.withTenantScope(organizationId, async (transaction) => {
				return await transaction
					.select({
						accountRef: sipAuthEvent.accountRef,
						sources: sql<number>`count(distinct ${sipAuthEvent.sourceIp})`,
						attempts: count(),
					})
					.from(sipAuthEvent)
					.where(gte(sipAuthEvent.occurredAt, since))
					.groupBy(sipAuthEvent.accountRef)
					.having(sql`count(distinct ${sipAuthEvent.sourceIp}) >= ${REGISTRATION_SOURCE_SPREAD}`);
			});
			for (const spread of spreads) {
				if (spread.accountRef === null) {
					// An event with no account is an attack on the surface rather than on an account.
					// It is real, it is already in the attack log, and it is not THIS heuristic.
					continue;
				}
				findings.push({
					organizationId,
					kind: "registration-source-spread",
					severity: "warning",
					extensionNumber: spread.accountRef,
					observed: Number(spread.sources),
					threshold: REGISTRATION_SOURCE_SPREAD,
					windowSeconds: 3_600,
					summary:
						`Account ${spread.accountRef} authenticated from ${String(spread.sources)} distinct ` +
						`source addresses in the last hour across ${String(spread.attempts)} attempts.`,
				});
			}
		}
		return findings;
	}

	/**
	 * The organizations with authentication events in the window.
	 *
	 * A distinct over the tenant column, which is the one query in this file that has to see across
	 * tenants and therefore runs UNSCOPED. That is safe for exactly one reason and it is worth
	 * stating: it selects the organization column and nothing else — no account, no address, no
	 * event — so a bug here can leak the fact that a tenant had failed logins and not one byte about
	 * them. Every read that touches a row goes back through `withTenantScope`.
	 */
	private async organizationsWithAuthEvents(since: Date): Promise<readonly string[]> {
		const rows = await this.database.adminDb
			.select({ organizationId: sipAuthEvent.organizationId })
			.from(sipAuthEvent)
			.where(gte(sipAuthEvent.occurredAt, since))
			.groupBy(sipAuthEvent.organizationId);
		return rows.map((row) => row.organizationId);
	}

	/** Publishes one finding, writes its ledger row, and suspends when the tenant asked for it. */
	private async report(finding: FraudFinding, now: Date): Promise<void> {
		const policy = await this.tollFraud.policyFor(finding.organizationId);
		const extensionId =
			finding.extensionNumber === undefined
				? undefined
				: await this.extensionIdFor(finding.organizationId, finding.extensionNumber);
		let action: SecurityFraudSignalData["action"] = "none";
		if (policy?.autoSuspendOnSignal === true && extensionId !== undefined) {
			const suspended = await this.tollFraud.autoSuspend(
				finding.organizationId,
				extensionId,
				finding.summary,
			);
			if (suspended !== undefined) {
				action = "extension-suspended";
				this.suspended += 1;
			}
		}
		await this.database.withTenantScope(finding.organizationId, async (transaction) => {
			await insertAuditLog(transaction, {
				organizationId: finding.organizationId,
				actor: serviceActor("api.fraud-anomaly-detector"),
				action: "toll-fraud.signal",
				resourceType: extensionId === undefined ? "toll_fraud_policy" : "extension",
				resourceRef: extensionId ?? null,
				before: null,
				after: {
					kind: finding.kind,
					severity: finding.severity,
					action,
					observed: finding.observed,
					threshold: finding.threshold,
					summary: finding.summary,
				},
			});
		});
		logger.warn(
			{
				organizationId: finding.organizationId,
				kind: finding.kind,
				observed: finding.observed,
				threshold: finding.threshold,
				action,
			},
			"the toll-fraud detector raised a signal",
		);
		await this.signals.publish(
			finding.organizationId,
			{
				kind: finding.kind,
				severity: finding.severity,
				action,
				...(extensionId === undefined ? {} : { extensionId }),
				...(finding.extensionNumber === undefined
					? {}
					: { extensionNumber: finding.extensionNumber }),
				...(finding.destination === undefined ? {} : { destination: finding.destination }),
				...(finding.destinationCountry === undefined
					? {}
					: { destinationCountry: finding.destinationCountry }),
				...(finding.observed === undefined ? {} : { observed: finding.observed }),
				...(finding.threshold === undefined ? {} : { threshold: finding.threshold }),
				...(finding.windowSeconds === undefined ? {} : { windowSeconds: finding.windowSeconds }),
				summary: finding.summary,
			},
			now,
		);
	}

	/** The extension row behind a dialable number, when the finding names one. */
	private async extensionIdFor(
		organizationId: string,
		number: string,
	): Promise<string | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ id: extension.id })
				.from(extension)
				.where(eq(extension.number, number))
				.limit(1);
			return rows[0]?.id;
		});
	}

	/**
	 * The tenant's own country, from the same setting the gate reads it from.
	 *
	 * Through {@link TollFraudService.homeCountry} rather than re-derived here, so the detector and
	 * the gate can never disagree about which calls are international — a disagreement that would
	 * show up as alerts for domestic traffic on exactly the tenants whose configuration is unusual.
	 */
	private async homeCountryOf(organizationId: string): Promise<string | undefined> {
		return await this.tollFraud.homeCountry(organizationId);
	}
}

/** One thing the detector noticed, before it has been published or acted on. */
export interface FraudFinding {
	readonly organizationId: string;
	readonly kind: SecurityFraudSignalData["kind"];
	readonly severity: SecurityFraudSignalData["severity"];
	readonly extensionNumber?: string;
	readonly destination?: string;
	readonly destinationCountry?: string;
	readonly observed?: number;
	readonly threshold?: number;
	readonly windowSeconds?: number;
	readonly summary: string;
}

/** Groups the port's flat aggregate by tenant, preserving order. */
export function groupByOrganization(
	groups: readonly InternationalLegGroup[],
): ReadonlyMap<string, readonly InternationalLegGroup[]> {
	const byOrganization = new Map<string, InternationalLegGroup[]>();
	for (const group of groups) {
		const existing = byOrganization.get(group.organizationId);
		if (existing === undefined) {
			byOrganization.set(group.organizationId, [group]);
			continue;
		}
		existing.push(group);
	}
	return byOrganization;
}

/**
 * Whether a destination is international for a tenant whose home country is `homeCountry`.
 *
 * An UNRESOLVABLE destination counts as international, which is the same reading the gate takes and
 * for the same reason: a global-network or satellite prefix is the exact shape of a revenue-share
 * number, and treating it as domestic would put the highest-risk category outside every heuristic
 * on this page. A tenant with no home country has everything counted, which is the fail-closed
 * direction for a detector that only ever raises alerts.
 */
export function isInternational(toNumber: string, homeCountry: string | undefined): boolean {
	const country = resolveE164Country(toNumber);
	return country === undefined || country !== homeCountry;
}

/** Calls to prefixes that recur in carrier fraud bulletins. One finding per destination. */
export function highRiskFindings(
	organizationId: string,
	rows: readonly InternationalLegGroup[],
): readonly FraudFinding[] {
	const findings: FraudFinding[] = [];
	for (const row of rows) {
		if (!HIGH_RISK_PREFIXES.some((prefix) => row.toNumber.startsWith(prefix))) {
			continue;
		}
		const country = resolveE164Country(row.toNumber);
		findings.push({
			organizationId,
			kind: "high-risk-prefix",
			severity: "critical",
			extensionNumber: row.fromNumber,
			destination: row.toNumber,
			...(country === undefined ? {} : { destinationCountry: country }),
			observed: row.legs,
			windowSeconds: 3_600,
			summary:
				`${String(row.legs)} call(s) from ${row.fromNumber} to ${row.toNumber}, a range that ` +
				"recurs in carrier toll-fraud advisories.",
		});
	}
	return findings;
}

/** Many answered, quickly-dropped legs to one destination: the automated-dialer shape. */
export function burstFindings(
	organizationId: string,
	rows: readonly InternationalLegGroup[],
): readonly FraudFinding[] {
	const findings: FraudFinding[] = [];
	for (const row of rows) {
		if (row.legs < SHORT_CALL_BURST_LEGS) {
			continue;
		}
		if (row.shortLegs / row.legs < SHORT_CALL_BURST_RATIO) {
			continue;
		}
		const country = resolveE164Country(row.toNumber);
		findings.push({
			organizationId,
			kind: "short-call-burst",
			severity: "warning",
			extensionNumber: row.fromNumber,
			destination: row.toNumber,
			...(country === undefined ? {} : { destinationCountry: country }),
			observed: row.legs,
			threshold: SHORT_CALL_BURST_LEGS,
			windowSeconds: 3_600,
			summary:
				`${String(row.legs)} calls from ${row.fromNumber} to ${row.toNumber} in the last hour, ` +
				`${String(row.shortLegs)} of them under ${String(SHORT_CALL_SECONDS)} seconds.`,
		});
	}
	return findings;
}
