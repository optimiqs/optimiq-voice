import { describe, expect, it } from "bun:test";
import { natsCredentials, NatsCredentialsIncompleteError } from "./nats-credentials";

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
});
