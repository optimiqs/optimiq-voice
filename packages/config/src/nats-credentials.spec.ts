import { describe, expect, it } from "bun:test";
import {
	natsConnectionOptions,
	natsCredentials,
	NatsCredentialsIncompleteError,
	natsTlsOptions,
} from "./nats-credentials";

describe("natsCredentials", () => {
	it("returns the pair when both are set", () => {
		expect(natsCredentials({ NATS_USER: "optimiq", NATS_PASS: "s3cret" })).toEqual({
			user: "optimiq",
			pass: "s3cret",
		});
	});

	it("trims, because a trailing space in a .env line is invisible and fatal", () => {
		expect(natsCredentials({ NATS_USER: " optimiq ", NATS_PASS: "s3cret\t" })).toEqual({
			user: "optimiq",
			pass: "s3cret",
		});
	});

	it("returns nothing for an unauthenticated broker", () => {
		expect(natsCredentials({})).toEqual({});
		expect(natsCredentials({ NATS_USER: "", NATS_PASS: "   " })).toEqual({});
	});

	it("refuses half a credential rather than letting the broker refuse it quietly", () => {
		expect(() => natsCredentials({ NATS_USER: "optimiq" })).toThrow(NatsCredentialsIncompleteError);
		expect(() => natsCredentials({ NATS_USER: "optimiq" })).toThrow(
			"NATS_USER is set but NATS_PASS is not.",
		);
		expect(() => natsCredentials({ NATS_PASS: "s3cret" })).toThrow(
			"NATS_PASS is set but NATS_USER is not.",
		);
	});

	it("reads process.env directly", () => {
		expect(natsCredentials(process.env)).toBeDefined();
	});

	it("prefers the per-service pair, which is the least-privilege identity", () => {
		expect(
			natsCredentials(
				{
					NATS_USER: "optimiq",
					NATS_PASS: "shared",
					NATS_ENGINE_USER: "optimiq-engine",
					NATS_ENGINE_PASS: "scoped",
				},
				"engine",
			),
		).toEqual({ user: "optimiq-engine", pass: "scoped" });
	});

	it("falls back to the shared pair, so a deployment mid-migration still connects", () => {
		expect(natsCredentials({ NATS_USER: "optimiq", NATS_PASS: "shared" }, "api")).toEqual({
			user: "optimiq",
			pass: "shared",
		});
	});

	it("ignores a service tag nothing is configured for", () => {
		expect(natsCredentials({ NATS_USER: "optimiq", NATS_PASS: "shared" }, "mediad")).toEqual({
			user: "optimiq",
			pass: "shared",
		});
	});

	it("refuses half a SERVICE pair rather than demoting the process onto the shared one", () => {
		// The dangerous case: falling back here would silently hand apps/api the operator identity
		// and the typo would only surface in an audit.
		expect(() =>
			natsCredentials({ NATS_USER: "optimiq", NATS_PASS: "shared", NATS_API_USER: "x" }, "api"),
		).toThrow("NATS_API_USER is set but NATS_API_PASS is not.");
		expect(() => natsCredentials({ NATS_SIPD_PASS: "x" }, "sipd")).toThrow(
			NatsCredentialsIncompleteError,
		);
	});
});

describe("natsTlsOptions", () => {
	it("is off with nothing set, so plaintext nats:// development keeps working", () => {
		expect(natsTlsOptions({})).toEqual({});
		expect(natsTlsOptions({ NATS_TLS_CA: "  ", NATS_TLS_ENABLED: "false" })).toEqual({});
	});

	it("pins the CA bundle when one is given", () => {
		expect(natsTlsOptions({ NATS_TLS_CA: " ./config/certs/ca.pem " })).toEqual({
			tls: { caFile: "./config/certs/ca.pem" },
		});
	});

	it("uses the system trust store when enabled without a CA", () => {
		expect(natsTlsOptions({ NATS_TLS_ENABLED: "true" })).toEqual({ tls: {} });
		expect(natsTlsOptions({ NATS_TLS_ENABLED: "1" })).toEqual({ tls: {} });
	});
});

describe("natsConnectionOptions", () => {
	it("carries identity and transport security together", () => {
		expect(
			natsConnectionOptions(
				{ NATS_ENGINE_USER: "optimiq-engine", NATS_ENGINE_PASS: "s3cret", NATS_TLS_CA: "/ca.pem" },
				"engine",
			),
		).toEqual({ user: "optimiq-engine", pass: "s3cret", tls: { caFile: "/ca.pem" } });
	});
});
