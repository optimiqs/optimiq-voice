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

const requiredUrl = z
	.string()
	.min(1)
	.regex(/^https?:\/\//iu, "must be an http(s) URL, e.g. http://asterisk:8088");

const natsUrl = z
	.string()
	.min(1)
	.regex(/^nats:\/\//iu, "must be a nats:// URL, e.g. nats://nats:4222");

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
	ENGINE_DEFAULT_ORGANIZATION_ID: z.uuid().optional(),

	/** How long a drain waits for live channels before hanging the stragglers up. */
	ENGINE_DRAIN_TIMEOUT_MS: durationMs(30_000, 600_000),

	/**
	 * Optional media URI played to an answered inbound call, in the media server's vocabulary
	 * (`sound:unavailable`).
	 *
	 * A stand-in for the routing executor that lands in P3, and unset by default: a P2 engine that
	 * answers and then holds the line is honest about having no routing yet, whereas one that
	 * always plays a hard-coded prompt is a product decision made by a placeholder.
	 */
	ENGINE_INBOUND_ANNOUNCEMENT: z
		.string()
		.min(1)
		.optional()
		.transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim())),
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
