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

		/**
		 * How often the back-fill runs. `0` disables it in this process.
		 *
		 * Five minutes rather than seconds because a sweep that finds work is already an anomaly — the
		 * in-memory queue handles every message on a healthy process — and the thing it recovers from
		 * (a restart, an overflow, a provider that was down for an hour) is not measured in seconds
		 * either. The one case where the interval IS user-visible is a deferred notification whose
		 * process died before it could send, and `TRANSCRIBE_EMAIL_WAIT_MS` bounds that separately.
		 *
		 * `0` exists for the same reason `PBX_OUTBOX_SWEEP_INTERVAL_MS`'s does: a one-shot container
		 * or a test harness driving `sweep()` by hand must not also have a timer running.
		 */
		TRANSCRIBE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).max(86_400_000).default(300_000),

		/**
		 * How old a `pending` row must be before the back-fill will take it.
		 *
		 * This is the whole of the "do not steal a message the live queue is holding" argument that
		 * does not depend on being in the same process. A row is marked `pending` by the INSERT and
		 * enqueued milliseconds later by the process that filed it, so anything younger than the grace
		 * window is overwhelmingly likely to be in somebody's queue right now. Two minutes is longer
		 * than a healthy transcription takes (a 60s per-request timeout, three attempts, mostly
		 * finishing on the first) and short enough that a lost message is not lost for long.
		 *
		 * It is a heuristic, and it is deliberately not the only guard: the sweeper also excludes the
		 * ids its own process is holding, the claim column excludes the ones another replica took, and
		 * `markDone`/`markFailed` are guarded on `transcription_status = 'pending'` so even a genuine
		 * double-transcription writes once. What the window buys is that the expensive half — the
		 * provider request — is not paid twice on the ordinary path.
		 */
		TRANSCRIBE_SWEEP_GRACE_MS: z.coerce.number().int().min(0).max(86_400_000).default(120_000),

		/**
		 * How long a `failed` row waits before the back-fill tries it again.
		 *
		 * An hour, because `failed` means a provider already refused this message three times with
		 * backoff. Retrying at the sweep interval would turn a five-minute outage into a permanent
		 * request storm against an endpoint that is telling the system to stop; an hour is roughly
		 * "somebody has had a chance to fix it", and an operator who has just fixed it does not have to
		 * wait — restarting the process or lowering this variable picks the cohort up immediately.
		 */
		TRANSCRIBE_SWEEP_RETRY_AFTER_MS: z.coerce
			.number()
			.int()
			.min(0)
			.max(30 * 86_400_000)
			.default(3_600_000),

		/**
		 * How long a claim is honoured before another sweep may take the row.
		 *
		 * The claim is never released explicitly — see `voicemail-schema.ts` — because the failure it
		 * exists for is a process that stopped existing, and a crashed process releases nothing. So
		 * this is the answer to "how long may a dead worker keep a message hostage", and it has to be
		 * comfortably longer than the worst legitimate transcription (`TRANSCRIBE_TIMEOUT_MS` ×
		 * `TRANSCRIBE_MAX_ATTEMPTS` plus backoff) or a slow provider becomes a duplicate-work machine.
		 */
		TRANSCRIBE_SWEEP_CLAIM_TTL_MS: z.coerce
			.number()
			.int()
			.min(1_000)
			.max(86_400_000)
			.default(900_000),

		/**
		 * How many times one message may be CLAIMED before `failed` becomes terminal.
		 *
		 * The ceiling that stops the back-fill being an infinite retry loop wearing a schedule. Past
		 * it the row keeps its `failed` status, stops being eligible, and stays visible to an operator
		 * through the same status column — which is the honest outcome for a message whose audio a
		 * provider is never going to accept. Five claims at an hour apart is most of a working day of
		 * trying.
		 */
		TRANSCRIBE_SWEEP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(1_000).default(5),

		/** How many messages one sweep claims. Bounded so a long outage is drained over several passes. */
		TRANSCRIBE_SWEEP_BATCH: z.coerce.number().int().min(1).max(10_000).default(100),

		/**
		 * How long a DEFERRED voicemail notification waits for a transcript before it goes without one.
		 *
		 * Only meaningful when the organization has `voicemailToEmailIncludeTranscription` on AND the
		 * mailbox has transcription enabled; see `voicemail-consumer.service.ts` for why those two are
		 * what switch deferral on. When the budget expires the mail is sent anyway, carrying
		 * `[transcription unavailable]` in place of the text — a late voicemail notification is a much
		 * worse outcome than one without a transcript, and both are better than a notification that
		 * never arrives because a provider is wedged.
		 *
		 * Ninety seconds is a little over the default per-request timeout, so a single slow-but-working
		 * transcription still makes it into the mail while a genuinely stuck one does not hold it.
		 */
		TRANSCRIBE_EMAIL_WAIT_MS: z.coerce.number().int().min(0).max(3_600_000).default(90_000),
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
		if (value.TRANSCRIBE_SWEEP_CLAIM_TTL_MS < value.TRANSCRIBE_TIMEOUT_MS) {
			// A claim that expires before a single request can finish is not a claim: the back-fill
			// would take back every message that is currently being transcribed and pay the provider
			// twice for all of them. Refused at parse time because the symptom — a doubled bill and
			// duplicate work on a system that otherwise looks healthy — is not one anybody traces back
			// to a timeout variable.
			context.addIssue({
				code: "custom",
				path: ["TRANSCRIBE_SWEEP_CLAIM_TTL_MS"],
				message:
					"must be at least TRANSCRIBE_TIMEOUT_MS, or the back-fill reclaims messages that are " +
					"still being transcribed",
			});
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
	/** `0` disables the back-fill in this process. */
	readonly sweepIntervalMs: number;
	readonly sweepGraceMs: number;
	readonly sweepRetryAfterMs: number;
	readonly sweepClaimTtlMs: number;
	readonly sweepMaxAttempts: number;
	readonly sweepBatch: number;
	readonly emailWaitMs: number;
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
		sweepIntervalMs: value.TRANSCRIBE_SWEEP_INTERVAL_MS,
		sweepGraceMs: value.TRANSCRIBE_SWEEP_GRACE_MS,
		sweepRetryAfterMs: value.TRANSCRIBE_SWEEP_RETRY_AFTER_MS,
		sweepClaimTtlMs: value.TRANSCRIBE_SWEEP_CLAIM_TTL_MS,
		sweepMaxAttempts: value.TRANSCRIBE_SWEEP_MAX_ATTEMPTS,
		sweepBatch: value.TRANSCRIBE_SWEEP_BATCH,
		emailWaitMs: value.TRANSCRIBE_EMAIL_WAIT_MS,
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
