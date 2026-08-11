import { z } from "zod/v4";

/**
 * The PBX area's environment contract.
 *
 * Two notes on the imports and the scope of this file.
 *
 * `zod/v4` rather than `zod`: `apps/api` still pins `zod@3.25.76` for ~19 legacy files in
 * `src/voice` and `src/applications`, and 3.25 ships the whole Zod 4 implementation under the
 * `zod/v4` subpath. New code therefore gets the oikos-mandated Zod 4 API without a rewrite of code
 * this wave does not touch. When the pin moves to the catalog's `zod@4`, the subpath becomes the
 * bare specifier and nothing else changes.
 *
 * App-local rather than a slice of `@optimiq-voice/config`, for the reason `apps/engine` records:
 * that package owns the ROOT `.env` and its production invariants, not every service's variables.
 * This is the one place in the PBX area that may read `process.env` (oikos §6); everything else
 * injects the parsed {@link PbxEnv}.
 */

const postgresUrl = z
	.string()
	.min(1)
	.regex(/^postgres(?:ql)?:\/\//iu, "must be a postgres:// URL");

const natsUrl = z
	.string()
	.min(1)
	.regex(/^nats:\/\//iu, "must be a nats:// URL, e.g. nats://localhost:4222");

/**
 * One half of the broker credential, where the empty string means "explicitly none".
 *
 * Optional because a broker with no authentication is a real configuration here: the verify
 * harnesses and `test/` start their own throwaway `nats` container per run and never configure a
 * user on it. Production is not left to this schema — `assertEnvInvariants` refuses to boot a
 * production process whose broker URL is set without both of these.
 */
const natsCredential = z.preprocess(
	(value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
	z.string().min(1).optional(),
);

export const pbxEnvSchema = z.object({
	/**
	 * The telephony bounded context's database. Separate from `DATABASE_URL` (better-auth, the
	 * legacy telephony tables) because they are separate databases — plan §3.3.
	 */
	PBX_DATABASE_URL: postgresUrl,

	/**
	 * Optional by design. Absent means the routing-cache publish and the
	 * `rpc.routing.v1.resolve` responder are skipped with a boot warning, and every REST feature
	 * still works: a developer without a broker must still be able to run CRUD, and an API that
	 * refused to boot without NATS would make the control plane depend on the backbone for
	 * configuration changes that do not need it.
	 */
	NATS_URL: natsUrl.optional(),

	/**
	 * How every connection in this area authenticates to that broker.
	 *
	 * `NATS_API_USER` / `NATS_API_PASS` are this process's OWN identity: `config/nats.conf` gives
	 * the `api` user a subject allow-list built from what this area actually does — the three event
	 * families it publishes, the three RPC subjects it answers, the four KV buckets it owns and the
	 * two it only reads. It cannot publish a call event and cannot write the call path's buckets.
	 *
	 * `NATS_USER` / `NATS_PASS` remain as the FALLBACK, and are the operator identity: the `nats`
	 * CLI and the `pnpm verify:*` harnesses in `scripts/`. A deployment that has not split its
	 * credentials still works on them alone.
	 *
	 * `natsConnectionOptions(env, "api")` from `@optimiq-voice/config/nats-credentials` applies
	 * that precedence, adds the TLS options below, and refuses a half-set pair — per pair, so a
	 * typo in `NATS_API_PASS` stops the boot rather than silently demoting this process onto the
	 * operator credential.
	 */
	NATS_USER: natsCredential,
	NATS_PASS: natsCredential,
	NATS_API_USER: natsCredential,
	NATS_API_PASS: natsCredential,

	/**
	 * Broker transport security. Both optional, both off by default.
	 *
	 * `NATS_TLS_CA` is a path to a CA bundle: setting it enables TLS and pins that CA, which is
	 * the private-CA case (`config/certs/generate-dev-certs.sh`, and any deployment issuing its
	 * own). `NATS_TLS_ENABLED=true` is TLS against the system trust store. Neither set is a
	 * plaintext connection, which is what the shipped broker serves — its `tls` block lives in the
	 * `compose.tls.yaml` overlay, so client and broker default to plaintext together rather than
	 * half-agreeing.
	 */
	NATS_TLS_CA: z.string().min(1).optional(),
	NATS_TLS_ENABLED: z.string().optional(),

	/** Whether to create the `routing-cache` KV bucket if the broker does not have it yet. */
	PBX_ENSURE_KV_BUCKETS: z
		.stringbool({ truthy: ["true", "1"], falsy: ["false", "0", ""] })
		.default(true),

	/** Pool ceiling for the PBX pool specifically; the base client applies the shared budget. */
	PBX_DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),

	/**
	 * The projection outbox's sweeper — the safety net under the three KV publishes.
	 *
	 * See `shared/projection-outbox.ts` for what it is and `packages/pbx-db`'s `outbox-schema.ts`
	 * for why the table exists. The knobs are here rather than hard-coded because the right values
	 * depend on how much a deployment minds a stale bucket: the sweep interval is the WORST-CASE
	 * staleness after a crash, and the stuck threshold is how many failed rounds an operator wants
	 * to sit through before the logs start shouting.
	 *
	 * `PBX_OUTBOX_SWEEP_INTERVAL_MS` is deliberately not tiny. The fast path handles every healthy
	 * write, so a sweep that finds work is already an incident; polling every second would spend a
	 * connection a second to discover, almost always, that there is nothing to do.
	 *
	 * A sweep interval of `0` disables the sweeper entirely, for a process that must not do
	 * background work — a one-shot migration container, a test harness driving the module directly.
	 * The obligations are still recorded, so another process (or the next boot) discharges them.
	 */
	PBX_OUTBOX_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(15_000),
	/**
	 * The first retry delay after a failure; each further failure doubles it up to the cap.
	 *
	 * Its own variable rather than "the sweep interval", which is what it started as and which was
	 * wrong for a reason worth keeping written down: setting the interval to `0` to drive `sweep()`
	 * by hand also set the backoff base to `0`, so every failed group became due immediately and the
	 * backoff quietly stopped existing in exactly the configuration a harness uses to test it. Two
	 * concepts, two knobs.
	 */
	PBX_OUTBOX_BACKOFF_BASE_MS: z.coerce.number().int().min(1).max(3_600_000).default(15_000),
	/**
	 * The backoff cap. A broker that is restarting is back in seconds; a broker that is gone is gone
	 * for hours, and retrying it every fifteen seconds for those hours is a log nobody can read.
	 */
	PBX_OUTBOX_BACKOFF_CAP_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
	/**
	 * How many failed attempts make a row STUCK — logged at error with everything needed to act on
	 * it, on every sweep, until it clears. Five is roughly a minute of a restarting broker at the
	 * default interval and backoff, which is long enough not to page on a rolling NATS upgrade.
	 */
	PBX_OUTBOX_STUCK_ATTEMPTS: z.coerce.number().int().min(1).max(1000).default(5),
	/**
	 * How long a DISCHARGED row is kept before it is pruned.
	 *
	 * Kept at all — rather than deleted at the moment of publish — so an operator investigating "the
	 * engine had the wrong roster at 14:03" can see that the obligation existed and when it was
	 * met. Pending rows are never pruned by age: an obligation nothing has managed to discharge is
	 * exactly the row worth keeping.
	 */
	PBX_OUTBOX_RETENTION_HOURS: z.coerce.number().int().min(1).max(8760).default(24),

	/**
	 * How an extension number becomes a dial string in the media server's vocabulary.
	 *
	 * MUST match `apps/engine`'s `ENGINE_EXTENSION_DIAL_TEMPLATE`, and shares its default. The
	 * `queue-membership` bucket holds a resolved dial string per agent, not an extension number,
	 * because the engine hands it to the media server verbatim rather than re-deriving an endpoint
	 * from a number it cannot verify (see `packages/events` `queueMembershipAgentSchema`). Two
	 * templates that disagree produce a queue whose agents' phones never ring while every direct
	 * call to the same extension works — which is why this is stated here rather than assumed.
	 *
	 * A template rather than a hard-coded `PJSIP/` for the reason the engine records: the same code
	 * has to work against a registrar-backed deployment (`PJSIP/1001`) and a dialplan-mediated one
	 * (`Local/1001@context`).
	 */
	PBX_EXTENSION_DIAL_TEMPLATE: z.string().min(1).default("PJSIP/{number}"),

	/**
	 * Where voicemail audio lives, and the key that signs a link to it.
	 *
	 * Both DEFAULT to the CDR area's variables (see {@link loadPbxEnv}), and that is not laziness:
	 * there is one object store. `apps/engine` writes a voicemail recording into the same root it
	 * writes call recordings into, `ENGINE_MEDIA_OBJECT_ROOT` is documented as "mount the directory
	 * the API serves recordings from", and a deployment that had to configure a SECOND root would
	 * be configuring a second copy of the same directory — with the failure mode that voicemail
	 * playback 410s while call playback works, for a reason nothing in the UI can explain.
	 *
	 * They are nevertheless separate names, because the two areas mount independently: an API
	 * deployment with `PBX_DATABASE_URL` and no `CDR_DATABASE_URL` has mailboxes, has messages,
	 * and has no CDR area to inherit anything from. Naming them lets that deployment work, and lets
	 * an operator who genuinely does split the stores say so.
	 *
	 * Optional secret, exactly as in the CDR area: without a key the messages LIST still works —
	 * the metadata is not the media — and minting a playback URL fails with a named error rather
	 * than falling back to an unsigned route. There is no default key and there never will be one.
	 */
	PBX_VOICEMAIL_MEDIA_ROOT: z.string().min(1).default("/opt/optimiq-voice/recordings"),
	PBX_VOICEMAIL_URL_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
	PBX_VOICEMAIL_URL_SECRET_PREVIOUS: z
		.string()
		.min(32, "must be at least 32 characters")
		.optional(),
	/** How long a minted playback URL stays valid. Minutes, for the reasons the CDR area records. */
	PBX_VOICEMAIL_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

	/**
	 * How long the playback link inside a voicemail NOTIFICATION stays valid.
	 *
	 * Its own knob, and a much longer default, because the threat model is different from the web
	 * UI's. A link minted for a signed-in admin who is looking at the screen needs to outlive one
	 * click, and five minutes is generous for that — the browser can always mint another. A link in
	 * an email has no way to mint another: the recipient reads their mail when they read it, and a
	 * link that expired while it sat in an inbox is a notification that tells somebody they have a
	 * voicemail and then refuses to play it.
	 *
	 * Twenty-four hours by default, capped at seven days. The token is still signed, still carries
	 * the message id and the organization INSIDE the signature (so there is nothing to enumerate),
	 * still verified against the tenant's RLS scope before a byte is read, and still revocable in
	 * bulk by rotating `PBX_VOICEMAIL_URL_SECRET`. What a longer TTL costs is the window in which a
	 * forwarded email lets its new holder hear one message — which is the same thing forwarding an
	 * ATTACHED recording would cost, permanently, and this is the reason the notification carries a
	 * link rather than the audio.
	 */
	PBX_VOICEMAIL_EMAIL_URL_TTL_SECONDS: z.coerce
		.number()
		.int()
		.min(300)
		.max(7 * 24 * 3600)
		.default(24 * 3600),

	/**
	 * Where the media LIBRARY writes uploads: MOH files, prompts and voicemail greetings.
	 *
	 * Defaults to `PBX_VOICEMAIL_MEDIA_ROOT` (which itself defaults to `CDR_RECORDING_ROOT`) for
	 * the reason those two share a default: **there is one object store**, and the media server
	 * mounts it once as `ENGINE_MEDIA_OBJECT_ROOT`. The compiler embeds a greeting as
	 * `object://<objectKey>` and `apps/engine` renders that as
	 * `sound:<ENGINE_MEDIA_OBJECT_ROOT>/<key>`, so an upload written anywhere else is an upload the
	 * media server cannot find — a prompt that exists, has a row, has a working preview in the
	 * admin UI, and plays as silence on a call.
	 *
	 * It is nevertheless a NAME of its own, on the same terms as the voicemail root: an operator
	 * who genuinely splits the stores can say so, and a deployment with the PBX area but no CDR
	 * area has somewhere to inherit from.
	 */
	PBX_MEDIA_OBJECT_ROOT: z.string().min(1).default("/opt/optimiq-voice/recordings"),

	/**
	 * The upload size cap, in bytes. 10 MiB by default.
	 *
	 * Chosen against the format that has to work everywhere rather than against a disk budget: ten
	 * minutes of 8 kHz mono 16-bit PCM WAV is about 9.6 MB, and ten minutes is already a very long
	 * prompt. An MP3 at that size is hours. The cap is here to bound what one request can make this
	 * process hold in memory (`media-upload.ts` buffers before it validates), not to ration storage
	 * — which is why raising it is a deliberate act with a stated cost rather than a knob.
	 */
	PBX_MEDIA_MAX_UPLOAD_BYTES: z.coerce
		.number()
		.int()
		.min(1024)
		.max(200 * 1024 * 1024)
		.default(10 * 1024 * 1024),
});

export type PbxEnv = z.infer<typeof pbxEnvSchema>;

/** Whether the area is configured at all. `main.ts` skips the module entirely when it is not. */
export function isPbxSliceConfigured(): boolean {
	return (
		typeof process.env.PBX_DATABASE_URL === "string" && process.env.PBX_DATABASE_URL.length > 0
	);
}

/**
 * Parses the environment, throwing on a contract violation.
 *
 * Called from the module factory, which Nest builds during `NestFactory.create` — before any
 * request can arrive. A malformed `PBX_DATABASE_URL` must stop the process at boot, not surface as
 * a 500 on the first extension list.
 */
export function loadPbxEnv(source: NodeJS.ProcessEnv = process.env): PbxEnv {
	const parsed = pbxEnvSchema.safeParse(withMediaFallbacks(source));
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid PBX environment — ${detail}`);
	}
	return parsed.data;
}

/**
 * Fills the voicemail media variables from the CDR area's when they are not set explicitly.
 *
 * A read-only overlay rather than a mutation of `process.env`, so the fallback is visible in one
 * function and cannot surprise anything else that reads the environment. An empty string counts as
 * "not set", for the reason `cdr-env.ts` records at length: an orchestrator that wants to turn a
 * variable off sets it to `""`, because "absent" is not a thing `docker compose` can express.
 */
function withMediaFallbacks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const pick = (primary: string, fallback: string): string | undefined => {
		const own = source[primary];
		if (typeof own === "string" && own.trim().length > 0) {
			return own;
		}
		const inherited = source[fallback];
		return typeof inherited === "string" && inherited.trim().length > 0 ? inherited : undefined;
	};

	const overlay: Record<string, string | undefined> = {
		PBX_VOICEMAIL_MEDIA_ROOT: pick("PBX_VOICEMAIL_MEDIA_ROOT", "CDR_RECORDING_ROOT"),
		PBX_VOICEMAIL_URL_SECRET: pick("PBX_VOICEMAIL_URL_SECRET", "CDR_RECORDING_URL_SECRET"),
		PBX_VOICEMAIL_URL_SECRET_PREVIOUS: pick(
			"PBX_VOICEMAIL_URL_SECRET_PREVIOUS",
			"CDR_RECORDING_URL_SECRET_PREVIOUS",
		),
		PBX_VOICEMAIL_URL_TTL_SECONDS: pick(
			"PBX_VOICEMAIL_URL_TTL_SECONDS",
			"CDR_RECORDING_URL_TTL_SECONDS",
		),
		// Two hops, in order: the library's own root, then the voicemail root, then the CDR root.
		// `pick` is applied twice rather than given three names because the middle one has its own
		// fallback and duplicating that here is how the two would eventually disagree.
		PBX_MEDIA_OBJECT_ROOT:
			pick("PBX_MEDIA_OBJECT_ROOT", "PBX_VOICEMAIL_MEDIA_ROOT") ??
			pick("PBX_MEDIA_OBJECT_ROOT", "CDR_RECORDING_ROOT"),
	};

	const merged: NodeJS.ProcessEnv = { ...source };
	for (const [key, value] of Object.entries(overlay)) {
		if (value === undefined) {
			delete merged[key];
		} else {
			merged[key] = value;
		}
	}
	return merged;
}
