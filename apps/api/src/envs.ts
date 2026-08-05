import fs from "fs";
import { join } from "path";
import dotenv from "dotenv";
import { assertEnvsAreSet } from "@optimiq-voice/common";

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

export const OWNER_EMAIL = e.API_OWNER_EMAIL;

// Default owner configurations (If OWNER_EMAIL is set, the system will create a default user and a workspace)
export const OWNER_NAME = e.API_OWNER_NAME || "Admin";

export const OWNER_PASSWORD = e.API_OWNER_PASSWORD || "changeme";

export const ROUTR_API_ENDPOINT = e.API_ROUTR_API_ENDPOINT || "routr:51907";

export const ROUTR_DEFAULT_PEER_AOR = e.API_ROUTR_DEFAULT_PEER_AOR || "sip:voice@default";

export const ROUTR_DEFAULT_PEER_NAME = e.API_ROUTR_DEFAULT_PEER_NAME || "Voice Server";

export const ROUTR_DEFAULT_PEER_PASSWORD = e.API_ROUTR_DEFAULT_PEER_PASSWORD || "changeme";

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
