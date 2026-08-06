/**
 * Cross-field environment invariants. These run after schema validation so every value is
 * already typed; they encode the rules a single field cannot express on its own.
 *
 * Guard-then-execute: every check throws before the process is allowed to boot.
 */

export interface EnvInvariantConfig {
	NODE_ENV: string;
	DATABASE_URL?: string;
	API_DATABASE_URL?: string;
	NATS_URL?: string;
	API_NATS_URL?: string;
	NATS_USER?: string;
	NATS_PASS?: string;
	AUTH_SECRET?: string;
	AUTH_URL?: string;
	AUTH_COOKIE_DOMAIN?: string;
	API_APP_URL?: string;
	API_CLOAK_ENCRYPTION_KEY?: string;
	API_OWNER_PASSWORD?: string;
	API_ROUTR_DEFAULT_PEER_PASSWORD?: string;
	API_ASTERISK_ARI_SECRET?: string;
	ASTERISK_ARI_SECRET?: string;
	ASTERISK_SIPPROXY_SECRET?: string;
	ASTERISK_SIPPROXY_HOST?: string;
	ASTERISK_RTP_PORT_START?: number;
	ASTERISK_RTP_PORT_END?: number;
	ROUTR_EXTERNAL_ADDRS?: string;
	RTPENGINE_PUBLIC_IP?: string;
	RTPENGINE_PORT_MIN?: number;
	RTPENGINE_PORT_MAX?: number;
	POSTGRES_PASSWORD?: string;
	INFLUXDB_INIT_PASSWORD?: string;
	API_INFLUXDB_INIT_PASSWORD?: string;
}

/** Minimum entropy we accept for a signing/encryption secret. */
export const MINIMUM_SECRET_LENGTH = 32;

/**
 * Values shipped in `.env.example`. A deployment that still carries any of them has never
 * been configured, so production must refuse to start rather than serve calls with them.
 */
const PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
	"changeme",
	"change-me",
	"changeit",
	"password",
	"postgres",
	"secret",
	"k1.aesgcm256.mmpsvzcg9fk654babl30tsqq4h9d3n4f11hlue8bgay=",
	// AUTH_SECRET's placeholder. It is long on purpose: the minimum-length check below would wave
	// through anything of 32 characters, so the template's own value has to be refused by name or
	// a deployment could ship the session-signing key that is printed in the repository.
	"replace-with-a-generated-auth-secret",
]);

/** `.env.example` uses a C-style comment as the "you must fill this in" marker. */
const UNSET_HOST_MARKER = /^\/\*.*\*\/$/u;

function isPlaceholderSecret(value: string | undefined): boolean {
	const trimmed = value?.trim().toLowerCase();
	return trimmed !== undefined && trimmed.length > 0 && PLACEHOLDER_SECRETS.has(trimmed);
}

/**
 * Raised by {@link assertResolvedSecret}. Carries the same sentence the schema-level check
 * produces, so an operator reading a crash log does not have to know which of the two fired.
 */
export class ResolvedSecretPlaceholderError extends Error {
	readonly _tag = "ResolvedSecretPlaceholderError" as const;

	constructor(readonly key: string) {
		super(`${key} still uses the .env.example placeholder value.`);
		this.name = "ResolvedSecretPlaceholderError";
	}
}

/**
 * The placeholder check for a secret that has an in-code DEFAULT.
 *
 * `assertProductionSecrets` below reads environment variables, so it only ever sees a value an
 * operator actually set. That is a hole for any secret written as `e.SOME_PASSWORD || "changeme"`:
 * leaving the variable UNSET produces exactly the password the tripwire exists to refuse, and the
 * tripwire never fires because the string never appears in a checked variable. `apps/api/src/envs.ts`
 * has two of these — `OWNER_PASSWORD` and `ROUTR_DEFAULT_PEER_PASSWORD` — and the fallbacks are
 * worth keeping, because a developer running the stack locally should not have to invent a password
 * to sign in as the seeded owner.
 *
 * So the check moves to the RESOLVED value: whatever the process is actually going to use, default
 * included. Call it at the point the constant is defined, and production stops booting on a
 * placeholder no matter which side of the `||` produced it.
 *
 * Returns the value so it reads as an assignment rather than a statement above one.
 */
export function assertResolvedSecret(
	key: string,
	value: string,
	options: { readonly nodeEnv: string | undefined },
): string {
	if (options.nodeEnv !== "production") {
		return value;
	}
	if (!value.trim()) {
		throw new Error(`${key} must be set.`);
	}
	if (isPlaceholderSecret(value)) {
		throw new ResolvedSecretPlaceholderError(key);
	}
	return value;
}

function isUnsetHost(value: string | undefined): boolean {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed.length === 0 || UNSET_HOST_MARKER.test(trimmed);
}

function requirePresent(key: string, value: string | undefined): void {
	if (!value?.trim()) {
		throw new Error(`${key} must be set.`);
	}
}

function requireHttpsUrl(key: string, value: string | undefined): void {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new Error(`${key} must be set.`);
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`${key} must be a valid URL.`);
	}

	if (parsed.protocol !== "https:") {
		throw new Error(`${key} must use HTTPS in production.`);
	}
}

function assertPortRange(startKey: string, start: number, endKey: string, end: number): void {
	if (start >= end) {
		throw new Error(`${startKey} must be lower than ${endKey}.`);
	}
}

function assertMediaPortRanges(config: EnvInvariantConfig): void {
	if (config.ASTERISK_RTP_PORT_START !== undefined && config.ASTERISK_RTP_PORT_END !== undefined) {
		assertPortRange(
			"ASTERISK_RTP_PORT_START",
			config.ASTERISK_RTP_PORT_START,
			"ASTERISK_RTP_PORT_END",
			config.ASTERISK_RTP_PORT_END,
		);
	}

	if (config.RTPENGINE_PORT_MIN !== undefined && config.RTPENGINE_PORT_MAX !== undefined) {
		assertPortRange(
			"RTPENGINE_PORT_MIN",
			config.RTPENGINE_PORT_MIN,
			"RTPENGINE_PORT_MAX",
			config.RTPENGINE_PORT_MAX,
		);
	}
}

function assertProductionSecrets(config: EnvInvariantConfig): void {
	const secretKeys = [
		["AUTH_SECRET", config.AUTH_SECRET],
		["API_CLOAK_ENCRYPTION_KEY", config.API_CLOAK_ENCRYPTION_KEY],
		["API_OWNER_PASSWORD", config.API_OWNER_PASSWORD],
		// The SIP password apps/api hands Routr for the default peer. It has an in-code default of
		// "changeme" in `apps/api/src/envs.ts`, which this check cannot see when the variable is
		// unset — `assertResolvedSecret` covers that case at the point of definition. This entry
		// catches the other half: an operator who set the variable and set it to the placeholder.
		["API_ROUTR_DEFAULT_PEER_PASSWORD", config.API_ROUTR_DEFAULT_PEER_PASSWORD],
		["API_ASTERISK_ARI_SECRET", config.API_ASTERISK_ARI_SECRET],
		["ASTERISK_ARI_SECRET", config.ASTERISK_ARI_SECRET],
		["ASTERISK_SIPPROXY_SECRET", config.ASTERISK_SIPPROXY_SECRET],
		["POSTGRES_PASSWORD", config.POSTGRES_PASSWORD],
		["INFLUXDB_INIT_PASSWORD", config.INFLUXDB_INIT_PASSWORD],
		["API_INFLUXDB_INIT_PASSWORD", config.API_INFLUXDB_INIT_PASSWORD],
	] as const;

	for (const [key, value] of secretKeys) {
		if (isPlaceholderSecret(value)) {
			throw new Error(`${key} still uses the .env.example placeholder value.`);
		}
	}
}

/**
 * The backbone carries every tenant's call events, the `routing-cache` dial plan and the
 * `rpc.sip.v1.credential` request/reply that hands out SIP password derivations. `config/nats.conf`
 * closes it with an account and a password; this is the client-side half of the same decision.
 *
 * Checked rather than assumed because the failure is quiet: most services that connect log the
 * broker's `Authorization Violation` and carry on degraded, so a production deployment that forgot
 * the credentials would come up looking healthy with no events flowing at all — and a deployment
 * that has not yet applied the config would come up connected to an OPEN broker, which is worse.
 */
function assertProductionNatsCredentials(config: EnvInvariantConfig): void {
	// Unconditional: production has already been made to prove it has a broker URL a few lines
	// above, so "configured a backbone but not how to authenticate to it" is the only state left.
	requirePresent("NATS_USER", config.NATS_USER);
	requirePresent("NATS_PASS", config.NATS_PASS);

	if (isPlaceholderSecret(config.NATS_PASS)) {
		throw new Error("NATS_PASS still uses the .env.example placeholder value.");
	}
}

function assertProductionTelephonyHosts(config: EnvInvariantConfig): void {
	const hostKeys = [
		["ROUTR_EXTERNAL_ADDRS", config.ROUTR_EXTERNAL_ADDRS],
		["ASTERISK_SIPPROXY_HOST", config.ASTERISK_SIPPROXY_HOST],
		["RTPENGINE_PUBLIC_IP", config.RTPENGINE_PUBLIC_IP],
	] as const;

	for (const [key, value] of hostKeys) {
		if (isUnsetHost(value)) {
			throw new Error(`${key} must be a reachable address in production.`);
		}
	}
}

export function assertEnvInvariants(config: EnvInvariantConfig): void {
	assertMediaPortRanges(config);

	if (config.NODE_ENV !== "production") {
		return;
	}

	requirePresent("DATABASE_URL", config.DATABASE_URL ?? config.API_DATABASE_URL);
	requirePresent("NATS_URL", config.NATS_URL ?? config.API_NATS_URL);
	requirePresent("AUTH_SECRET", config.AUTH_SECRET);

	if ((config.AUTH_SECRET?.trim().length ?? 0) < MINIMUM_SECRET_LENGTH) {
		throw new Error(`AUTH_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters.`);
	}

	requireHttpsUrl("AUTH_URL", config.AUTH_URL);

	if (config.API_APP_URL?.trim()) {
		requireHttpsUrl("API_APP_URL", config.API_APP_URL);
	}

	assertProductionSecrets(config);
	assertProductionNatsCredentials(config);
	assertProductionTelephonyHosts(config);
}
