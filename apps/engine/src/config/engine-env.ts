import { z } from "zod";
// Imported for its SIDE EFFECT: `@optimiq-voice/config` loads the root `.env` and hydrates
// `APP_ENV_CONTENT` from a secret manager into `process.env`. That work must happen exactly once
// and is not duplicated here.
import "@optimiq-voice/config";

/**
 * The engine's environment contract.
 *
 * ## Why this is app-local and not a slice of `@optimiq-voice/config`
 *
 * That package owns the ROOT `.env` — loading, secret-manager hydration, and the production
 * invariants. What it does NOT do is put every service's variables in one schema. The engine's
 * contract is ~15 variables that only the engine reads, and a service that cannot start without
 * them should say so in its own module rather than widening a repository-global object every other
 * app also parses. Adding `ENGINE_*` to the shared schema would also make one file the merge point
 * for every service team at once.
 *
 * This is the engine's config module, and therefore the one place in the app that may read
 * `process.env` (oikos §6). Everything else injects the parsed {@link EngineEnv}.
 *
 * The failure mode is deliberate: `loadEngineEnv()` throws, and `main.ts` calls it before
 * `NestFactory.create`. A missing ARI password must stop the process at boot, not surface as a
 * `401` on the first inbound call.
 */

/**
 * Treats an empty string as "not set".
 *
 * Docker Compose's `${VAR:-}` interpolation writes an EMPTY STRING when the variable is absent, so
 * an optional variable declared in `compose.yaml` arrives as `""` rather than as missing. Without
 * this, a deployment that simply has no default organization fails to boot on the value it does not
 * have — which is the opposite of what "optional" means.
 */
function emptyAsUnset(value: unknown): unknown {
	return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const requiredUrl = z
	.string()
	.min(1)
	.regex(/^https?:\/\//iu, "must be an http(s) URL, e.g. http://asterisk:8088");

const natsUrl = z
	.string()
	.min(1)
	.regex(/^nats:\/\//iu, "must be a nats:// URL, e.g. nats://nats:4222");

/** An optional secret where the empty string means "explicitly none", not "invalid". */
const optionalCredential = z.preprocess(emptyAsUnset, z.string().min(1).optional());

const port = (fallback: number) => z.coerce.number().int().min(1).max(65_535).default(fallback);

const durationMs = (fallback: number, max: number) =>
	z.coerce.number().int().min(0).max(max).default(fallback);

export const engineEnvSchema = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

	/** HTTP port for `/healthz`. The engine serves no product API. */
	ENGINE_PORT: port(4010),
	ENGINE_HOST: z.string().min(1).default("0.0.0.0"),

	// ---- Asterisk ARI --------------------------------------------------------------------
	ARI_URL: requiredUrl.default("http://localhost:8088"),
	ARI_USERNAME: z.string().min(1).default("ari"),
	ARI_PASSWORD: z.string().min(1),
	/** The Stasis application the dialplan hands channels to (`Stasis(optimiq-engine)`). */
	ARI_APP: z.string().min(1).default("optimiq-engine"),
	/**
	 * Whether to receive events for channels outside this application. Defaults to `false`: on a
	 * shared media server, `true` means one engine sees every tenant's channels.
	 */
	ARI_SUBSCRIBE_ALL: z
		.stringbool({ truthy: ["true", "1"], falsy: ["false", "0", ""] })
		.default(false),
	ARI_REQUEST_TIMEOUT_MS: durationMs(10_000, 120_000),

	// ---- NATS ----------------------------------------------------------------------------
	NATS_URL: natsUrl.default("nats://localhost:4222"),
	/**
	 * How every connection this app opens authenticates to that broker — see `config/nats.conf`.
	 *
	 * `NATS_ENGINE_USER` / `NATS_ENGINE_PASS` are this process's OWN identity, and the one the
	 * broker's `engine` permission set is written for: the call and queue vocabulary, CDR legs and
	 * voicemail deposits, the routing and media RPCs it CALLS, and the call path's four KV
	 * buckets. It cannot answer an RPC, cannot publish registration events, and cannot write
	 * `routing-cache`, `did-index` or `queue-membership` — a bug on the call path cannot rewrite a
	 * tenant's dial plan.
	 *
	 * `NATS_USER` / `NATS_PASS` remain as the fallback, and are now the operator identity.
	 *
	 * All four optional because a broker with no authentication is a real configuration: `test/`
	 * starts a throwaway `nats` container per run and never configures a user on it. Production is
	 * not left to this schema — `assertEnvInvariants` in `@optimiq-voice/config` refuses to boot a
	 * production process whose broker URL is set without both of the unprefixed pair.
	 *
	 * Kept out of the URL because `/healthz` and the boot log both report the URL the engine
	 * connected to; a `nats://user:pass@host` would put the password in both.
	 */
	NATS_USER: optionalCredential,
	NATS_PASS: optionalCredential,
	NATS_ENGINE_USER: optionalCredential,
	NATS_ENGINE_PASS: optionalCredential,
	/**
	 * Broker transport security. Off unless set, so a bare `nats://` development broker keeps
	 * working with no variables at all — which is what `test/` and `pnpm start:services` run.
	 *
	 * `NATS_TLS_CA` is a CA bundle path: it enables TLS and PINS that CA, which is what the
	 * development certificates from `config/certs/generate-dev-certs.sh` need.
	 * `NATS_TLS_ENABLED=true` is TLS against the system trust store instead.
	 */
	NATS_TLS_CA: z.string().min(1).optional(),
	NATS_TLS_ENABLED: z.string().optional(),
	/**
	 * Whether this instance applies the JetStream stream/KV definitions at boot. Safe to leave on
	 * — `ensureStreams` is idempotent — but a deployment that runs the definitions as a migration
	 * job turns it off so a rolling restart cannot reconcile a stream mid-deploy.
	 */
	ENGINE_ENSURE_STREAMS: z
		.stringbool({ truthy: ["true", "1"], falsy: ["false", "0", ""] })
		.default(true),

	// ---- Call handling -------------------------------------------------------------------
	/**
	 * Fallback organization for a channel that arrives without an `OPTIMIQ_ORG_ID` variable.
	 *
	 * Intended for single-tenant development only. In production it is unset, and an
	 * unattributable call is REJECTED rather than filed under a guess: a mis-attributed CDR is a
	 * billing error and a tenant-isolation breach, and neither is worth a completed test call.
	 */
	ENGINE_DEFAULT_ORGANIZATION_ID: z.preprocess(emptyAsUnset, z.uuid().optional()),

	/** How long a drain waits for live channels before hanging the stragglers up. */
	ENGINE_DRAIN_TIMEOUT_MS: durationMs(30_000, 600_000),

	/**
	 * Optional media URI played to an answered inbound call, in the media server's vocabulary
	 * (`sound:unavailable`).
	 *
	 * The pre-routing stand-in. It is only used when the call produced NO execution plan — with
	 * routing enabled and an artifact present, the plan decides what the caller hears, and an
	 * announcement that played over it would be a product decision made by a placeholder.
	 */
	ENGINE_INBOUND_ANNOUNCEMENT: z
		.string()
		.min(1)
		.optional()
		.transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim())),

	// ---- Routing -------------------------------------------------------------------------
	/**
	 * Whether inbound calls are routed through the compiled routing artifact.
	 *
	 * On by default. Turning it off leaves the pre-routing behaviour (ring, answer, optional
	 * announcement) in place, which is the fallback for a deployment whose control plane is not
	 * up yet — not a supported production mode.
	 */
	ENGINE_ROUTING_ENABLED: z
		.stringbool({ truthy: ["true", "1"], falsy: ["false", "0", ""] })
		.default(true),

	/**
	 * Deadline for `rpc.routing.v1.resolve`, the cache-miss path.
	 *
	 * The contract in `packages/events` suggests 2 s and this matches it: these calls sit between
	 * an INVITE and a ringing phone, so slow is the same as broken.
	 */
	ENGINE_ROUTING_RPC_TIMEOUT_MS: durationMs(2_000, 30_000),

	/**
	 * How an extension NUMBER becomes a dialable endpoint. `{number}` is substituted.
	 *
	 * A template rather than a hard-coded `PJSIP/` because the same engine has to work against a
	 * registrar-backed deployment (`PJSIP/1001`) and against a dialplan-mediated one
	 * (`Local/1001@optimiq-internal`), and which one a site uses is deployment, not code.
	 */
	ENGINE_EXTENSION_DIAL_TEMPLATE: z.string().min(1).default("PJSIP/{number}"),

	/** How a trunk attempt becomes an endpoint. `{number}` and `{trunk}` are substituted. */
	ENGINE_TRUNK_DIAL_TEMPLATE: z.string().min(1).default("PJSIP/{number}@{trunk}"),

	/** Ring time used when neither the plan node nor the ring-group member specifies one. */
	ENGINE_DEFAULT_RING_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(600).default(30),

	/** Prefix a bare prompt id is rendered under, e.g. `sound:prompts/`. */
	ENGINE_PROMPT_MEDIA_PREFIX: z.string().min(1).default("sound:"),

	/** Played when a plan names audio this release cannot resolve, and by the unimplemented kinds. */
	ENGINE_UNAVAILABLE_ANNOUNCEMENT: z.string().min(1).default("sound:unavailable"),

	/** Played before a voicemail recording starts, when the box has no greeting of its own. */
	ENGINE_VOICEMAIL_GREETING: z.string().min(1).default("sound:unavailable"),

	/**
	 * Absolute path, INSIDE the media server, at which the object store is mounted.
	 *
	 * The compiler embeds a voicemail greeting as `object://<objectKey>` and a voicemail message
	 * arrives from the read model the same way. **ARI has no HTTP media scheme** — `play` takes
	 * `sound:`, `recording:`, `number:`, `digits:`, `characters:`, `tone:` and nothing else — so the
	 * only way an object becomes playable is for the store to be visible to Asterisk as a
	 * filesystem, at which point `sound:<absolute path>` works.
	 *
	 * Empty (the default, and the state of this repo's compose stack, which mounts no such volume)
	 * means those refs resolve to nothing and the engine falls back to
	 * `ENGINE_VOICEMAIL_GREETING` / `ENGINE_UNAVAILABLE_ANNOUNCEMENT`, saying so in the walk notes.
	 * Deploying per-box greetings therefore means mounting the same directory the API serves
	 * recordings from (`CDR_RECORDING_ROOT`) into the Asterisk container and pointing this at it.
	 */
	ENGINE_MEDIA_OBJECT_ROOT: z.string().default(""),

	/** Asked for before a mailbox that has a PIN is opened. In Asterisk's core sound package. */
	ENGINE_VOICEMAIL_PIN_PROMPT: z.string().min(1).default("sound:vm-password"),

	/** Played after a wrong PIN, before the next attempt. Also core. */
	ENGINE_VOICEMAIL_PIN_INVALID_PROMPT: z.string().min(1).default("sound:vm-incorrect"),

	/** PIN attempts before the call is refused. A four-digit secret needs a lockout. */
	ENGINE_VOICEMAIL_PIN_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

	/** How long to wait for a control digit after a voicemail message finishes playing. */
	ENGINE_VOICEMAIL_MENU_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),

	/** Deadline for `rpc.voicemail.v1.list`. The caller is already connected and listening. */
	ENGINE_VOICEMAIL_RPC_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3_000),

	/** Container voicemail is recorded in. `wav` is what every downstream tool can already read. */
	ENGINE_RECORDING_FORMAT: z.enum(["wav", "gsm", "ulaw", "alaw", "g722"]).default("wav"),

	/**
	 * This process's identity in the shared park and conference claims.
	 *
	 * Written into every claim, and the thing that decides whether a claim is this instance's to
	 * release or renew. It must be UNIQUE per running process and STABLE for that process's life: two
	 * instances sharing an id would each believe they own the other's orbits, which is exactly the
	 * state the claims exist to make impossible.
	 *
	 * Defaulted rather than required because an operator who does not set it should still get a
	 * working single-instance deployment. `main.ts` fills it from the container's hostname when the
	 * variable is unset, which is unique per replica under every orchestrator worth the name.
	 */
	ENGINE_INSTANCE_ID: z.string().min(1).max(128).default("engine"),

	/**
	 * How often this process pushes its claims' expiry forward.
	 *
	 * A third of the claim lease, so a claim survives two missed heartbeats — a broker blip must not
	 * cost a tenant an orbit that is holding a live caller.
	 */
	ENGINE_CLAIM_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),

	/**
	 * Which media plane this engine drives.
	 *
	 * `ari` is Asterisk through `packages/media-ari` and is the DEFAULT, deliberately and for as
	 * long as the capability ladder in `plans/mediad-design.md` §2 is unfinished. Every rung
	 * `mediad` has not reached is a rung Asterisk still serves, so a deployment that does not opt in
	 * gets exactly the behaviour it had before this variable existed.
	 *
	 * `mediad` routes the media plane to `apps/mediad` over `rpc.media.v1.*`. It serves rung 2 —
	 * bridged G.711 calls with RFC 4733 DTMF — and REFUSES, loudly and by name, every operation
	 * above that. See `MediadMediaPort` for the coverage map and for why a not-supported operation
	 * throws rather than no-ops.
	 *
	 * Per capability rather than per service is the plan's sequencing rule (§3.4), and this variable
	 * is the coarse half of it: an operator picks a media plane per deployment, which makes the
	 * cutover revertible by configuration rather than by a rollback.
	 */
	ENGINE_MEDIA_DRIVER: z.enum(["ari", "mediad"]).default("ari"),

	/**
	 * How long the engine waits for a `mediad` reply.
	 *
	 * Matched to the contract's own suggested deadline (`MEDIA_ALLOCATE_SESSION_RPC.timeoutMs`), and
	 * exposed because the number that is right on a loopback compose file is not the number that is
	 * right across an availability zone. It stays SHORT on purpose: every one of these sits inside
	 * a call setup, where the caller hears the delay as silence before ringback, and a reply slower
	 * than the deadline means the instance is sick rather than busy.
	 */
	ENGINE_MEDIAD_RPC_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(500),
});

export type EngineEnv = z.infer<typeof engineEnvSchema>;

/**
 * Parses and validates the engine's environment.
 *
 * @throws {Error} listing every invalid variable at once — a boot that fails one variable at a
 * time across three restarts is how a deploy window gets spent.
 */
export function loadEngineEnv(source: Readonly<Record<string, string>> = envSource()): EngineEnv {
	const parsed = engineEnvSchema.safeParse(source);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid engine environment: ${issues}`);
	}
	return parsed.data;
}

/**
 * The variables to parse.
 *
 * Read live from `process.env` rather than from a snapshot taken when `@optimiq-voice/config` was
 * imported. The hydration that package performs writes INTO `process.env`, so this view is a
 * superset of its snapshot — and, unlike the snapshot, it also sees variables set after that
 * import by a process manager or a test harness, which is precisely the case the integration suite
 * depends on.
 */
function envSource(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
}
