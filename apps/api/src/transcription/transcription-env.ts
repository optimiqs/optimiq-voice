import { z } from "zod/v4";

/**
 * Voicemail transcription's environment contract.
 *
 * Shaped after `storage-env.ts` and `mail-env.ts`, which are the two precedents: an optional
 * capability whose unconfigured state is legitimate and whose HALF-configured state is a boot
 * failure. The parallel is exact. A deployment that has set `TRANSCRIBE_API_KEY` and nothing else
 * believes its voicemails are being transcribed; without this schema it would find out from an
 * empty column six weeks later, and the difference between the two is one `superRefine`.
 *
 * `zod/v4` rather than `zod` for the reason `pbx-env.ts` records: this app still pins `zod@3.25.76`
 * and 3.25 ships the whole Zod 4 implementation under the `zod/v4` subpath.
 *
 * ## Unprefixed names, and why there is no `TRANSCRIBE_DRIVER`
 *
 * `TRANSCRIBE_*` carries no `API_` prefix on the same terms as `SMTP_*` and `STORAGE_DRIVER`:
 * speech-to-text is a platform capability, and the next process that wants one — a back-fill over
 * the messages filed while a provider was down, a future `apps/mediad` that transcribes on the way
 * past — must not have to read API-prefixed variables to find the endpoint the API is already using.
 *
 * There is deliberately **no `TRANSCRIBE_DRIVER`**, which is where this departs from `storage-env`,
 * and the reason is that the two capabilities have differently shaped defaults. `STORAGE_DRIVER`
 * has to be an explicit act because BOTH of its states are real deployments and the wrong one loses
 * recordings silently. Transcription has one real state and one absence: either an endpoint is
 * configured or the feature is off. A `TRANSCRIBE_DRIVER=openai-compatible` alongside
 * `TRANSCRIBE_BASE_URL` would be two sources for one fact and a subtle question about which wins.
 *
 * So `TRANSCRIBE_BASE_URL` **is** the switch. Setting it selects the `openai-compatible` driver;
 * leaving it unset selects `disabled`, which makes exactly zero external calls.
 *
 * ## What "half-configured" means here, in both directions
 *
 * - `TRANSCRIBE_BASE_URL` with no `TRANSCRIBE_MODEL` — refused. There is no defensible default
 *   model across OpenAI (`whisper-1`, `gpt-4o-transcribe`), Groq (`whisper-large-v3-turbo`) and a
 *   local whisper.cpp server (whatever it was launched with), and guessing one produces a 400 with
 *   a provider-specific message nobody can trace back to here.
 * - `TRANSCRIBE_MODEL` or `TRANSCRIBE_API_KEY` with no `TRANSCRIBE_BASE_URL` — refused. A model
 *   name with nowhere to send it, or worse a CREDENTIAL with nowhere to send it, is somebody who
 *   believes the feature is on. This is the direction that actually happens: an operator pastes a
 *   key from a provider's console and never reads the line above it.
 *
 * `TRANSCRIBE_API_KEY` is optional WITH a base URL, and that is not an oversight: a whisper.cpp or
 * faster-whisper server on the deployment's own network has no authentication, and requiring a key
 * would mean inventing one. That is the whole point of an OpenAI-COMPATIBLE endpoint rather than an
 * OpenAI one.
 */

/** An orchestrator that wants a variable off sets it to `""`; "absent" is not expressible in YAML. */
const optionalString = z.string().trim().min(1).optional().catch(undefined);

export const TRANSCRIPTION_DRIVERS = ["disabled", "openai-compatible"] as const;

export const transcriptionEnvSchema = z
	.object({
		/**
		 * The OpenAI-compatible base URL — the switch for the whole feature.
		 *
		 * `https://api.openai.com/v1` for OpenAI, `https://api.groq.com/openai/v1` for Groq,
		 * `http://whisper:8080/v1` for a local server. The transcriptions path is appended by the
		 * driver, so this is the `/v1` root and not the endpoint itself: every one of those three
		 * spells the endpoint `<base>/audio/transcriptions`, and putting the whole URL here would
		 * make a deployment that also wants translations later configure the host twice.
		 */
		TRANSCRIBE_BASE_URL: optionalString,

		/**
		 * The bearer token. Optional even WITH a base URL — a local whisper server has no auth.
		 *
		 * Refused without a base URL, because a credential pointed at nothing is the loudest
		 * available signal that somebody believes this feature is on.
		 */
		TRANSCRIBE_API_KEY: optionalString,

		/** The model. Required with a base URL; there is no cross-provider default and never will be. */
		TRANSCRIBE_MODEL: optionalString,

		/**
		 * A BCP-47 hint passed to the endpoint, e.g. `en`.
		 *
		 * Advisory and off by default: whisper-family models detect language well, and a deployment
		 * that pins `en` on a mailbox that receives Spanish gets confident nonsense rather than a
		 * detection. Set it only where the calls really are all one language.
		 */
		TRANSCRIBE_LANGUAGE: optionalString,

		/** Per-request timeout. A minute is generous for a five-minute message on a warm endpoint. */
		TRANSCRIBE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),

		/**
		 * The upload ceiling, defaulting to OpenAI's own documented 25 MB.
		 *
		 * Enforced in this process BEFORE the request, not by the endpoint after it: the object is
		 * read into memory to build the multipart body, so the cap is what stands between an
		 * unusually long message and the API's heap. See `readAudioWithLimit`.
		 */
		TRANSCRIBE_MAX_BYTES: z.coerce
			.number()
			.int()
			.min(1_024)
			.max(500 * 1_024 * 1_024)
			.default(25 * 1_024 * 1_024),

		/**
		 * How many times one message is attempted in total, including the first.
		 *
		 * Three, and bounded, because the failure being absorbed here is a transient one — a 429, a
		 * cold local server, a dropped connection. A provider that is genuinely down stays down for
		 * longer than any retry budget worth spending on the control plane's event loop, and the row
		 * is marked `failed` so a back-fill can find it rather than this process spinning.
		 */
		TRANSCRIBE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

		/** The first backoff. Doubles per attempt: 2s, 4s, 8s… See `TRANSCRIBE_MAX_BACKOFF_MS`. */
		TRANSCRIBE_RETRY_BASE_MS: z.coerce.number().int().min(0).max(600_000).default(2_000),

		/** The backoff ceiling, so a generous attempt count cannot become a long sleep. */
		TRANSCRIBE_MAX_BACKOFF_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),

		/**
		 * How many messages may wait for the worker before new ones are refused.
		 *
		 * Bounded because this queue is in memory and its job is to keep the JetStream consumer
		 * moving, not to be durable. A refusal leaves the row `pending` — which is a state a
		 * back-fill can find, and the reason `transcription_status` has four values rather than a
		 * nullable transcript. See `voicemail-transcription.service.ts`.
		 */
		TRANSCRIBE_QUEUE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(500),
	})
	.superRefine((value, context) => {
		const hasBaseUrl = value.TRANSCRIBE_BASE_URL !== undefined;
		if (hasBaseUrl && value.TRANSCRIBE_MODEL === undefined) {
			context.addIssue({
				code: "custom",
				path: ["TRANSCRIBE_MODEL"],
				message:
					"must be set when TRANSCRIBE_BASE_URL is; there is no default model that is correct " +
					"for OpenAI, Groq and a local whisper server at once",
			});
		}
		for (const name of ["TRANSCRIBE_MODEL", "TRANSCRIBE_API_KEY"] as const) {
			if (!hasBaseUrl && value[name] !== undefined) {
				context.addIssue({
					code: "custom",
					path: [name],
					message:
						"is set but TRANSCRIBE_BASE_URL is not, so nothing would ever be transcribed. " +
						"Set TRANSCRIBE_BASE_URL, or unset this to say transcription is off.",
				});
			}
		}
		if (value.TRANSCRIBE_MAX_BACKOFF_MS < value.TRANSCRIBE_RETRY_BASE_MS) {
			context.addIssue({
				code: "custom",
				path: ["TRANSCRIBE_MAX_BACKOFF_MS"],
				message:
					"must be at least TRANSCRIBE_RETRY_BASE_MS, or the first backoff is already capped",
			});
		}
	});

/** The parsed, resolved transcription configuration. */
export interface TranscriptionEnv {
	/** Normalised without a trailing slash, or `undefined` when the feature is off. */
	readonly baseUrl: string | undefined;
	readonly apiKey: string | undefined;
	readonly model: string | undefined;
	readonly language: string | undefined;
	readonly timeoutMs: number;
	readonly maxBytes: number;
	readonly maxAttempts: number;
	readonly retryBaseMs: number;
	readonly maxBackoffMs: number;
	readonly queueLimit: number;
}

/**
 * Parses the environment, throwing on a contract violation.
 *
 * Called from `main.ts` before `NestFactory.create` and from the PBX module's provider factory. A
 * half-configured endpoint must stop the process at boot rather than surface as a column that is
 * still empty after somebody's first week of expecting transcripts.
 */
export function loadTranscriptionEnv(source: NodeJS.ProcessEnv = process.env): TranscriptionEnv {
	const parsed = transcriptionEnvSchema.safeParse(source);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid transcription environment — ${detail}`);
	}
	const value = parsed.data;
	return {
		baseUrl: value.TRANSCRIBE_BASE_URL?.replace(/\/+$/u, ""),
		apiKey: value.TRANSCRIBE_API_KEY,
		model: value.TRANSCRIBE_MODEL,
		language: value.TRANSCRIBE_LANGUAGE,
		timeoutMs: value.TRANSCRIBE_TIMEOUT_MS,
		maxBytes: value.TRANSCRIBE_MAX_BYTES,
		maxAttempts: value.TRANSCRIBE_MAX_ATTEMPTS,
		retryBaseMs: value.TRANSCRIBE_RETRY_BASE_MS,
		maxBackoffMs: value.TRANSCRIBE_MAX_BACKOFF_MS,
		queueLimit: value.TRANSCRIBE_QUEUE_LIMIT,
	};
}

/**
 * Which driver this environment gets.
 *
 * The base URL is the switch and the ONLY switch — see this file's header for why there is no
 * `TRANSCRIBE_DRIVER`. `loadTranscriptionEnv` has already refused every half-configured shape by
 * the time this is called, so this is a presence check rather than a validation.
 */
export function selectTranscriptionDriver(
	env: TranscriptionEnv,
): (typeof TRANSCRIPTION_DRIVERS)[number] {
	return env.baseUrl === undefined ? "disabled" : "openai-compatible";
}

/** True when this environment can actually reach a transcription endpoint. */
export function isTranscriptionConfigured(env: TranscriptionEnv): boolean {
	return selectTranscriptionDriver(env) !== "disabled";
}

/**
 * The boot preflight.
 *
 * Deliberately NOT symmetrical with `assertStoragePreflight` and `assertMailPreflight`, and the
 * asymmetry is the point rather than an omission: those two refuse to boot a PRODUCTION process
 * that is missing a capability, because a production deployment that loses recordings or cannot
 * send a password reset is broken in a way its operator will not discover in time.
 *
 * A production deployment with no transcription is not broken. It is the default, it is what every
 * PBX did before this feature existed, and refusing to boot it would be this preflight inventing a
 * requirement — the same mistake `assertStoragePreflight` explicitly declines to make for
 * `driver=local`. So there is nothing to assert about the CONFIGURED state, and the half-configured
 * state is already refused at parse time in every environment, which is strictly stronger than
 * refusing it in production only.
 *
 * The function exists anyway so `main.ts` has one obvious place to call, and so that a later
 * production invariant (a deployment that has PAID for transcription and wants a boot failure
 * rather than a silent absence) has somewhere to go that is not a new function nobody calls.
 */
export function assertTranscriptionPreflight(env: TranscriptionEnv): void {
	// Parsing already refused everything refusable; see the note above.
	void env;
}
