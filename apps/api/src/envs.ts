import fs from "fs";
import { join } from "path";
import dotenv from "dotenv";
import { assertEnvsAreSet } from "@optimiq-voice/common";
// The `/env-invariants` subpath rather than the package root: the root re-exports `env`, whose
// module side effects parse and validate the WHOLE environment at import time, and this file runs
// before that is wanted. The subpath is pure functions.
import { assertResolvedSecret } from "@optimiq-voice/config/env-invariants";
import { natsCredentials } from "@optimiq-voice/config/nats-credentials";

if (process.env.NODE_ENV === "development") {
	// `import.meta.dirname` is the ES-module replacement for `__dirname`; it resolves to
	// `apps/api/src` under tsx and `apps/api/dist` after a build — the repository root either way.
	dotenv.config({ path: join(import.meta.dirname, "..", "..", "..", ".env") });
}

const e = process.env;

assertEnvsAreSet([
	"API_APP_URL",
	"API_SIGNALING_SERVER",
	"API_ASTERISK_ARI_PROXY_URL",
	"API_ASTERISK_ARI_USERNAME",
	"API_ASTERISK_ARI_SECRET",
	"API_CLOAK_ENCRYPTION_KEY",
	"API_SMTP_HOST",
	"API_SMTP_SENDER",
	"API_SMTP_AUTH_USER",
	"API_SMTP_AUTH_PASS",
	"API_IDENTITY_ISSUER",
	"API_IDENTITY_DATABASE_URL",
	"API_IDENTITY_WORKSPACE_INVITE_URL",
	"API_IDENTITY_WORKSPACE_INVITE_FAIL_URL",
	"API_DATABASE_URL",
	"API_INFLUXDB_URL",
	"API_INFLUXDB_INIT_USERNAME",
	"API_INFLUXDB_INIT_PASSWORD",
	"API_INFLUXDB_INIT_ORG",
	"API_INFLUXDB_INIT_TOKEN",
	"API_NATS_URL",
]);

const IDENTITY_PRIVATE_KEY_PATH =
	e.API_IDENTITY_PRIVATE_KEY_PATH || "/opt/optimiq-voice/keys/private.pem";
const IDENTITY_PUBLIC_KEY_PATH =
	e.API_IDENTITY_PUBLIC_KEY_PATH || "/opt/optimiq-voice/keys/public.pem";

export const API_BIND_ADDR = e.API_BIND_ADDR || "0.0.0.0:50051";

export const API_HOST = e.API_HOST || "api";

export const API_SIGNALING_SERVER = e.API_SIGNALING_SERVER;

// Frontend configurations
export const APP_URL = e.API_APP_URL;

export const ASTERISK_ARI_PROXY_URL = e.API_ASTERISK_ARI_PROXY_URL;

export const ASTERISK_ARI_SECRET = e.API_ASTERISK_ARI_SECRET;

export const ASTERISK_ARI_USERNAME = e.API_ASTERISK_ARI_USERNAME;

export const ASTERISK_SYSTEM_DOMAIN = e.API_ASTERISK_SYSTEM_DOMAIN || "sip.invalid";

export const ASTERISK_TRUNK = "routr";

export const CALLS_CREATE_SUBJECT = "calls.create";

export const CALLS_TRACK_CALL_SUBJECT = "calls.track";

// Other configurations
export const CLOAK_ENCRYPTION_KEY = e.API_CLOAK_ENCRYPTION_KEY;

export const DEFAULT_NATS_QUEUE_GROUP = "api";

export const HTTP_BRIDGE_PORT = e.API_HTTP_BRIDGE_PORT ? parseInt(e.API_HTTP_BRIDGE_PORT) : 9876;

// Identity configurations
export const IDENTITY_ACCESS_TOKEN_EXPIRES_IN = e.API_IDENTITY_ACCESS_TOKEN_EXPIRES_IN || "15m";

export const IDENTITY_AUDIENCE = e.API_IDENTITY_AUDIENCE || "api";

export const IDENTITY_ID_TOKEN_EXPIRES_IN = e.API_IDENTITY_ID_TOKEN_EXPIRES_IN || "15m";

export const IDENTITY_ISSUER = e.API_IDENTITY_ISSUER;

export const IDENTITY_CONTACT_VERIFICATION_REQUIRED =
	e.API_IDENTITY_CONTACT_VERIFICATION_REQUIRED === "true";

export const IDENTITY_TWO_FACTOR_AUTHENTICATION_REQUIRED =
	e.API_IDENTITY_TWO_FACTOR_AUTHENTICATION_REQUIRED === "true";

export const IDENTITY_OAUTH2_GITHUB_ENABLED = e.API_IDENTITY_OAUTH2_GITHUB_ENABLED === "true";

export const IDENTITY_OAUTH2_GITHUB_CLIENT_ID = e.API_IDENTITY_OAUTH2_GITHUB_CLIENT_ID;

export const IDENTITY_OAUTH2_GITHUB_CLIENT_SECRET = e.API_IDENTITY_OAUTH2_GITHUB_CLIENT_SECRET;

export const IDENTITY_PRIVATE_KEY = fs.readFileSync(IDENTITY_PRIVATE_KEY_PATH, "utf8");

export const IDENTITY_PUBLIC_KEY = fs.readFileSync(IDENTITY_PUBLIC_KEY_PATH, "utf8");

export const IDENTITY_REFRESH_TOKEN_EXPIRES_IN = e.API_IDENTITY_REFRESH_TOKEN_EXPIRES_IN || "24h";

export const IDENTITY_WORKSPACE_INVITE_FAIL_URL = e.API_IDENTITY_WORKSPACE_INVITE_FAIL_URL;

export const IDENTITY_WORKSPACE_INVITE_EXPIRATION =
	e.API_IDENTITY_WORKSPACE_INVITE_EXPIRATION || "1d";

export const IDENTITY_WORKSPACE_INVITE_URL = e.API_IDENTITY_WORKSPACE_INVITE_URL;

export const IDENTITY_DATABASE_URL = e.API_IDENTITY_DATABASE_URL;

/** The telephony database. Named without the `API_` prefix to match `packages/db`'s vocabulary. */
export const DATABASE_URL = e.API_DATABASE_URL;

if (e.API_IDENTITY_OAUTH2_GITHUB_ENABLED === "true") {
	assertEnvsAreSet([
		"API_IDENTITY_OAUTH2_GITHUB_CLIENT_ID",
		"API_IDENTITY_OAUTH2_GITHUB_CLIENT_SECRET",
	]);
}

if (IDENTITY_CONTACT_VERIFICATION_REQUIRED || IDENTITY_TWO_FACTOR_AUTHENTICATION_REQUIRED) {
	assertEnvsAreSet(["API_TWILIO_ACCOUNT_SID", "API_TWILIO_AUTH_TOKEN", "API_TWILIO_PHONE_NUMBER"]);
}

if (e.API_AUTHZ_SERVICE_ENABLED === "true") {
	assertEnvsAreSet(["API_AUTHZ_SERVICE_HOST"]);
}

// Authz configurations
export const AUTHZ_SERVICE_ENABLED = e.API_AUTHZ_SERVICE_ENABLED === "true";
export const AUTHZ_SERVICE_HOST = e.API_AUTHZ_SERVICE_HOST;
export const AUTHZ_SERVICE_PORT = e.API_AUTHZ_SERVICE_PORT || 50071;
export const AUTHZ_SERVICE_METHODS = e.API_AUTHZ_SERVICE_METHODS
	? e.API_AUTHZ_SERVICE_METHODS.split(",")
	: ["/optimiq_voice.calls.v1beta2.Calls/CreateCall"];

// InfluxDB configurations
export const INFLUXDB_ORG = e.API_INFLUXDB_INIT_ORG;

export const INFLUXDB_PASSWORD = e.API_INFLUXDB_INIT_PASSWORD;

export const INFLUXDB_TOKEN = e.API_INFLUXDB_INIT_TOKEN;

export const INFLUXDB_URL = e.API_INFLUXDB_URL;

export const INFLUXDB_USERNAME = e.API_INFLUXDB_INIT_USERNAME;

export const INTEGRATIONS_FILE = e.API_INTEGRATIONS_FILE || "/opt/optimiq-voice/integrations.json";

export const NATS_URL = e.API_NATS_URL;

/**
 * The `user` / `pass` connection options for the broker, which requires authentication — see
 * `config/nats.conf`. `NATS_USER` and `NATS_PASS` are unprefixed and shared with apps/engine and
 * apps/sipd, on the same terms as `NATS_URL` itself.
 *
 * Kept out of the URL because most of this app's connect sites LOG the URL they connected to; a
 * `nats://user:pass@host` would put the password in the log aggregator.
 *
 * Resolved once, here, so a half-set pair (one variable renamed, the other not) throws while this
 * module is being imported — at boot — instead of turning into an `Authorization Violation` that
 * each service catches and logs as a warning while coming up "healthy" with a dead backbone.
 *
 * Empty when neither is set, which is a broker with no authentication configured: the integration
 * harnesses and the verify scripts start one of those per run.
 */
export const NATS_CREDENTIALS = natsCredentials(e);

export const OWNER_EMAIL = e.API_OWNER_EMAIL;

// Default owner configurations (If OWNER_EMAIL is set, the system will create a default user and a workspace)
export const OWNER_NAME = e.API_OWNER_NAME || "Admin";

/**
 * The seeded owner's password.
 *
 * The `changeme` fallback is deliberate and stays: a developer bringing the stack up locally should
 * be able to sign in as the seeded owner without inventing a password first. What is NOT acceptable
 * is that fallback reaching production, and until now it could — silently, and in the one way the
 * `.env.example` tripwire could not see. `assertEnvInvariants` matches the literal string in a
 * checked ENVIRONMENT VARIABLE, so leaving `API_OWNER_PASSWORD` unset produced exactly the public
 * password the tripwire exists to refuse while the tripwire had nothing to look at.
 *
 * `assertResolvedSecret` moves the check onto the RESOLVED value, whichever side of the `||`
 * produced it, and only bites when NODE_ENV is production.
 */
export const OWNER_PASSWORD = assertResolvedSecret(
	"API_OWNER_PASSWORD",
	e.API_OWNER_PASSWORD || "changeme",
	{ nodeEnv: e.NODE_ENV },
);

export const ROUTR_API_ENDPOINT = e.API_ROUTR_API_ENDPOINT || "routr:51907";

export const ROUTR_DEFAULT_PEER_AOR = e.API_ROUTR_DEFAULT_PEER_AOR || "sip:voice@default";

export const ROUTR_DEFAULT_PEER_NAME = e.API_ROUTR_DEFAULT_PEER_NAME || "Voice Server";

/**
 * The SIP password provisioned for Routr's default peer — the credential the media server registers
 * with. Same shape and same hazard as `OWNER_PASSWORD` above: a useful local default that used to
 * be able to become a production SIP password without anything noticing, because the tripwire only
 * ever inspected the environment variable and an unset variable has nothing to inspect.
 */
export const ROUTR_DEFAULT_PEER_PASSWORD = assertResolvedSecret(
	"API_ROUTR_DEFAULT_PEER_PASSWORD",
	e.API_ROUTR_DEFAULT_PEER_PASSWORD || "changeme",
	{ nodeEnv: e.NODE_ENV },
);

export const ROUTR_DEFAULT_PEER_USERNAME = e.API_ROUTR_DEFAULT_PEER_USERNAME || "voice";

export const SMTP_AUTH_PASS = e.API_SMTP_AUTH_PASS;

export const SMTP_AUTH_USER = e.API_SMTP_AUTH_USER;

// SMTP configurations
export const SMTP_HOST = e.API_SMTP_HOST;

export const SMTP_PORT = e.API_SMTP_PORT ? parseInt(e.API_SMTP_PORT) : 587;

export const SMTP_SECURE = e.API_SMTP_SECURE?.toLowerCase() === "true";

export const SMTP_SENDER = e.API_SMTP_SENDER;

// Custom templates
export const TEMPLATES_DIR = e.API_TEMPLATES_DIR;

// Twilio configurations
export const TWILIO_ACCOUNT_SID = e.API_TWILIO_ACCOUNT_SID;

export const TWILIO_AUTH_TOKEN = e.API_TWILIO_AUTH_TOKEN;

export const TWILIO_PHONE_NUMBER = e.API_TWILIO_PHONE_NUMBER;
