import { z } from "zod/v4";

/**
 * The mail area's environment contract.
 *
 * App-local rather than a slice of `@optimiq-voice/config`, on the same terms as `pbx-env.ts`:
 * that package owns the ROOT `.env` and its production invariants, not every area's variables.
 * This is the one place in `src/mail` that may read `process.env`; everything else injects the
 * parsed {@link MailEnv}.
 *
 * ## Two generations of names, one contract
 *
 * The canonical names are unprefixed — `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
 * `SMTP_PASS`, `MAIL_FROM` — because mail is not an `apps/api` feature, it is a platform capability
 * and the next process that needs it should not have to read `API_`-prefixed variables to find it.
 *
 * The `API_SMTP_*` family predates this module and is what `compose.yaml` passes into the API
 * container today, so every canonical name FALLS BACK to its legacy counterpart (see
 * {@link withLegacyFallbacks}). A deployment that has never heard of `SMTP_HOST` keeps working; a
 * deployment that sets both gets the canonical one. There is deliberately no third name and no
 * silent merge: one variable wins, and which one is stated in one function.
 *
 * ## Unconfigured is a legitimate state, but only outside production
 *
 * Without `SMTP_HOST` / `MAIL_FROM` the area still mounts and every message is RENDERED and
 * LOGGED in full, one-time links included, so a developer can complete a verification or an
 * invitation locally without running a relay. That fallback is a development affordance and
 * nothing else: {@link assertMailPreflight} refuses to boot a `NODE_ENV=production` process that
 * would take it, because a production deployment silently logging password-reset links instead of
 * sending them is the failure mode this whole module exists to remove.
 */

const optionalString = z
	.string()
	.trim()
	.min(1)
	.optional()
	// An orchestrator that wants a variable off sets it to `""` — "absent" is not a thing a compose
	// file can express — so an empty string is "not set" everywhere in this schema.
	.catch(undefined);

export const mailEnvSchema = z.object({
	/** The relay's hostname. Absent selects the logging transport. */
	SMTP_HOST: optionalString,
	SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
	/**
	 * Implicit TLS (SMTPS, normally port 465) rather than STARTTLS on a plaintext port.
	 *
	 * Defaulted from the port instead of to a constant: 465 is implicit TLS by definition and 587
	 * is STARTTLS by definition, so an operator who sets only `SMTP_PORT=465` gets a working
	 * configuration rather than a handshake error. See {@link loadMailEnv}.
	 */
	SMTP_SECURE: z.stringbool({ truthy: ["true", "1"], falsy: ["false", "0"] }).optional(),
	SMTP_USER: optionalString,
	SMTP_PASS: optionalString,
	/**
	 * The envelope sender. `"Optimiq Voice <no-reply@example.com>"` or a bare address.
	 *
	 * Required for a real send and has no default: guessing a From address produces mail that a
	 * receiving domain rejects for a reason nothing in this process can see.
	 */
	MAIL_FROM: optionalString,
	/** Optional `Reply-To`, for a deployment whose `MAIL_FROM` is an unmonitored mailbox. */
	MAIL_REPLY_TO: optionalString,
	/**
	 * Where a link in a message points — the web app, not the API.
	 *
	 * Falls back to `API_APP_URL`, which is what the auth slice already builds invitation and
	 * password-reset links against. Two names for one origin would eventually disagree, and the one
	 * that disagreed would be the one in the email nobody tested.
	 */
	MAIL_APP_URL: optionalString,
	/** Connection/greeting/socket timeout for the relay, in milliseconds. */
	SMTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
});

export type MailEnvInput = z.infer<typeof mailEnvSchema>;

/** The parsed, resolved mail configuration. */
export interface MailEnv {
	readonly host: string | undefined;
	readonly port: number;
	readonly secure: boolean;
	readonly user: string | undefined;
	readonly pass: string | undefined;
	readonly from: string | undefined;
	readonly replyTo: string | undefined;
	readonly appUrl: string | undefined;
	readonly timeoutMs: number;
}

/** Raised at boot when a production process would fall back to logging instead of sending. */
export class MailConfigurationFailure extends Error {
	readonly _tag = "MailConfigurationFailure" as const;
	readonly missing: readonly string[];

	constructor(missing: readonly string[]) {
		super(
			`Mail delivery cannot start in production: ${missing.join(", ")} must be set. ` +
				"Without them every verification, password-reset and invitation message would be " +
				"written to the log instead of sent, one-time links included. Set them in the root " +
				".env (or the legacy API_SMTP_* names) before starting this process.",
		);
		this.name = "MailConfigurationFailure";
		this.missing = missing;
	}
}

/**
 * The legacy name each canonical one falls back to.
 *
 * Exported so a test can assert the pairing rather than restate it, and so the answer to "which
 * variable does this deployment actually read?" is one greppable table.
 */
export const MAIL_LEGACY_ENV_ALIASES: Readonly<Record<string, string>> = {
	SMTP_HOST: "API_SMTP_HOST",
	SMTP_PORT: "API_SMTP_PORT",
	SMTP_SECURE: "API_SMTP_SECURE",
	SMTP_USER: "API_SMTP_AUTH_USER",
	SMTP_PASS: "API_SMTP_AUTH_PASS",
	MAIL_FROM: "API_SMTP_SENDER",
	MAIL_APP_URL: "API_APP_URL",
};

/**
 * Fills each canonical variable from its legacy counterpart when it is not set explicitly.
 *
 * A read-only overlay rather than a mutation of `process.env`, exactly as `pbx-env.ts` does for the
 * media roots: the fallback is visible in one function and cannot surprise anything else that reads
 * the environment.
 */
export function withLegacyFallbacks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const merged: NodeJS.ProcessEnv = { ...source };
	for (const [canonical, legacy] of Object.entries(MAIL_LEGACY_ENV_ALIASES)) {
		const own = source[canonical];
		if (typeof own === "string" && own.trim().length > 0) {
			continue;
		}
		const inherited = source[legacy];
		if (typeof inherited === "string" && inherited.trim().length > 0) {
			merged[canonical] = inherited;
		} else {
			delete merged[canonical];
		}
	}
	return merged;
}

/**
 * Parses the environment, throwing on a contract violation.
 *
 * A malformed `SMTP_PORT` must stop the process at boot rather than surface as a failed send on
 * somebody's first password reset.
 */
export function loadMailEnv(source: NodeJS.ProcessEnv = process.env): MailEnv {
	const parsed = mailEnvSchema.safeParse(withLegacyFallbacks(source));
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid mail environment — ${detail}`);
	}
	const value = parsed.data;
	return {
		host: value.SMTP_HOST,
		port: value.SMTP_PORT,
		// 465 is implicit TLS by definition; anything else defaults to STARTTLS on a plain socket.
		secure: value.SMTP_SECURE ?? value.SMTP_PORT === 465,
		user: value.SMTP_USER,
		pass: value.SMTP_PASS,
		from: value.MAIL_FROM,
		replyTo: value.MAIL_REPLY_TO,
		appUrl: value.MAIL_APP_URL?.replace(/\/+$/u, ""),
		timeoutMs: value.SMTP_TIMEOUT_MS,
	};
}

/** True when this environment can actually hand a message to a relay. */
export function isMailConfigured(env: MailEnv): boolean {
	return env.host !== undefined && env.from !== undefined;
}

/**
 * The boot preflight: a production process may not fall back to the logging transport.
 *
 * Called from `main.ts` alongside the tenant-RLS and CDR preflights, before `NestFactory.create`,
 * because booting is the last moment a misconfiguration can be turned into a refusal to start
 * rather than into one-time links in a log aggregator.
 */
export function assertMailPreflight(
	env: MailEnv,
	nodeEnv: string | undefined = process.env.NODE_ENV,
): void {
	if (nodeEnv !== "production" || isMailConfigured(env)) {
		return;
	}
	const missing: string[] = [];
	if (env.host === undefined) missing.push("SMTP_HOST");
	if (env.from === undefined) missing.push("MAIL_FROM");
	throw new MailConfigurationFailure(missing);
}
