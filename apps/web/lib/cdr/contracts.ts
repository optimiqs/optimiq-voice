/**
 * The reporting API's wire shapes.
 *
 * Hand-written and mirroring `apps/api/src/cdr/`, exactly as `lib/pbx/contracts.ts` mirrors the
 * PBX area, and for the same reason: there is no OpenAPI generator yet. `Date` columns arrive as
 * ISO strings.
 *
 * ## Why this is a cursor envelope and not the PBX one
 *
 * Every PBX list returns `{ data, total, page, limit, totalPages }`. This one returns
 * `{ data, nextCursor, limit, range }` and the difference is deliberate on the server's side:
 * `total` needs a `count(*)`, and over a monthly-partitioned billing ledger that is a scan of every
 * partition in the range, paid on every page. So the UI can say "1–25, more" and cannot say
 * "1–25 of 41,882". Reusing the PBX envelope here would have made the expensive query the natural
 * one to write.
 */

export interface CursorEnvelope<T> {
	readonly data: readonly T[];
	/** Pass back as `?cursor=` for the next page. `null` means this was the last one. */
	readonly nextCursor: string | null;
	readonly limit: number;
	/** The window the server actually applied, after defaulting. Rendered so it is never a mystery. */
	readonly range: { readonly from: string; readonly to: string };
}

export type CallDirection = "inbound" | "outbound" | "internal";
export type CallDisposition = "answered" | "no-answer" | "busy" | "failed" | "voicemail";
export type CallLegSide = "a" | "b";
export type HangupSide = "caller" | "callee" | "system";
export type RecordingKind = "call" | "voicemail" | "conference";
export type TranscriptionStatus = "none" | "pending" | "processing" | "completed" | "failed";

/** One row of the call list. */
export interface CallLegRow {
	readonly id: string;
	/** Correlates every leg of one logical call — the key the detail view expands on. */
	readonly callId: string;
	readonly leg: CallLegSide;
	/** The leg that dialled this one. Null on an A-leg; this is what makes the tree a tree. */
	readonly originatingLegId: string | null;
	/** The leg this one was bridged to, when a bridge was established. */
	readonly bridgeLegId: string | null;
	readonly direction: CallDirection;
	readonly fromNumber: string;
	readonly fromName: string | null;
	readonly toNumber: string;
	readonly destinationType: string;
	readonly destinationRef: string | null;
	readonly startedAt: string;
	readonly answeredAt: string | null;
	readonly endedAt: string | null;
	/** Wall clock: what the call cost the platform. */
	readonly durationMs: number;
	/** Answer → hangup: what the call costs the tenant. Zero on an unanswered leg. */
	readonly billsecMs: number;
	readonly hangupCause: string;
	readonly hangupCauseCode: number;
	readonly hangupSide: HangupSide | null;
	readonly disposition: CallDisposition;
	readonly recordingKey: string | null;
	readonly transcriptionStatus: TranscriptionStatus;
	/**
	 * Which authorisation code let this leg dial out, when one was demanded.
	 *
	 * A PIN set attached to an outbound route challenges the caller before any trunk is offered the
	 * call, and the engine records WHICH code answered — `call_legs.auth_pin_ordinal` is the entry's
	 * position in the set and `auth_pin_label` is the human name beside it ("Night desk"). The digits
	 * are never here: they are stored as a digest and the label is what a bill is read against.
	 *
	 * All-or-nothing, and the writer enforces it (`cdr-leg-mapping.ts` nulls the label when the
	 * ordinal is absent), so a label without an ordinal is not a state this app has to render. The
	 * ordinal is legitimately `0` — the first code in a set — which is why nothing here may test it
	 * for truthiness.
	 *
	 * ## Both are OPTIONAL, and that is the honest mirror rather than a hedge
	 *
	 * The columns exist and the writer fills them, but `LEG_LIST_COLUMNS` and `LEG_DETAIL_COLUMNS` in
	 * `apps/api/src/cdr/query/cdr.repository.ts` do not select them yet — and `raw` cannot stand in,
	 * because both keys are in `MAPPED_KEYS` and are therefore stripped out of the passthrough blob.
	 * So a leg read today arrives with the keys ABSENT rather than null, and typing them as
	 * `number | null` would be this app asserting a projection the server does not have.
	 *
	 * `?` rather than `| null` alone is what makes the renderer's `== null` test correct for both the
	 * "not selected" and the "no code was demanded" cases, and what makes widening the projection a
	 * change with no diff on this side.
	 */
	readonly authPinOrdinal?: number | null;
	readonly authPinLabel?: string | null;
	/**
	 * What the CARRIER claimed about an inbound call's caller ID — STIR/SHAKEN, as received.
	 *
	 * `sipAttestation` is the `attest` parameter of the Identity header's PASSporT (`A`, `B` or
	 * `C`), `sipVerstat` the `verstat` the verification service appended to the P-Asserted-Identity
	 * (`TN-Validation-Passed`, `TN-Validation-Failed`, `No-TN-Validation`), and `sipOrigId` the
	 * `origid` that names which originating service signed it.
	 *
	 * These are a CLAIM by an upstream party, recorded verbatim. Nothing on this platform verified
	 * them, and the renderer must never present them as something this platform checked — an
	 * attestation of `A` on an inbound call means the originating carrier vouched for its own
	 * customer, not that the number is who it says it is. That distinction is the entire reason
	 * these are rendered separately from {@link expectedAttestation} below.
	 *
	 * @see expectedAttestation for the OUTBOUND counterpart, which is this platform's own decision.
	 */
	readonly sipAttestation?: string | null;
	readonly sipVerstat?: string | null;
	readonly sipOrigId?: string | null;
	/**
	 * What THIS platform decided to attest for an outbound call, and on what basis.
	 *
	 * `expectedAttestation` is the level the signing request asked for and
	 * `callerIdRightToUse` is the evidence that justified it: `owned` (a number this platform
	 * assigned to the tenant) supports `A`, `verified` (a documented external verification — an
	 * LOA, a call-back, a carrier attestation on file) supports `B`, and neither supports only `C`.
	 *
	 * The pair is what a traceback is answered with, which is why the basis is stored beside the
	 * level rather than being re-derived: the number may have been released, or its verification
	 * expired, since the call was placed, and re-deriving would answer with today's facts about a
	 * decision made months ago.
	 *
	 * ## All seven compliance fields are OPTIONAL, on the `authPinOrdinal` precedent
	 *
	 * The columns exist on `call_legs`, but `LEG_LIST_COLUMNS` / `LEG_DETAIL_COLUMNS` in
	 * `apps/api/src/cdr/query/cdr.repository.ts` do not select all of them yet, so a leg read today
	 * can arrive with the keys ABSENT rather than null. Typing them `string | null` alone would be
	 * this app asserting a projection the server does not have. `?` is what makes the renderer's
	 * `== null` test correct for both absences at once — "not selected" and "nothing was recorded"
	 * — and what makes widening the projection a change with no diff on this side.
	 *
	 * @see sipAttestation for the INBOUND counterpart, which is a carrier's claim, not ours.
	 */
	readonly expectedAttestation?: string | null;
	readonly callerIdRightToUse?: string | null;
	/** The `trunk.id` the leg was offered to or arrived on. A uuid; this database holds no names. */
	readonly trunkRef?: string | null;
	/** The peer's signalling address as the SIP stack saw it — `host:port`, sometimes with transport. */
	readonly signalingAddress?: string | null;
}

/** The detail view adds the media-quality block and the passthrough jsonb. */
export interface CallLegDetail extends CallLegRow {
	readonly sipCallId: string | null;
	readonly routingContext: string | null;
	readonly applicationRef: string | null;
	readonly queueRef: string | null;
	readonly ivrRef: string | null;
	readonly ringGroupRef: string | null;
	readonly accountCode: string | null;
	readonly pddMs: number | null;
	readonly readCodec: string | null;
	readonly writeCodec: string | null;
	readonly remoteMediaAddress: string | null;
	readonly mos: number | null;
	readonly jitterMs: number | null;
	readonly packetLossPct: number | null;
	readonly raw: Record<string, unknown>;
	readonly createdAt: string;
	readonly recordings: readonly RecordingRow[];
}

/**
 * What actually happened on one call, mirroring `RECORDING_CONSENT_OUTCOMES` in
 * `@optimiq-voice/routing` — the row's `consent.outcome`.
 *
 * `not-required` is a real answer and not a missing one: the policy asked for nothing and nothing
 * was said. A row with NO consent record at all is different again — it predates this feature — and
 * the screen shows nothing for it rather than guessing.
 */
export const RECORDING_CONSENT_OUTCOMES = [
	"not-required",
	"announced",
	"accepted",
	"declined",
] as const;
export type RecordingConsentOutcome = (typeof RECORDING_CONSENT_OUTCOMES)[number];

/** How the outcome was reached. Mirrors `RECORDING_CONSENT_METHODS`. */
export const RECORDING_CONSENT_METHODS = ["none", "announcement", "keypress"] as const;
export type RecordingConsentMethod = (typeof RECORDING_CONSENT_METHODS)[number];

/**
 * The consent record one recording carries, mirroring `RecordingConsentRow` in
 * `@optimiq-voice/cdr-db`.
 *
 * Optional everywhere it appears, and that is the compatibility rule the whole feature is built on:
 * a recording written before consent existed has no record, and must read exactly as it did.
 */
export interface RecordingConsent {
	readonly outcome: RecordingConsentOutcome;
	readonly method: RecordingConsentMethod;
	readonly policy: string;
	/** ISO 8601, stamped when the outcome was decided rather than when the row was written. */
	readonly at: string;
	readonly parties: readonly string[];
	readonly regions?: readonly string[];
	readonly promptId?: string;
}

export interface RecordingRow {
	readonly id: string;
	readonly callId: string | null;
	readonly legId: string | null;
	readonly kind: RecordingKind;
	readonly objectKey: string;
	readonly durationMs: number;
	readonly sizeBytes: number;
	readonly retentionUntil: string | null;
	/** Set once the object is purged; the row is kept as an audit tombstone and cannot be played. */
	readonly deletedAt: string | null;
	/**
	 * What the parties were told before this object was made, when anything was.
	 *
	 * Absent or `null` on every recording made before the consent gate existed, and on any made
	 * under a policy that asked for nothing at all where the engine wrote no record. A screen must
	 * render that as nothing rather than as "unknown": a blank cell is the truth, and "unknown" reads
	 * like a failure to look.
	 */
	readonly consent?: RecordingConsent | null;
	readonly createdAt: string;
}

/** Every leg of one call, plus every recording any of them produced, in one round trip. */
export interface CallDetail {
	readonly callId: string;
	readonly legs: readonly CallLegRow[];
	readonly recordings: readonly RecordingRow[];
	/**
	 * What the caller answered after the agent hung up, ordered by question.
	 *
	 * Joined by the server from the PBX database — the answers and the legs live in two different
	 * databases and share only this call id. Empty for a call that was never surveyed, which is
	 * every call that did not come through a queue with one configured.
	 */
	readonly survey: readonly QueueSurveyCallAnswer[];
}

// ---------------------------------------------------------------------------------------------
// Exports — asking the ledger a question too big to answer in a request
// ---------------------------------------------------------------------------------------------

/**
 * Where an export job is in its lifecycle. Mirrors `CDR_EXPORT_STATUSES` in `@optimiq-voice/cdr-db`.
 *
 * Two of the four are TERMINAL (`succeeded`, `failed`) and two are not, and that distinction is
 * load-bearing rather than cosmetic: it is what a polling client stops on. See
 * {@link isSettledExportStatus} in `./client.ts`, which is the single place this app decides.
 *
 * `running` is a CLAIM rather than a phase — the row carries `claimedAt` and a worker that dies
 * mid-write leaves a job stuck in it until the lease is reclaimed. So a job that has read `running`
 * for a while is not necessarily progressing, and the screen does not promise that it is.
 */
export const CDR_EXPORT_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type CdrExportStatus = (typeof CDR_EXPORT_STATUSES)[number];

/**
 * Why an export produced no file. Mirrors `CDR_EXPORT_FAILURES`.
 *
 * A closed set so a client can switch on it and say something useful, and `too-many-rows` is the
 * member that matters: it is the one a REQUESTER can act on, by narrowing the window, and it is
 * the one that proves the cap is not a truncation. See {@link CdrExportRow.failureDetail}.
 */
export const CDR_EXPORT_FAILURES = ["too-many-rows", "storage", "internal"] as const;
export type CdrExportFailure = (typeof CDR_EXPORT_FAILURES)[number];

/**
 * One export job.
 *
 * ## Nullability is the column's, not a guess
 *
 * The server's repository derives this shape from the Drizzle columns and keeps `| null` where the
 * column is nullable, precisely because half the interesting fields are branched on: `objectKey`
 * being `null` is how this app knows there is no file to fetch, and `failureReason` is how it knows
 * why. Flattening either to a non-null type would make the download button render on a job that
 * has nothing behind it.
 *
 * `rowCount` and `sizeBytes` are `notNull` with a default of `0`, so a queued job legitimately
 * reports zero rows — that is "not counted yet", not "no calls matched". The screen renders them
 * only on a job that finished.
 *
 * ## `filters` is the QUESTION, echoed back
 *
 * The job pins the filters as the DTO parsed them, so re-reading an old job reproduces what was
 * asked rather than what the same query would return today. That is the whole reason exports are
 * rows and not outbox entries: re-deriving "the last 92 days" a day later produces a different file
 * from the one somebody downloaded.
 *
 * It is `unknown`-valued rather than typed as `CdrListQuery`: it is whatever the DTO accepted at
 * the time the job was created, and a build that has since gained a filter must still be able to
 * render a job that predates it. `describeExportFilters` in `./client.ts` reads it defensively.
 */
export interface CdrExportRow {
	readonly id: string;
	readonly status: CdrExportStatus;
	/** The `user.id` that asked. `null` on a job whose requester was not a person. */
	readonly requestedBy: string | null;
	readonly filters: Readonly<Record<string, unknown>>;
	/** The window the server RESOLVED, lifted out of `filters` so it needs no parsing. */
	readonly rangeFrom: string;
	readonly rangeTo: string;
	readonly attempts: number;
	/** `null` until there is a file, and forever on a failure. Never rendered; see the note above. */
	readonly objectKey: string | null;
	readonly rowCount: number;
	readonly sizeBytes: number;
	readonly failureReason: CdrExportFailure | null;
	/** A sentence for a human, written by the worker. Never a stack. */
	readonly failureDetail: string | null;
	readonly completedAt: string | null;
	/** When the FILE stops being downloadable. The job row outlives it. */
	readonly expiresAt: string | null;
	readonly createdAt: string;
}

/**
 * A short-lived, signed URL for one export's CSV.
 *
 * The same shape as {@link RecordingDownloadLink} and the same bearer-credential warning, with one
 * difference at the far end: the response is served `content-disposition: attachment`, because the
 * only thing anybody does with this file is save it.
 */
export type CdrExportDownloadLink = RecordingDownloadLink;

/**
 * A short-lived, signed URL for one recording's media.
 *
 * `url` is same-origin and carries the whole grant in its path. It is a BEARER credential with a
 * lifetime of minutes — it is fine in an `<audio src>`, and it must not be stored, bookmarked or
 * put in a link somebody shares.
 */
export interface RecordingDownloadLink {
	readonly url: string;
	readonly expiresAt: string;
	readonly expiresInSeconds: number;
}

// ---------------------------------------------------------------------------------------------
// Queue service level
// ---------------------------------------------------------------------------------------------

/**
 * One queue's numbers over a window, mirroring `QueueStatsRow` in
 * `apps/api/src/cdr/query/queue-stats.ts`.
 *
 * ## The queue is a UUID and stays one
 *
 * `queueId` is `call_legs.queue_ref` and this database holds no queue NAMES — the endpoint does not
 * join `pbx-db` to label the rows, because that is a cross-database join this architecture does not
 * have. So the caller labels them from `GET /queues`, which every screen rendering these has
 * already fetched. A queue deleted since the window will appear here as an id with no name, and
 * that is the honest answer rather than a row silently dropped.
 *
 * ## Why `offered` is not `answered + abandoned`
 *
 * There are six endings and only one of them is being served. A caller the queue timed out into a
 * voicemail box has a leg that ended `answered` in call terms, and counting them as served is how a
 * queue nobody staffs reports perfectly — which is exactly the failure `queue_outcome` exists to
 * stop being invisible.
 */
export interface QueueStatsRow {
	readonly queueId: string;
	/** Every call the queue was asked to serve: answered plus every way of not being. */
	readonly offered: number;
	readonly answered: number;
	/** The caller hung up while holding. The number a supervisor reacts to. */
	readonly abandoned: number;
	/** A wait deadline expired and the queue took its timeout branch. */
	readonly timedOut: number;
	/** Nobody was logged in at all. Distinct from `timedOut`, because the fix is different. */
	readonly noAgents: number;
	/** The caller pressed the exit key. A CHOICE, which is why it is not folded into `abandoned`. */
	readonly exited: number;
	/**
	 * Mean wait across ANSWERED calls only.
	 *
	 * Answered only, deliberately, and worth repeating on this side because a chart that mixed them
	 * would be the classic contact-centre metric that reports the opposite of what happened: an
	 * average including abandonments falls when callers give up sooner, so a queue getting worse
	 * shows a shrinking hold time.
	 */
	readonly averageAnswerWaitMs: number;
	readonly averageAbandonWaitMs: number;
	/** The worst wait any answered caller had. An average hides exactly this. */
	readonly longestAnswerWaitMs: number;
	/**
	 * Answered inside the target as a percentage of OFFERED, to one decimal — and `null` when
	 * nothing was offered.
	 *
	 * The null is not a missing value to be coalesced away: a queue with no traffic has no service
	 * level, and rendering it as 0% would put an idle queue and a failing one in the same colour on
	 * a wallboard. Every renderer of this field has to say "no traffic", not "0%".
	 */
	readonly serviceLevelPct: number | null;
	/** How many offered calls beat the target — the numerator, exposed so the maths is checkable. */
	readonly withinTarget: number;
	/**
	 * The queue's post-call survey over the same window, ABSENT when nobody answered one.
	 *
	 * Absent rather than an empty summary, and the distinction is the reason this is optional: a
	 * queue with no survey configured and a queue whose survey nobody answered are different facts,
	 * and a panel that rendered a row of zeros for both would report the second as the first.
	 */
	readonly survey?: QueueSurveySummary;
}

/** One survey question's answers over a window. Mirrors `apps/api/src/cdr/query/queue-survey.port.ts`. */
export interface QueueSurveyQuestionSummary {
	readonly questionId: string;
	readonly position: number;
	readonly label: string;
	/** How many callers answered THIS question — never the queue's call count. */
	readonly responses: number;
	/** Counts for answers 1-5, in order. Always five entries, so a missing score is a zero. */
	readonly distribution: readonly number[];
	/** The mean of the answers given, to one decimal. `null` when nobody answered. */
	readonly average: number | null;
}

/** One queue's post-call survey over a window. */
export interface QueueSurveySummary {
	readonly queueId: string;
	/** Answers across every question. Not callers: one caller answering two questions is two. */
	readonly responses: number;
	readonly average: number | null;
	readonly questions: readonly QueueSurveyQuestionSummary[];
}

/** One answer one caller gave, as a call's own record of it. */
export interface QueueSurveyCallAnswer {
	readonly callId: string;
	readonly queueId: string;
	readonly questionId: string;
	readonly position: number;
	readonly label: string;
	readonly answer: number;
	readonly answeredAt: string;
}

/**
 * `GET /cdr/queue-stats`.
 *
 * Carries the resolved window and the target it was computed against, both of which are rendered:
 * the server DEFAULTS an absent range and the SLA seconds are a question rather than a stored
 * setting, so a page that showed neither would be reporting a percentage against a target the
 * reader cannot see.
 */
/**
 * One agent's numbers inside ONE queue, mirroring `AgentQueueStatsRow` in
 * `apps/api/src/cdr/query/agent-stats.ts`.
 *
 * `queueId` is a uuid and stays one, for the reason {@link QueueStatsRow} gives — the ledger holds
 * no queue names and the endpoint does not join `pbx-db` to invent them.
 */
export interface AgentQueueStatsRow {
	readonly queueId: string;
	readonly answered: number;
	readonly talkTimeMs: number;
	readonly averageTalkTimeMs: number;
	/** How long the CALLER waited before this agent took it. See the server module for why. */
	readonly averageAnswerWaitMs: number;
}

/**
 * One agent's handling over a window, mirroring `AgentStatsRow`.
 *
 * ## `agentId` is a seat, not a person
 *
 * It is a `queue_agent` ROW id. The CDR database holds no user ids at all, so this app labels the
 * rows from the queue-agent roster it has already fetched — the same one-HTTP-request-not-a-join
 * arrangement the queue stats use for queue names. An agent removed from a queue since the window
 * appears here as an id with no name, and that is the honest answer rather than a row dropped.
 *
 * ## Wrap-up is a PROXY and the UI has to say so
 *
 * Nothing on this platform records an after-call-work state. `wrapUpMs` is the gap between an
 * agent's calls, CAPPED at `wrapUpSeconds` so a lunch break is not billed to the previous caller —
 * see the server module for the whole argument. `wrapUpSamples` is how many gaps went into it, and
 * a screen rendering the average without it is a screen inviting somebody to trust a mean of two.
 */
export interface AgentStatsRow {
	readonly agentId: string;
	readonly answered: number;
	/** Billed talk time — answer to hangup. NOT `duration`, which includes the phone ringing. */
	readonly talkTimeMs: number;
	readonly averageTalkTimeMs: number;
	/** The longest single call. An average hides exactly this, and the outliers live here. */
	readonly longestTalkTimeMs: number;
	readonly averageAnswerWaitMs: number;
	/** Mean time from the agent's phone ringing to them picking it up. */
	readonly averageRingTimeMs: number;
	readonly wrapUpMs: number;
	readonly averageWrapUpMs: number;
	readonly wrapUpSamples: number;
	/**
	 * What this agent's calls CLOSED as, commonest first.
	 *
	 * A MEASUREMENT rather than the wrap-up field's cousin: the code was chosen by the agent (or
	 * recorded as `unset` by the wrap-up deadline when they chose nothing), so unlike the inter-call
	 * gap above it is not inferred from anything.
	 *
	 * Empty for every agent on a queue that asks no wrap-up question. The counts do NOT have to sum
	 * to {@link AgentStatsRow.answered}, and a screen must not present them as a share of it: a leg
	 * dispositioned after the CDR consumer filed it keeps its NULL, and a queue that started asking
	 * halfway through the window has both kinds in it.
	 */
	readonly dispositions: readonly AgentDispositionCount[];
	/** Per-queue breakdown, busiest first. */
	readonly queues: readonly AgentQueueStatsRow[];
}

/** One wrap-up outcome and how often this agent reached it. `unset` is one of them. */
export interface AgentDispositionCount {
	readonly code: string;
	readonly count: number;
}

export interface AgentStatsEnvelope {
	readonly data: readonly AgentStatsRow[];
	/** The cap the server applied, so a column can be labelled with the number that produced it. */
	readonly wrapUpSeconds: number;
	/**
	 * The group ceiling was reached and the list is short.
	 *
	 * A flag and not a `nextCursor`: there is no next page. The server argues why a keyset cursor
	 * over aggregate groups would be a correctness problem invented for a size problem a tenant's
	 * agent roster does not have — so a screen's only correct response is to SAY the list is short.
	 */
	readonly truncated: boolean;
	readonly range: { readonly from: string; readonly to: string };
}

/**
 * One bucket of call volume, mirroring `CallVolumeRow` in `apps/api/src/cdr/query/call-volume.ts`.
 *
 * `answered` is `answered_at is not null` and NOT the reporting disposition, which a voicemail
 * deposit also satisfies. That distinction is the difference between "we answered 80% of calls" and
 * "80% of callers reached a mailbox", and the two must never be rendered under the same label.
 */
export interface CallVolumeRow {
	/** The bucket's start instant, ISO, UTC. */
	readonly bucket: string;
	readonly total: number;
	readonly inbound: number;
	readonly outbound: number;
	readonly internal: number;
	readonly answered: number;
	readonly unanswered: number;
	/** Mean wall-clock leg length across every leg in the bucket. */
	readonly averageDurationMs: number;
	/** Mean billed length across ANSWERED legs only, so it does not track the answer rate. */
	readonly averageBillsecMs: number;
}

/**
 * Where the calls in one bucket went.
 *
 * A separate series rather than columns on {@link CallVolumeRow}, because `destination_type` is a
 * domain that GROWS — `paging` was appended after the fact — and a type nobody routed to in the
 * window is simply absent rather than a zero. A chart reading this has to tolerate both.
 */
export interface CallVolumeDestinationRow {
	readonly bucket: string;
	readonly destinationType: string;
	readonly total: number;
	readonly answered: number;
}

export interface CallVolumeEnvelope {
	readonly data: readonly CallVolumeRow[];
	readonly destinations: readonly CallVolumeDestinationRow[];
	readonly bucket: string;
	readonly truncated: boolean;
	readonly range: { readonly from: string; readonly to: string };
}

export interface QueueStatsEnvelope {
	readonly data: readonly QueueStatsRow[];
	readonly slaSeconds: number;
	readonly range: { readonly from: string; readonly to: string };
}
