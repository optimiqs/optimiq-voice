import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("config env module", () => {
	it("does not search above the repository root for dotenv files", () => {
		const source = readFileSync(new URL("./env.ts", import.meta.url), "utf8");

		expect(source).not.toContain("../../../../");
	});

	it("uses the repository .env as the only dotenv file", () => {
		const source = readFileSync(new URL("./env.ts", import.meta.url), "utf8");

		expect(source).toContain('findEnvPath(".env")');
		expect(source).not.toContain(".env.local");
	});

	it("parses strict booleans, defaults and APP_ENV_CONTENT hydration", async () => {
		process.env.NODE_ENV = "test";
		process.env.API_SMTP_SECURE = "";
		process.env.API_NATS_URL = "nats://nats:4222";
		process.env.API_DATABASE_URL = "postgresql://postgres:postgres@postgres:5432/optimiq-voice";
		delete process.env.DATABASE_URL;
		delete process.env.NATS_URL;
		delete process.env.OPTIMIQ_QUOTED_TEST_VALUE;
		delete process.env.OPTIMIQ_SINGLE_QUOTED_TEST_VALUE;
		process.env.APP_ENV_CONTENT =
			"OPTIMIQ_QUOTED_TEST_VALUE=\"hello=world\"\nOPTIMIQ_SINGLE_QUOTED_TEST_VALUE='abc'";

		const mod = await import("./env");

		expect(mod.env.NODE_ENV).toBe("test");
		// "" must never be truthy — the whole point of the strict parser. `API_SMTP_SECURE` is the
		// last booleanString key in the schema now that the identity/authz/autopilot/Routr blocks
		// are deleted, so it carries the case on its own.
		expect(mod.env.API_SMTP_SECURE).toBe(false);

		// Telephony defaults survive an otherwise empty environment.
		expect(mod.env.ASTERISK_RTP_PORT_START).toBe(10000);
		expect(mod.env.ASTERISK_RTP_PORT_END).toBe(20000);
		expect(mod.env.ASTERISK_SIPPROXY_PORT).toBe(5060);
		expect(mod.env.ASTERISK_CODECS).toBe("g722,ulaw,alaw");
		expect(mod.env.EFFECT_OBSERVABILITY_LOG_LEVEL).toBe("info");

		// API_-prefixed transport URLs still hydrate the canonical names.
		expect(mod.env.DATABASE_URL).toBe("postgresql://postgres:postgres@postgres:5432/optimiq-voice");
		expect(mod.env.NATS_URL).toBe("nats://nats:4222");

		// APP_ENV_CONTENT dotenv hydration, including quote stripping.
		expect(process.env.OPTIMIQ_QUOTED_TEST_VALUE as unknown).toBe("hello=world");
		expect(process.env.OPTIMIQ_SINGLE_QUOTED_TEST_VALUE as unknown).toBe("abc");

		expect(mod.getEnvVar("API_NATS_URL")).toBe("nats://nats:4222");
		expect(mod.getEnvVar("DEFINITELY_NOT_SET_ANYWHERE")).toBeUndefined();
		expect(mod.getEnvEntries().some(([key]) => key === "NODE_ENV")).toBe(true);
	});
});
