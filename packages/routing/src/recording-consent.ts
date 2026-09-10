/**
 * The recording-consent vocabulary.
 *
 * # Why it lives in `routing` and is mirrored rather than imported
 *
 * Three planes have to agree on these words: the compiler bakes the tenant's POLICY into the
 * artifact, the engine stamps the OUTCOME onto the leg it recorded, and the CDR writer files that
 * outcome next to the call. `routing` is the only one of the three every other one already depends
 * on, so the declaration belongs here. Where a package cannot depend on routing — `packages/events`
 * is deliberately dependency-free, because every producer and consumer on the bus imports it — the
 * literals are MIRRORED with a comment pointing back at this file. A mirror that drifts is caught by
 * the schema tests on both sides; an import would make the event contract depend on the compiler,
 * which is the coupling that dependency-freedom exists to prevent.
 *
 * # Why the three axes are separate
 *
 * "What the tenant asked for", "what happened" and "how it was reached" are three different
 * questions and only the first is configuration. Collapsing them into one enum would make
 * `announce` mean both "this tenant announces" and "this call was announced", and there would then
 * be no way to record the call where the tenant asked for a keypress and the caller declined —
 * which is precisely the call a compliance reviewer goes looking for.
 */

/** What a tenant asks of a call it records. */
export const RECORDING_CONSENT_POLICIES = [
	"none",
	"announce",
	"announce-and-require-keypress",
] as const;

export type RecordingConsentPolicy = (typeof RECORDING_CONSENT_POLICIES)[number];

/** What actually happened on one call. */
export const RECORDING_CONSENT_OUTCOMES = [
	"not-required",
	"announced",
	"accepted",
	"declined",
] as const;

export type RecordingConsentOutcome = (typeof RECORDING_CONSENT_OUTCOMES)[number];

/** How the outcome was reached. */
export const RECORDING_CONSENT_METHODS = ["none", "announcement", "keypress"] as const;

export type RecordingConsentMethod = (typeof RECORDING_CONSENT_METHODS)[number];

/**
 * The record one call carries.
 *
 * It travels whole — on `channel.record.started` and onto the CDR leg — rather than as four loose
 * columns everywhere, because the four facts are only meaningful together: `declined` with no
 * `method` cannot be told from a producer that forgot the field, and an `at` without an outcome
 * dates nothing. `regions` names the jurisdictions that forced all-party treatment, and it is the
 * field that explains WHY a call the tenant configured as `none` was nevertheless announced.
 */
export interface RecordingConsentRecord {
	readonly outcome: RecordingConsentOutcome;
	readonly method: RecordingConsentMethod;
	readonly policy: RecordingConsentPolicy;
	/** ISO 8601, stamped when the outcome was decided. */
	readonly at: string;
	/** Which parties heard the announcement. */
	readonly parties: readonly ("caller" | "callee")[];
	readonly regions?: readonly string[];
	readonly promptId?: string;
}

/**
 * All-party ("two-party") consent jurisdictions this platform treats as requiring both sides to be
 * told. ISO 3166-2 for US states, `EU` for the Union. A POLICY DEFAULT, not legal advice — see
 * `docs/recording-compliance.md`.
 */
export const DEFAULT_ALL_PARTY_REGIONS = [
	"US-CA",
	"US-DE",
	"US-FL",
	"US-IL",
	"US-MD",
	"US-MA",
	"US-MI",
	"US-MT",
	"US-NV",
	"US-NH",
	"US-OR",
	"US-PA",
	"US-WA",
	"EU",
] as const;

const RECORDING_CONSENT_POLICY_SET: ReadonlySet<string> = new Set(RECORDING_CONSENT_POLICIES);

/**
 * Whether a value is one of the three policies.
 *
 * The compiler's guard against a column that reached the database ahead of, or behind, this
 * vocabulary: `org_setting` is a jsonb row and the per-DID column is free text with a check
 * constraint, and neither is a TypeScript type at the moment the compiler reads it.
 */
export function isRecordingConsentPolicy(value: unknown): value is RecordingConsentPolicy {
	return typeof value === "string" && RECORDING_CONSENT_POLICY_SET.has(value);
}
