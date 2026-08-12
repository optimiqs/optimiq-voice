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
	readonly createdAt: string;
}

/** Every leg of one call, plus every recording any of them produced, in one round trip. */
export interface CallDetail {
	readonly callId: string;
	readonly legs: readonly CallLegRow[];
	readonly recordings: readonly RecordingRow[];
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
