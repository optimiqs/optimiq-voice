import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import * as z from "zod";
import { assertEnvInvariants } from "./env-invariants";
import { requireUnknownRecord } from "./unknown-value";

/**
 * Strict boolean parser for env vars.
 * `z.coerce.boolean()` uses `Boolean(value)` and would treat the string "false" as truthy.
 */
const booleanString = z.union([
	z.boolean(),
	z.stringbool({ truthy: ["true", "1"], falsy: ["false", "0", ""] }),
]);

const optionalString = z.preprocess(
	(value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
	z.string().optional(),
);

const optionalUrl = z.preprocess(
	(value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
	z.url().optional(),
);

/**
 * Any URI with a scheme — `nats://`, `postgresql://`, `ws://`, `amqp://`. `z.url()` is too
 * narrow for the transport URLs this platform speaks.
 */
const optionalUri = z.preprocess(
	(value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
	z
		.string()
		.regex(/^[a-z][a-z0-9+.-]*:\/\//iu, "must be a URI with a scheme (e.g. nats://host:4222)")
		.optional(),
);

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

/** The single dotenv file is the repository root `.env`. Nothing above the repo is read. */
const findEnvPath = (filename: string): string | null => {
	const baseDir = import.meta.dirname;
	const searchPaths = [
		resolve(baseDir, "../../../", filename),
		resolve(baseDir, "../../", filename),
	];

	for (const fullPath of searchPaths) {
		if (existsSync(fullPath)) {
			return fullPath;
		}
	}
	return null;
};

const rootEnvPath = findEnvPath(".env");

if (rootEnvPath) {
	config({ path: rootEnvPath, quiet: true });
}

type AppEnvPrimitive = string | number | boolean | null;
type BunEnvRuntime = {
	env?: Record<string, string | undefined>;
};

/** Hydration never overwrites an already-set variable: real process env always wins. */
const setEnvIfMissing = (key: string, value: string): void => {
	if (process.env[key]?.trim()) {
		return;
	}

	process.env[key] = value;

	const bunRuntime = (globalThis as typeof globalThis & { Bun?: BunEnvRuntime }).Bun;
	if (bunRuntime?.env) {
		bunRuntime.env[key] = value;
	}
};

const isAppEnvPrimitive = (value: unknown): value is AppEnvPrimitive => {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null
	);
};

const stripEnvValueQuotes = (value: string): string => {
	if (value.length < 2) {
		return value;
	}
	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' || first === "'") && first === last) {
		return value.slice(1, -1);
	}
	return value;
};

const tryHydrateEnvFromJsonObject = (trimmed: string): boolean => {
	if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
		return false;
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return false;
		}

		for (const [key, value] of Object.entries(requireUnknownRecord(parsed))) {
			if (!key.trim()) {
				continue;
			}
			if (isAppEnvPrimitive(value)) {
				setEnvIfMissing(key, String(value));
			}
		}

		return true;
	} catch {
		return false;
	}
};

const hydrateEnvFromKeyValueLines = (trimmed: string): void => {
	for (const line of trimmed.split("\n")) {
		const statement = line.trim();
		if (!statement || statement.startsWith("#")) {
			continue;
		}
		const separatorIndex = statement.indexOf("=");
		if (separatorIndex <= 0) {
			continue;
		}
		const key = statement.slice(0, separatorIndex).trim();
		const value = stripEnvValueQuotes(statement.slice(separatorIndex + 1).trim());
		if (!key) {
			continue;
		}
		setEnvIfMissing(key, value);
	}
};

/**
 * `APP_ENV_CONTENT` carries a whole environment from a secret manager as either a JSON
 * object or a dotenv-formatted string. Only unset keys are hydrated.
 */
const hydrateEnvFromAppEnvContent = (raw: string): void => {
	const trimmed = raw.trim();
	if (!trimmed) {
		return;
	}

	if (tryHydrateEnvFromJsonObject(trimmed)) {
		return;
	}

	hydrateEnvFromKeyValueLines(trimmed);
};

const appEnvContent = process.env.APP_ENV_CONTENT;

if (typeof appEnvContent === "string" && appEnvContent.trim()) {
	hydrateEnvFromAppEnvContent(appEnvContent);
}

const envSchema = z.object({
	// ---- Process ------------------------------------------------------------------------
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	TZ: optionalString,
	APP_VERSION: z.string().default("0.0.0"),
	BUILD_ID: z.string().default("dev"),
	APP_ENV_CONTENT: z.string().optional(),
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).optional(),
	LOG_PRETTY: optionalString,
	EFFECT_OBSERVABILITY_LOG_LEVEL: z
		.enum(["trace", "debug", "info", "warn", "error", "fatal", "none"])
		.default("info"),

	// ---- Platform placeholders (canonical names for the rebuilt services) -----------------
	DATABASE_URL: optionalUri,
	NATS_URL: optionalUri,
	/**
	 * The broker requires authentication (`config/nats.conf`). Both are optional here because a
	 * developer's ephemeral broker and the verify harnesses' throwaway containers have no auth at
	 * all; `assertEnvInvariants` requires both in production whenever a NATS URL is configured.
	 */
	NATS_USER: optionalString,
	NATS_PASS: optionalString,
	AUTH_SECRET: z.string().min(32).optional(),
	AUTH_URL: optionalUrl,
	AUTH_COOKIE_DOMAIN: optionalString,
	AUTH_COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).optional(),
	AUTH_ISSUER: optionalString,
	AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(2_592_000).default(86_400),

	// ---- API server ----------------------------------------------------------------------
	API_APP_URL: optionalUrl,
	API_ASTERISK_ARI_PROXY_URL: optionalUrl,
	API_ASTERISK_ARI_SECRET: optionalString,
	API_ASTERISK_ARI_USERNAME: z.string().default("ari"),
	API_DATABASE_URL: optionalUri,
	API_LOGS_FORMAT: z.enum(["json", "pretty", "none"]).default("json"),
	API_LOGS_LEVEL: optionalString,
	API_LOGS_TRANSPORT: optionalString,
	API_NATS_URL: optionalUri,
	API_OWNER_EMAIL: z.email().optional(),
	API_OWNER_NAME: optionalString,
	API_OWNER_PASSWORD: optionalString,
	API_ROOT_DOMAIN: optionalString,
	API_SMTP_AUTH_PASS: optionalString,
	API_SMTP_AUTH_USER: optionalString,
	API_SMTP_HOST: optionalString,
	API_SMTP_PORT: port(587),
	API_SMTP_SECURE: booleanString.default(true),
	API_SMTP_SENDER: optionalString,

	// ---- Asterisk (media / application server) -------------------------------------------
	ASTERISK_ARI_PROXY_URL: optionalUrl,
	ASTERISK_ARI_SECRET: optionalString,
	ASTERISK_ARI_USERNAME: z.string().default("ari"),
	ASTERISK_CODECS: z.string().default("g722,ulaw,alaw"),
	ASTERISK_DTMF_MODE: z
		.enum(["auto", "auto_info", "inband", "info", "rfc4733"])
		.default("auto_info"),
	ASTERISK_RTP_PORT_END: port(20000),
	ASTERISK_RTP_PORT_START: port(10000),
	ASTERISK_SIPPROXY_HOST: optionalString,
	ASTERISK_SIPPROXY_PORT: port(5060),
	ASTERISK_SIPPROXY_SECRET: optionalString,
	ASTERISK_SIPPROXY_USERNAME: z.string().default("voice"),

	// ---- Postgres ------------------------------------------------------------------------
	POSTGRES_PASSWORD: optionalString,
	POSTGRES_USER: optionalString,
});

const envSource: NodeJS.ProcessEnv = { ...process.env };

/**
 * The canonical transport names are DATABASE_URL / NATS_URL. Existing deployments still ship
 * the API_-prefixed names, so those act as the transitional fallback.
 */
envSource.DATABASE_URL ??= envSource.API_DATABASE_URL;
envSource.NATS_URL ??= envSource.API_NATS_URL;

const parsedEnv = envSchema.safeParse(envSource);

if (!parsedEnv.success) {
	const formattedErrors = JSON.stringify(z.treeifyError(parsedEnv.error));
	throw new Error(`Invalid environment variables: ${formattedErrors}`);
}

const env = parsedEnv.data;

assertEnvInvariants(env);

export { env };

export const getEnvVar = (key: string): string | undefined => {
	const value = envSource[key];
	return typeof value === "string" ? value : undefined;
};

export const getEnvEntries = (): [string, string][] => {
	return Object.entries(envSource).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
};
