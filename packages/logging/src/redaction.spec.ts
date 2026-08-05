import { describe, expect, it } from "bun:test";
import {
	isSensitiveLogKey,
	MAX_REDACTION_DEPTH,
	redactErrorValue,
	redactLogValue,
	scrubSensitiveString,
} from "./redaction";

describe("scrubSensitiveString", () => {
	it("redacts JWTs and bearer tokens", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1g";

		expect(scrubSensitiveString(jwt)).toBe("[REDACTED-JWT]");
		expect(scrubSensitiveString(`Authorization: Bearer ${jwt}`)).not.toContain(jwt);
		expect(scrubSensitiveString("Bearer abc.def-ghi_jkl")).toContain("Bearer [REDACTED]");
	});

	it("redacts secrets carried in query strings", () => {
		const scrubbed = scrubSensitiveString(
			"GET /ari/channels?api_key=9f8e7d6c&token=6c5b4a39 HTTP/1.1",
		);

		expect(scrubbed).not.toContain("9f8e7d6c");
		expect(scrubbed).not.toContain("6c5b4a39");
		expect(scrubbed).toContain("api_key=[REDACTED]");
		expect(scrubbed).toContain("token=[REDACTED]");
	});

	it("redacts credentials embedded in SIP and connection URIs", () => {
		expect(scrubSensitiveString("sip://voice:sipproxysecret@203.0.113.10:5060")).toBe(
			"sip://voice:<REDACTED>@203.0.113.10:5060",
		);
		expect(scrubSensitiveString("postgresql://voice:hunter2@db.internal:5432/voice")).toBe(
			"postgresql://voice:<REDACTED>@db.internal:5432/voice",
		);
	});

	it("redacts telephony PII: E.164 numbers and emails", () => {
		const scrubbed = scrubSensitiveString(
			"call from +14155552671 to +442071838750 by agent@optimiq.example",
		);

		expect(scrubbed).not.toContain("+14155552671");
		expect(scrubbed).not.toContain("+442071838750");
		expect(scrubbed).not.toContain("agent@optimiq.example");
		expect(scrubbed).toContain("[REDACTED-PHONE]");
		expect(scrubbed).toContain("[REDACTED-EMAIL]");
	});

	it("redacts long hex tokens and key/value secret assignments", () => {
		expect(scrubSensitiveString(`digest=${"a".repeat(64)}`)).toContain("[REDACTED-HEX]");
		expect(scrubSensitiveString('{"password":"hunter2"}')).not.toContain("hunter2");
		expect(scrubSensitiveString("secret=topsecretvalue")).not.toContain("topsecretvalue");
	});

	it("leaves non-sensitive text intact", () => {
		expect(scrubSensitiveString("channel PJSIP/voice-00000001 answered")).toBe(
			"channel PJSIP/voice-00000001 answered",
		);
		expect(scrubSensitiveString(undefined)).toBe("");
		expect(scrubSensitiveString(42)).toBe("42");
	});
});

describe("isSensitiveLogKey", () => {
	it("matches secret, auth and telephony PII field names", () => {
		for (const key of [
			"authorization",
			"Cookie",
			"set-cookie",
			"apiKey",
			"api_key",
			"sessionToken",
			"ariSecret",
			"sip_password",
			"callerId",
			"fromNumber",
			"to_number",
			"msisdn",
			"phoneNumber",
			"email",
			"dtmf",
			"digits",
			"privateKey",
		]) {
			expect(isSensitiveLogKey(key)).toBe(true);
		}
	});

	it("does not match ordinary call metadata", () => {
		for (const key of ["channelId", "callId", "duration", "codec", "state", "workspaceId"]) {
			expect(isSensitiveLogKey(key)).toBe(false);
		}
	});
});

describe("redactLogValue", () => {
	it("blanks sensitive keys and scrubs surviving values", () => {
		const redacted = redactLogValue({
			callId: "01920000-0000-7000-8000-000000000000",
			fromNumber: "+14155552671",
			note: "ring +14155552671 back",
			headers: { authorization: "Bearer abc123", "x-request-id": "req-1" },
		});

		expect(redacted).toEqual({
			callId: "01920000-0000-7000-8000-000000000000",
			fromNumber: "[REDACTED]",
			note: "ring [REDACTED-PHONE] back",
			headers: { authorization: "[REDACTED]", "x-request-id": "req-1" },
		});
	});

	it("redacts values inside arrays", () => {
		expect(redactLogValue({ participants: ["+14155552671", "agent@optimiq.example"] })).toEqual({
			participants: ["[REDACTED-PHONE]", "[REDACTED-EMAIL]"],
		});
	});

	it("truncates beyond the maximum redaction depth", () => {
		let deepest: Record<string, unknown> = { leaf: "+14155552671" };
		for (let level = 0; level < MAX_REDACTION_DEPTH + 2; level += 1) {
			deepest = { nested: deepest };
		}

		expect(JSON.stringify(redactLogValue(deepest))).toContain("[Truncated]");
		expect(JSON.stringify(redactLogValue(deepest))).not.toContain("+14155552671");
	});

	it("survives circular references", () => {
		const node: Record<string, unknown> = { name: "channel" };
		node.self = node;

		expect(redactLogValue(node)).toEqual({ name: "channel", self: "[Circular]" });
	});

	it("preserves dates and primitive scalars", () => {
		const when = new Date("2026-01-01T00:00:00.000Z");

		expect(redactLogValue({ when, retries: 3, ok: true, missing: null })).toEqual({
			when,
			retries: 3,
			ok: true,
			missing: null,
		});
	});
});

describe("redactErrorValue", () => {
	it("scrubs the message and stack of an error", () => {
		const error = new Error("failed to reach +14155552671 with token abc.def-ghi");

		const redacted = redactErrorValue(error);

		expect(redacted.name).toBe("Error");
		expect(redacted.message).not.toContain("+14155552671");
		expect(redacted.stack).not.toContain("+14155552671");
	});
});
