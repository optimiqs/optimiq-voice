/**
 * What the anomaly detector needs out of the call-detail database, and nothing else.
 *
 * ## Why a port and not a query
 *
 * `PbxModule` and `CdrModule` are siblings composed conditionally in `main.ts`: each mounts on its
 * own database URL and each must keep booting when the other is absent. A detector in the PBX area
 * that imported `@optimiq-voice/cdr-db` would give the PBX area a boot dependency on a database it
 * does not own — the exact coupling `pbx-cdr-ports.module.ts` exists to avoid, in the same
 * direction that file already handles for retention and purge auditing.
 *
 * So the PBX area declares the SHAPE it needs and the ports module implements it. Injected
 * `@Optional()`: a deployment with no CDR database has no call history to detect anything in, and
 * the detector logs once and stands down rather than failing to boot.
 *
 * ## The port aggregates; the detector JUDGES
 *
 * The one method here returns a `group by (organization, from, to)` over the window and nothing
 * else — no notion of "international", no thresholds, no risk. That split is deliberate and it is
 * not tidiness: which destinations count as international depends on each tenant's own home
 * country, which is a `pbx-db` setting the CDR database has never heard of, and which prefixes are
 * high-risk is a fraud judgement that will change more often than either schema. Putting either
 * inside the port would put PBX policy inside a CDR query, where nothing that owns it can test it.
 *
 * What the port DOES filter is the part that is cheap in SQL and enormous in transfer: outbound legs
 * only, answered only, E.164 destinations only. That is the difference between an aggregate and a
 * table scan's worth of rows crossing a process boundary.
 */

/** DI token. A Symbol, per the area's convention — see `pbx.tokens.ts`. */
export const FRAUD_CDR_SOURCE = Symbol("api/pbx/FraudCdrSource");

/**
 * One `(organization, caller, destination)` triple in the window.
 *
 * `fromNumber` is the extension's dialable number rather than an id, because the CDR database holds
 * no `pbx-db` extension ids — `call-leg-schema.ts` says so at the columns that would otherwise be
 * foreign keys. The detector resolves it back to an extension when it needs to suspend one.
 */
export interface InternationalLegGroup {
	readonly organizationId: string;
	readonly fromNumber: string;
	/** The dialled destination, E.164. */
	readonly toNumber: string;
	readonly legs: number;
	/** Whole talk minutes, summed as the carrier would bill them: rounded UP per leg. */
	readonly minutes: number;
	/** Legs that answered and lasted under {@link SHORT_CALL_SECONDS}. */
	readonly shortLegs: number;
}

/**
 * A leg shorter than this that ANSWERED is "short" for the burst heuristic.
 *
 * Twenty seconds. Long enough that a wrong number or a quick confirmation does not count, short
 * enough to catch the pattern the heuristic is for: an automated dialer walking a premium range,
 * which answers, holds for the minimum billable interval, and drops.
 */
export const SHORT_CALL_SECONDS = 20;

export interface FraudCdrSource {
	/**
	 * Answered outbound legs in `[since, until)` with an E.164 destination, grouped by
	 * `(organization, from, to)`.
	 *
	 * `limit` bounds the result rather than the scan, and the detector passes a generous one: a
	 * tenant with more distinct destinations in an hour than this is itself the finding, and the
	 * truncated tail cannot hide a spike because the spike is in the total the groups sum to.
	 */
	internationalCandidates(
		since: Date,
		until: Date,
		limit: number,
	): Promise<readonly InternationalLegGroup[]>;
}
