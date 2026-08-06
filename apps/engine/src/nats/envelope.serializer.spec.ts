import { describe, expect, it } from "bun:test";
import { makeCallEvent, safeValidateEvent } from "@optimiq-voice/events";
import { ENVELOPE_ONLY_SERIALIZER, serializeEnvelopeOnly } from "./envelope.serializer";

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const CALL = "0195c0f0-1c2f-7000-8000-0000000000c1";
const LEG = "0195c0f0-1c2f-7000-8000-0000000000e1";

function decode(bytes: Uint8Array): unknown {
	return JSON.parse(new TextDecoder().decode(bytes));
}

describe("serializeEnvelopeOnly", () => {
	it("puts the payload on the wire with no wrapper around it", () => {
		const { data } = serializeEnvelopeOnly({ data: { type: "channel.created", legId: LEG } });
		expect(decode(data)).toEqual({ type: "channel.created", legId: LEG });
	});

	it("drops Nest's `pattern` field, which is what broke every consumer", () => {
		const packet = { pattern: "calls.evt.v1.x.y.channel.created", data: { type: "x" } };
		expect(decode(serializeEnvelopeOnly(packet).data)).not.toHaveProperty("pattern");
	});

	it("produces bytes a contract consumer can validate against the subject", () => {
		// The assertion that would have caught the defect: build a real event, serialize it exactly
		// as the transport will, and validate the RESULT rather than the intent.
		const envelope = makeCallEvent("channel.answered", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: { legId: LEG },
		});
		const { data } = serializeEnvelopeOnly({ pattern: envelope.subject, data: envelope });

		const result = safeValidateEvent(envelope.subject, decode(data));
		expect(result.success).toBe(true);
	});

	it("is what the module hands Nest", () => {
		expect(ENVELOPE_ONLY_SERIALIZER.serialize).toBe(serializeEnvelopeOnly);
	});

	it("returns bytes, which is the shape Nest's NATS client publishes", () => {
		const { data } = serializeEnvelopeOnly({ data: { a: 1 } });
		expect(data).toBeInstanceOf(Uint8Array);
	});
});
