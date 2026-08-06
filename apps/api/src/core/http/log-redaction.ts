/**
 * What must never appear in an HTTP log line, and the Fastify logger options that enforce it.
 *
 * ## Why this exists
 *
 * Fastify's logger is pino, and pino serializes whatever object it is handed. A request carrying
 * `authorization: Bearer …`, or a body carrying `sipPasswordHa1`, is one `request.log` call — or
 * one error path that attaches the request — away from writing a credential to stdout, and from
 * there to whatever ships stdout off the box. Log stores are read by more people, kept for longer
 * and guarded less carefully than the database the value came from, so a secret that reaches a log
 * has effectively been published.
 *
 * ## Why an explicit list rather than a matcher
 *
 * pino's `redact.paths` is a fixed set of paths compiled once when the logger is built. That is the
 * whole appeal: it costs nothing per line, it cannot be defeated by a value that merely looks
 * innocuous, and — the part that matters at review time — the set of things considered secret is a
 * list a person can read in one sitting. A regex over serialized output would be worse on all
 * three counts and would still miss the field named `secret` whose value is a UUID.
 *
 * The names are the ones this system actually carries. `sipPassword*`, `sipSecretRef` and the PIN
 * digests are exactly the columns `secretColumns` strips from every PBX CRUD response
 * (`src/pbx/shared/pbx-resource.ts`); this is the same rule applied to the other way a value gets
 * out of the process. The snake_case twins of the SIP columns are listed because a raw row read
 * outside Drizzle's mapping still carries the physical column names.
 */
const SECRET_FIELDS = [
	"sipPassword",
	"sipPasswordHa1",
	"sip_password_ha1",
	"sipSecretRef",
	"sip_secret_ref",
	"pin",
	"pinHash",
	"moderatorPin",
	"moderatorPinHash",
	"password",
	"token",
	"apiKey",
	"secret",
] as const;

/** `x-api-key` is the header `auth-http.plugin.ts` reads for machine callers. */
const SECRET_HEADERS = ["authorization", "cookie", "set-cookie", "x-api-key"] as const;

/**
 * The compiled path set.
 *
 * Each name is listed under the handful of shapes a log call actually produces: bare at the top
 * level, one level down (pino's `*` wildcard), and under the `body` of a logged request. Fastify's
 * own request serializer emits neither headers nor body, so every one of these paths exists for a
 * deliberate `log.info({ … })` somewhere — a path that matches nothing costs nothing, and a
 * missing one is silent.
 *
 * Header names are bracket-quoted: `set-cookie` and `x-api-key` are not identifiers in pino's path
 * grammar, and the unquoted form parses as a subtraction and matches nothing at all.
 */
export const HTTP_LOG_REDACT_PATHS: readonly string[] = [
	...SECRET_HEADERS.flatMap((header) => [
		`headers["${header}"]`,
		`req.headers["${header}"]`,
		`request.headers["${header}"]`,
	]),
	...SECRET_FIELDS.flatMap((field) => [field, `*.${field}`, `body.${field}`, `req.body.${field}`]),
];

export const REDACTED = "[redacted]";

/**
 * Whether the HTTP logger runs at all, from the same `LOGS_LEVEL` the winston logger reads.
 *
 * One environment variable governs logging in this process, and a second one that only the Fastify
 * half obeyed would be a guarantee that the two disagree. `none` is what `package.json`'s `test`
 * script sets, and it means silent here too.
 */
function httpLogLevel(): string | undefined {
	const level = (process.env.LOGS_LEVEL ?? "info").toLowerCase();
	if (level === "none" || level === "off" || level === "silent") {
		return undefined;
	}
	// winston's `verbose` and `http` have no pino equivalent. Both sit below `info` in intent, and
	// `debug` is the level that keeps them visible rather than dropping them on the floor.
	if (level === "verbose" || level === "http") {
		return "debug";
	}
	return level;
}

/**
 * What `FastifyAdapter` accepts for `logger`, stated structurally.
 *
 * NOT `FastifyServerOptions["logger"]`: `@fastify/multipart` augments `FastifyRequest` in this
 * package, which specializes the request generic on that alias, while `FastifyAdapter` declares
 * its own option bag over `FastifyServerOptions<any, …>`. The two are then mutually unassignable
 * through their `serializers.req` signatures — a variance failure over a field neither side is
 * setting. The literal shape is assignable to both and says exactly as much as is true.
 */
export interface HttpLoggerOptions {
	readonly level: string;
	// `paths` is mutable because pino's own `redactOptions.paths` is `string[]`, and a
	// `readonly string[]` is not assignable to it. The array handed over is a fresh copy.
	readonly redact: { paths: string[]; readonly censor: string };
}

/**
 * The `logger` option for `FastifyAdapter`.
 *
 * Returns Fastify's own `false` when the level says silent, so `redact` is never compiled for a
 * logger nothing writes to.
 */
export function httpLoggerOptions(): HttpLoggerOptions | false {
	const level = httpLogLevel();
	if (level === undefined) {
		return false;
	}
	return {
		level,
		redact: { paths: [...HTTP_LOG_REDACT_PATHS], censor: REDACTED },
	};
}
