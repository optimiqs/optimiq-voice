import type { Readable } from "node:stream";

/**
 * The transcription seam: one port, two drivers, and one rule that shapes both.
 *
 * ## THE RULE: a provider is never given a key it could resolve itself
 *
 * This is the reason the port takes an {@link TranscriptionAudio.open} closure rather than an
 * object key and an {@link import("../storage").ObjectStore}, and it is worth stating before the
 * interface.
 *
 * Voicemail audio is tenant data. The row that names it has already been read under
 * `withTenantScope`, so by the time anything opens the object the tenancy question is settled —
 * and it stays settled precisely because the provider cannot ask it again. A port that took
 * `(store, objectKey)` would put a store handle in the hands of every driver, including one written
 * later by somebody who has not read this file, and the distance between "here is a store" and "a
 * driver that builds its own key" is one plausible-looking line. Handing over a closure that is
 * already bound to one message's object makes the wrong thing unexpressible rather than discouraged.
 *
 * `objectKey` is still on the request, for logs. It is a label here, not an address.
 *
 * ## Why `open()` and not bytes
 *
 * Two reasons, and the second is the one that bites.
 *
 * A stream lets a driver that can consume one do so — a future websocket ASR, or a local server
 * that accepts chunked upload — without this port being widened by whoever needs it under time
 * pressure. The `openai-compatible` driver cannot: multipart with a known `content-length` is what
 * every OpenAI-compatible endpoint accepts, so it buffers, under the cap
 * {@link readAudioWithLimit} enforces.
 *
 * And it is a FUNCTION rather than a stream because a stream is consumed once and this operation is
 * RETRIED. A port that took a `Readable` would work on the first attempt and hand the second
 * attempt an exhausted stream, which is the kind of failure that only appears when a provider is
 * already having a bad day.
 *
 * ## Failure is classified by the driver, never by the caller
 *
 * {@link TranscriptionFailure.retryable} is the whole retry contract. The pipeline retries on
 * `true` and gives up on `false`, and it does not know what an HTTP status is — only the driver
 * does, and only the driver can say that a 401 will still be a 401 in four seconds while a 429 will
 * not. A pipeline that inspected statuses would have to be edited for every driver added here.
 */

/** Which implementation is behind the port. Surfaced for boot logs and for tests. */
export type TranscriptionDriver = "disabled" | "openai-compatible";

/** One message's audio, already bound to the object the caller proved it may read. */
export interface TranscriptionAudio {
	/**
	 * Opens the audio for reading.
	 *
	 * Called once per ATTEMPT, so a retry gets a fresh stream. Throws when the object is gone,
	 * which the pipeline treats as permanent — a message whose audio has been reaped is not going to
	 * transcribe on the fourth try.
	 */
	open(): Promise<Readable>;

	/** The store key. For logs and for the multipart file name only — see this file's header. */
	readonly objectKey: string;

	/** The object's size when the caller stat'd it, so a driver can refuse an oversized upload. */
	readonly sizeBytes: number | undefined;

	/** `audio/wav` for everything the engine records today. */
	readonly contentType: string;

	/** BCP-47, when the deployment has told us what language to expect. Advisory. */
	readonly languageHint: string | undefined;
}

/**
 * What a provider answers with.
 *
 * `text` may legitimately be empty: three seconds of hold music transcribes to nothing, and that is
 * a RESULT rather than a failure. The pipeline records it as `done` with an empty transcript, which
 * is why `voicemail_message.transcription_status` exists at all — see the column's own note.
 *
 * The three optional fields are optional because most endpoints do not send them. `verbose_json`
 * on OpenAI's own API carries `language` and `duration`; Groq's does; a bare whisper.cpp server
 * sends `{ "text": "…" }` and nothing else. A port that required them would make the driver invent
 * them.
 */
export interface TranscriptionResult {
	readonly text: string;
	/** BCP-47 or a bare language name, exactly as the provider spelled it. Not normalised here. */
	readonly language?: string | undefined;
	/** 0–1 where the provider reports one. Almost nothing does. */
	readonly confidence?: number | undefined;
	/** The audio's duration as the provider measured it, which need not match the engine's. */
	readonly durationMs?: number | undefined;
}

/**
 * One transcription provider.
 *
 * `enabled` rather than `driver === "disabled"` at every call site, on the same terms as
 * `isArchivingObjectStore`: a caller asks for the CAPABILITY and never switches on a driver name,
 * so adding a third driver does not mean auditing the callers for a string comparison that now has
 * a third case.
 */
export interface TranscriptionProvider {
	readonly driver: TranscriptionDriver;

	/**
	 * Whether this provider will actually transcribe anything.
	 *
	 * False for the `disabled` driver and only for it. Callers gate on this BEFORE building a
	 * request, which is what makes "disabled" cost nothing rather than cost a no-op call per message.
	 */
	readonly enabled: boolean;

	/**
	 * Transcribes one message.
	 *
	 * @throws {TranscriptionFailure} for anything that did not produce text. Every other throw is a
	 *   defect — a driver that lets a raw `TypeError` escape has classified nothing, and the
	 *   pipeline treats an unclassified throw as permanent rather than retrying it forever.
	 */
	transcribe(audio: TranscriptionAudio): Promise<TranscriptionResult>;
}

/**
 * A transcription that did not happen, carrying whether trying again could change that.
 *
 * The `retryable` flag is set by the driver at the point it knows the answer, never derived later.
 * See this file's header for why that is the seam's job rather than the pipeline's.
 */
export class TranscriptionFailure extends Error {
	readonly _tag = "TranscriptionFailure" as const;
	/** True when the same request, sent again after a wait, could plausibly succeed. */
	readonly retryable: boolean;
	/** The HTTP status where there was one. Absent for a transport error or a malformed body. */
	readonly status: number | undefined;

	constructor(
		message: string,
		options: {
			readonly retryable: boolean;
			readonly status?: number | undefined;
			readonly cause?: unknown;
		},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "TranscriptionFailure";
		this.retryable = options.retryable;
		this.status = options.status;
	}
}

/**
 * Reads a stream into memory, refusing at a cap rather than at the machine's limit.
 *
 * The cap is not a formality. This runs in the same process as the control plane's HTTP surface,
 * the object behind the key was written by Asterisk rather than by anything this API validated, and
 * a `voicemail_box.max_message_seconds` that an operator has set to something ambitious is the
 * ordinary way this gets large. Refusing at a configured ceiling turns that into one failed
 * transcription; not refusing turns it into the API's heap.
 *
 * The refusal is PERMANENT: the object is the size it is, and a retry in four seconds re-reads the
 * same bytes and refuses again.
 */
export async function readAudioWithLimit(stream: Readable, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
		total += buffer.length;
		if (total > maxBytes) {
			// Stop pulling, so a huge object does not keep streaming into a request we have abandoned.
			stream.destroy();
			throw new TranscriptionFailure(
				`the audio is larger than TRANSCRIBE_MAX_BYTES (${maxBytes} bytes)`,
				{ retryable: false },
			);
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}
