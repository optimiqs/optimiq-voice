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
