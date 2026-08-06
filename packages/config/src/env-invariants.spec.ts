import { describe, expect, it } from "bun:test";
import {
	assertEnvInvariants,
	assertResolvedSecret,
	ResolvedSecretPlaceholderError,
	type EnvInvariantConfig,
} from "./env-invariants";

const productionBaseline: EnvInvariantConfig = {
	NODE_ENV: "production",
	DATABASE_URL: "postgresql://voice:s3cret@db.internal:5432/optimiq_voice",
	NATS_URL: "nats://nats.internal:4222",
	NATS_USER: "optimiq",
	NATS_PASS: "a-real-nats-password",
	AUTH_SECRET: "a".repeat(48),
	AUTH_URL: "https://auth.optimiq.example",
	API_APP_URL: "https://app.optimiq.example",
	API_OWNER_PASSWORD: "a-real-owner-password",
	API_ASTERISK_ARI_SECRET: "a-real-ari-secret",
	ASTERISK_ARI_SECRET: "a-real-ari-secret",
	ASTERISK_SIPPROXY_SECRET: "a-real-sipproxy-secret",
	ASTERISK_SIPPROXY_HOST: "203.0.113.10",
	ASTERISK_RTP_PORT_START: 10000,
	ASTERISK_RTP_PORT_END: 20000,
	POSTGRES_PASSWORD: "a-real-postgres-password",
};

const withProduction = (overrides: Partial<EnvInvariantConfig>): EnvInvariantConfig => ({
	...productionBaseline,
	...overrides,
});

describe("env invariants outside production", () => {
	it("accepts a bare development environment", () => {
		expect(() => assertEnvInvariants({ NODE_ENV: "development" })).not.toThrow();
	});

	it("still validates media port ranges everywhere", () => {
		expect(() =>
			assertEnvInvariants({
				NODE_ENV: "development",
				ASTERISK_RTP_PORT_START: 20000,
				ASTERISK_RTP_PORT_END: 10000,
			}),
		).toThrow("ASTERISK_RTP_PORT_START must be lower than ASTERISK_RTP_PORT_END.");
	});
});

describe("env invariants in production", () => {
	it("accepts a fully configured production environment", () => {
		expect(() => assertEnvInvariants(productionBaseline)).not.toThrow();
	});

	it("accepts the transitional API_-prefixed transport URLs", () => {
		expect(() =>
			assertEnvInvariants(
				withProduction({
					DATABASE_URL: undefined,
					NATS_URL: undefined,
					API_DATABASE_URL: "postgresql://voice:s3cret@db.internal:5432/optimiq_voice",
					API_NATS_URL: "nats://nats.internal:4222",
				}),
			),
		).not.toThrow();
	});

	it("requires the transport URLs", () => {
		expect(() => assertEnvInvariants(withProduction({ DATABASE_URL: undefined }))).toThrow(
			"DATABASE_URL must be set.",
		);

		expect(() => assertEnvInvariants(withProduction({ NATS_URL: "   " }))).toThrow(
			"NATS_URL must be set.",
		);
	});

	it("requires a high-entropy auth secret", () => {
		expect(() => assertEnvInvariants(withProduction({ AUTH_SECRET: undefined }))).toThrow(
			"AUTH_SECRET must be set.",
		);

		expect(() => assertEnvInvariants(withProduction({ AUTH_SECRET: "too-short" }))).toThrow(
			"AUTH_SECRET must be at least 32 characters.",
		);
	});

	it("requires HTTPS for public URLs", () => {
		expect(() =>
			assertEnvInvariants(withProduction({ AUTH_URL: "http://auth.optimiq.example" })),
		).toThrow("AUTH_URL must use HTTPS in production.");

		expect(() =>
			assertEnvInvariants(withProduction({ API_APP_URL: "http://localhost:8080" })),
		).toThrow("API_APP_URL must use HTTPS in production.");

		expect(() => assertEnvInvariants(withProduction({ AUTH_URL: "not-a-url" }))).toThrow(
			"AUTH_URL must be a valid URL.",
		);
	});

	it("rejects every .env.example placeholder secret", () => {
		const placeholders: { key: string; overrides: Partial<EnvInvariantConfig> }[] = [
			{
				key: "AUTH_SECRET",
				overrides: { AUTH_SECRET: "replace-with-a-generated-auth-secret" },
			},
			{ key: "API_OWNER_PASSWORD", overrides: { API_OWNER_PASSWORD: "changeme" } },
			{ key: "API_ASTERISK_ARI_SECRET", overrides: { API_ASTERISK_ARI_SECRET: "changeme" } },
			{ key: "ASTERISK_ARI_SECRET", overrides: { ASTERISK_ARI_SECRET: "ChangeMe" } },
			{ key: "ASTERISK_SIPPROXY_SECRET", overrides: { ASTERISK_SIPPROXY_SECRET: "changeme" } },
			{ key: "POSTGRES_PASSWORD", overrides: { POSTGRES_PASSWORD: "postgres" } },
		];

		for (const { key, overrides } of placeholders) {
			expect(() => assertEnvInvariants(withProduction(overrides))).toThrow(
				`${key} still uses the .env.example placeholder value.`,
			);
		}
	});

	it("requires NATS credentials whenever a broker URL is configured", () => {
		expect(() => assertEnvInvariants(withProduction({ NATS_USER: undefined }))).toThrow(
			"NATS_USER must be set.",
		);

		expect(() => assertEnvInvariants(withProduction({ NATS_PASS: "   " }))).toThrow(
			"NATS_PASS must be set.",
		);

		expect(() => assertEnvInvariants(withProduction({ NATS_PASS: "changeme" }))).toThrow(
			"NATS_PASS still uses the .env.example placeholder value.",
		);
	});

	it("rejects unset telephony addresses", () => {
		expect(() =>
			assertEnvInvariants(
				withProduction({ ASTERISK_SIPPROXY_HOST: "/* Set to the IP address of the host */" }),
			),
		).toThrow("ASTERISK_SIPPROXY_HOST must be a reachable address in production.");

		expect(() => assertEnvInvariants(withProduction({ ASTERISK_SIPPROXY_HOST: "" }))).toThrow(
			"ASTERISK_SIPPROXY_HOST must be a reachable address in production.",
		);

		expect(() =>
			assertEnvInvariants(withProduction({ ASTERISK_SIPPROXY_HOST: undefined })),
		).toThrow("ASTERISK_SIPPROXY_HOST must be a reachable address in production.");
	});
});

/**
 * The hole `assertResolvedSecret` exists to close: a secret written as
 * `e.API_OWNER_PASSWORD || "changeme"` produces the placeholder from an UNSET variable, so the
 * schema-level check above never sees the string it is looking for.
 */
describe("assertResolvedSecret", () => {
	it("returns the value untouched outside production, placeholder or not", () => {
		expect(assertResolvedSecret("API_OWNER_PASSWORD", "changeme", { nodeEnv: "development" })).toBe(
			"changeme",
		);

		expect(assertResolvedSecret("API_OWNER_PASSWORD", "changeme", { nodeEnv: undefined })).toBe(
			"changeme",
		);
	});

	it("returns a real production secret", () => {
		expect(
			assertResolvedSecret("API_OWNER_PASSWORD", "a-real-owner-password", {
				nodeEnv: "production",
			}),
		).toBe("a-real-owner-password");
	});

	it("refuses a defaulted placeholder in production", () => {
		expect(() =>
			assertResolvedSecret("API_OWNER_PASSWORD", "changeme", { nodeEnv: "production" }),
		).toThrow("API_OWNER_PASSWORD still uses the .env.example placeholder value.");

		expect(() =>
			assertResolvedSecret("API_ASTERISK_ARI_SECRET", "ChangeMe", {
				nodeEnv: "production",
			}),
		).toThrow(ResolvedSecretPlaceholderError);
	});

	it("refuses an empty production secret", () => {
		expect(() =>
			assertResolvedSecret("API_OWNER_PASSWORD", "   ", { nodeEnv: "production" }),
		).toThrow("API_OWNER_PASSWORD must be set.");
	});
});
