import { readAudioWithLimit, TranscriptionFailure } from "./transcription-provider";
import type { TranscriptionEnv } from "./transcription-env";
import type {
	TranscriptionAudio,
	TranscriptionDriver,
	TranscriptionProvider,
	TranscriptionResult,
} from "./transcription-provider";

/**
 * The one HTTP call this driver makes, as a seam.
 *
 * `typeof fetch` rather than a client class, because the surface really is one POST and a class
 * would be a wrapper around one line. Injected rather than reached for on `globalThis` so the tests
 * can answer it in-process: `test/pbx/voicemailTranscription.test.ts` asserts on the REQUEST this
 * driver builds — the URL, the bearer header, the multipart field names — and a mocking library
 * would hide exactly those behind matchers. That is the same argument `test/storage/objectStore.test.ts`
 * records for hand-rolling its S3 fake.
 */
export type TranscriptionFetch = (
	input: string,
	init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly body: FormData;
		readonly signal: AbortSignal;
	},
) => Promise<{
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
}>;

/** The path every OpenAI-compatible endpoint spells the same way. Appended to the configured base. */
const TRANSCRIPTIONS_PATH = "/audio/transcriptions";

/**
 * Statuses worth trying again, and the reasoning for each.
 *
 * `408` the endpoint timed out on its own side; `409` a transient lock on some implementations;
 * `429` rate limited, which is the single most common failure against OpenAI and Groq and the one
 * this retry policy mostly exists for; `5xx` handled by range below.
 *
 * Everything else is permanent BY DEFAULT, which is the direction that matters: a `401` with a bad
 * key, a `404` from a base URL missing its `/v1`, a `400` naming a model the endpoint does not
 * have, and a `413` for an object over the endpoint's own limit are all configuration, and retrying
 * configuration is how a queue turns into a spin.
 */
const RETRYABLE_STATUSES = new Set([408, 409, 429]);

/**
 * Transcription against any OpenAI-compatible `/audio/transcriptions` endpoint.
 *
 * ## Why "compatible" rather than a vendor
 *
 * OpenAI's transcription request is multipart with a `file` and a `model`, and its response is
 * `{ "text": "…" }`. Groq implements it, together.ai implements it, and both whisper.cpp's
 * `server` and faster-whisper's `wyoming`/`whisperX` wrappers implement it — which means the same
 * three environment variables reach a hosted API, a cheaper hosted API, or a GPU box on the
 * deployment's own network with nothing on the call path leaving the building. For voicemail —
 * which is a recording of a customer talking, and is therefore exactly the class of data a tenant
 * may be contractually unable to send to a third party — being able to point this at a local
 * server is not a nice-to-have, it is the difference between the feature being adoptable and not.
 *
 * ## `response_format=verbose_json`, degrading to `json`
 *
 * `verbose_json` carries `language` and `duration`, which fill in two of
 * {@link TranscriptionResult}'s optional fields. Not every compatible server implements it; a
 * server that does not typically answers a plain `{"text": …}` anyway, and
 * {@link parseTranscriptionBody} reads both shapes rather than insisting on one. A server that
 * REFUSES the parameter outright answers 400, which is permanent and named in the log — the honest
 * outcome, since silently dropping the parameter would hide a misconfiguration.
 *
 * ## The timeout is ours, not the endpoint's
 *
 * An `AbortSignal` on every request, because the failure mode being defended against is a hung
 * connection rather than a slow one: without it, a provider that accepts a connection and never
 * answers holds a worker slot until the socket's own keepalive gives up, which on Linux is measured
 * in minutes. An abort is classified RETRYABLE — a hung request is the archetypal transient.
 */
export class OpenAiTranscriptionProvider implements TranscriptionProvider {
	readonly driver: TranscriptionDriver = "openai-compatible";
	readonly enabled = true;

	private readonly endpoint: string;

	constructor(
		private readonly env: TranscriptionEnv,
		private readonly fetchImpl: TranscriptionFetch,
	) {
		if (env.baseUrl === undefined || env.model === undefined) {
			// Unreachable through the factory — `loadTranscriptionEnv` refuses this shape at parse
			// time — and asserted anyway, because a hand-constructed driver is what a test does.
			throw new Error(
				"OpenAiTranscriptionProvider needs TRANSCRIBE_BASE_URL and TRANSCRIBE_MODEL; " +
					"build it through createTranscriptionProvider",
			);
		}
		this.endpoint = `${env.baseUrl}${TRANSCRIPTIONS_PATH}`;
	}

	async transcribe(audio: TranscriptionAudio): Promise<TranscriptionResult> {
		// Refuse on the STAT before reading a byte, where the caller had one. The cap is enforced
		// again while streaming (`readAudioWithLimit`) because a stat is a claim about the past.
		if (audio.sizeBytes !== undefined && audio.sizeBytes > this.env.maxBytes) {
			throw new TranscriptionFailure(
				`${audio.objectKey} is ${audio.sizeBytes} bytes, over TRANSCRIBE_MAX_BYTES ` +
					`(${this.env.maxBytes})`,
				{ retryable: false },
			);
		}

		const bytes = await readAudioWithLimit(await audio.open(), this.env.maxBytes);
		const body = this.buildForm(audio, bytes);

		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
		}, this.env.timeoutMs);

		let response: Awaited<ReturnType<TranscriptionFetch>>;
		try {
			response = await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers: this.buildHeaders(),
				body,
				signal: controller.signal,
			});
		} catch (error) {
			// A transport failure or our own abort. Both are transient by nature: DNS blips,
			// connection resets and a server that stopped answering are all things four seconds fixes
			// more often than they do not.
			throw new TranscriptionFailure(
				`the transcription endpoint could not be reached for ${audio.objectKey}`,
				{ retryable: true, cause: error },
			);
		} finally {
			clearTimeout(timer);
		}

		const text = await this.readBody(response, audio);
		if (!response.ok) {
			throw new TranscriptionFailure(
				`the transcription endpoint answered ${response.status} for ${audio.objectKey}: ` +
					// Bounded: a provider that answers an HTML error page must not put a kilobyte of
					// markup in every log line, and the first 300 characters always carry the message.
					truncate(text, 300),
				{ retryable: isRetryableStatus(response.status), status: response.status },
			);
		}

		return parseTranscriptionBody(text, audio.objectKey);
	}

	/**
	 * The multipart body.
	 *
	 * `file`, `model` and `response_format` are the three fields every compatible endpoint reads.
	 * The file NAME matters and is not decoration: whisper-family servers dispatch their decoder off
	 * the extension, and a part named `blob` (which is what a `Blob` with no name becomes) is
	 * rejected or mis-decoded by several of them. So the object key's own basename is used, which is
	 * already `<uuid>.wav`.
	 */
	private buildForm(audio: TranscriptionAudio, bytes: Buffer): FormData {
		const form = new FormData();
		form.append(
			"file",
			// `new Uint8Array(bytes)` rather than the Buffer directly: a Buffer is a view over a
			// pooled ArrayBuffer that may be much larger than the data, and handing that to Blob has
			// been observed to upload the pool's slack on some Node versions.
			new Blob([new Uint8Array(bytes)], { type: audio.contentType }),
			fileNameFor(audio.objectKey),
		);
		form.append("model", this.env.model as string);
		form.append("response_format", "verbose_json");
		const language = audio.languageHint ?? this.env.language;
		if (language !== undefined) {
			form.append("language", language);
		}
		return form;
	}

	/**
	 * The headers.
	 *
	 * No `content-type`: `fetch` sets it from the `FormData`, including the multipart boundary it
	 * generated, and setting it by hand is the classic way to produce a body no server can parse.
	 * No `authorization` when there is no key, rather than an empty bearer — a local whisper server
	 * has no auth, and `Authorization: Bearer ` is a malformed header rather than an absent one.
	 */
	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = { accept: "application/json" };
		if (this.env.apiKey !== undefined) {
			headers.authorization = `Bearer ${this.env.apiKey}`;
		}
		return headers;
	}

	/** Reading the body can itself fail on a truncated response; that is transient, not a parse bug. */
	private async readBody(
		response: Awaited<ReturnType<TranscriptionFetch>>,
		audio: TranscriptionAudio,
	): Promise<string> {
		try {
			return await response.text();
		} catch (error) {
			throw new TranscriptionFailure(
				`the transcription endpoint's response for ${audio.objectKey} could not be read`,
				{ retryable: true, status: response.status, cause: error },
			);
		}
	}
}

/** `408` / `409` / `429` and every `5xx`. See {@link RETRYABLE_STATUSES}. */
export function isRetryableStatus(status: number): boolean {
	return RETRYABLE_STATUSES.has(status) || status >= 500;
}

/**
 * Reads a transcription out of whatever shape the endpoint answered with.
 *
 * Three shapes are accepted and the tolerance is deliberate, because "OpenAI-compatible" is a
 * convention rather than a specification:
 *
 * - `{"text": "…", "language": "english", "duration": 12.5}` — `verbose_json`, from OpenAI and Groq.
 * - `{"text": "…"}` — `json`, from a server that ignored `response_format`.
 * - a bare string body — from a server that answered `text` regardless of what was asked.
 *
 * `duration` is SECONDS in every implementation of this API, floating point, and is converted here
 * rather than by the caller so a driver-specific unit never escapes the seam.
 *
 * A body with no readable text is a PERMANENT failure rather than an empty transcript: an endpoint
 * that answered 200 with a shape nothing here recognises is misconfigured, and recording `done`
 * with an empty string would bury that in a column. Note the distinction from a genuinely empty
 * `text` field, which IS a valid result — see {@link TranscriptionResult}.
 */
export function parseTranscriptionBody(body: string, objectKey: string): TranscriptionResult {
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		throw new TranscriptionFailure(
			`the transcription endpoint answered with an empty body for ${objectKey}`,
			{ retryable: true },
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// Not JSON at all: a `response_format=text` server. The body IS the transcript.
		return { text: trimmed };
	}

	if (typeof parsed === "string") {
		return { text: parsed };
	}
	if (parsed === null || typeof parsed !== "object") {
		throw new TranscriptionFailure(
			`the transcription endpoint answered ${typeof parsed} rather than a transcription ` +
				`for ${objectKey}`,
			{ retryable: false },
		);
	}

	const record = parsed as Record<string, unknown>;
	if (typeof record.text !== "string") {
		throw new TranscriptionFailure(
			`the transcription endpoint's response for ${objectKey} carries no \`text\` field`,
			{ retryable: false },
		);
	}

	const language = typeof record.language === "string" ? record.language : undefined;
	// Seconds on the wire, milliseconds in this system. Guarded against a NaN a provider could send.
	const duration =
		typeof record.duration === "number" && Number.isFinite(record.duration)
			? Math.round(record.duration * 1_000)
			: undefined;
	// Nothing in the OpenAI shape carries one; a few compatible servers add it, so it is read.
	const confidence =
		typeof record.confidence === "number" && Number.isFinite(record.confidence)
			? record.confidence
			: undefined;

	return {
		text: record.text,
		...(language === undefined ? {} : { language }),
		...(duration === undefined ? {} : { durationMs: duration }),
		...(confidence === undefined ? {} : { confidence }),
	};
}

/** The object key's basename, which is already `<uuid>.wav`. See {@link OpenAiTranscriptionProvider.buildForm}. */
function fileNameFor(objectKey: string): string {
	const base = objectKey.slice(objectKey.lastIndexOf("/") + 1);
	return base.length === 0 ? "voicemail.wav" : base;
}

function truncate(value: string, max: number): string {
	const collapsed = value.replace(/\s+/gu, " ").trim();
	return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}
