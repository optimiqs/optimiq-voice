import { expect } from "chai";
import { SipAuthEventConsumer } from "../../src/pbx/security/sip-auth-event-consumer.service";
import type { SipAuthEventMessage } from "../../src/pbx/security/sip-auth-event-consumer.service";
import type { SipAuthEventInput } from "../../src/pbx/security/sip-auth-event.service";
import type { SipAuthEventService } from "../../src/pbx/security/sip-auth-event.service";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";

/**
 * The registration half of the attack log — the durable that turns `sip.reg.v1.….auth-failed` into
 * `sip_auth_event` rows.
 *
 * The registrar is the only process that sees a digest, so this is the only path by which a wrong
 * password ever becomes a row. What that makes worth asserting without a broker or a database:
 *
 *  1. **The mapping**, including that BOTH refusal reasons file as `bad-credentials` and that the
 *     distinction survives in `detail.reason` rather than in a column.
 *  2. **The address** reaches an `inet` column, so the port has to come off — in both the v4 and
 *     the bracketed v6 spelling.
 *  3. **The tenancy cross-check** — the organization comes from the subject the broker routed on,
 *     and an envelope that disagrees with it is terminated rather than filed under either.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORG = "019fd3c2-8888-76be-a6b3-b0f1914e39b6";
const AOR_HASH = "0123456789abcdef0123456789abcdef";
const SUBJECT = `sip.reg.v1.${ORG}.${AOR_HASH}.auth-failed`;

function authFailedEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "019fd3c2-4444-7abe-a6b3-b0f1914e39b6",
		type: "auth-failed",
		source: "sipd",
		orgId: ORG,
		subject: SUBJECT,
		at: "2026-09-09T10:00:00.000Z",
		data: {
			aor: "sip:1001@acme.example.com",
			aorHash: AOR_HASH,
			transport: "udp",
			sourceAddress: "203.0.113.9:5060",
			userAgent: "friendly-scanner",
			username: "1001",
			reason: "bad-credentials",
		},
		...overrides,
	};
}

/** A message whose ack/nak/term decisions are observable. */
function fakeMessage(body: unknown, subject = SUBJECT) {
	const calls: string[] = [];
	const data = body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
	const message: SipAuthEventMessage = {
		subject,
		data,
		ack: () => calls.push("ack"),
		nak: () => calls.push("nak"),
		term: () => calls.push("term"),
	};
	return { message, calls };
}

function consumerWithRecorder() {
	const recorded: SipAuthEventInput[] = [];
	const events = {
		record: async (input: SipAuthEventInput): Promise<void> => {
			recorded.push(input);
		},
	} as unknown as SipAuthEventService;
	const consumer = new SipAuthEventConsumer({ NATS_URL: undefined } as unknown as PbxEnv, events);
	return { consumer, recorded };
}

describe("the sip auth event consumer", () => {
	it("files a refused REGISTER as a registration-scope bad-credentials row", async () => {
		const { consumer, recorded } = consumerWithRecorder();
		const { message, calls } = fakeMessage(authFailedEvent());

		expect(await consumer.dispatch(message)).to.equal("recorded");
		expect(calls).to.deep.equal(["ack"]);
		expect(recorded).to.have.length(1);
		const row = recorded[0];
		expect(row?.organizationId).to.equal(ORG);
		expect(row?.eventType).to.equal("bad-credentials");
		expect(row?.scope).to.equal("registration");
		expect(row?.accountRef).to.equal("1001");
		expect(row?.transport).to.equal("udp");
		expect(row?.userAgent).to.equal("friendly-scanner");
		// The column is `inet`: the port is not part of the address.
		expect(row?.sourceIp).to.equal("203.0.113.9");
		expect(row?.detail).to.deep.equal({
			reason: "bad-credentials",
			aor: "sip:1001@acme.example.com",
		});
		expect(consumer.stats.recorded).to.equal(1);
	});

	it("files a stale nonce as bad-credentials too, keeping the reason in detail", async () => {
		// The vocabulary is pinned to Asterisk's Security Events names; a replayed nonce is still a
		// credential that did not authenticate, and `detail.reason` is where the difference lives.
		const { consumer, recorded } = consumerWithRecorder();
		const event = authFailedEvent();
		(event.data as Record<string, unknown>).reason = "stale-nonce";
		const { message, calls } = fakeMessage(event);

		expect(await consumer.dispatch(message)).to.equal("recorded");
		expect(calls).to.deep.equal(["ack"]);
		expect(recorded[0]?.eventType).to.equal("bad-credentials");
		expect((recorded[0]?.detail as { reason: string }).reason).to.equal("stale-nonce");
	});

	it("strips the port from a bracketed IPv6 source", async () => {
		const { consumer, recorded } = consumerWithRecorder();
		const event = authFailedEvent();
		(event.data as Record<string, unknown>).sourceAddress = "[2001:db8::1]:5060";
		const { message } = fakeMessage(event);

		await consumer.dispatch(message);
		expect(recorded[0]?.sourceIp).to.equal("2001:db8::1");
	});

	it("terminates bytes that are not this contract rather than blocking the durable", async () => {
		const { consumer, recorded } = consumerWithRecorder();
		const { message, calls } = fakeMessage(new TextEncoder().encode("not json at all"));

		expect(await consumer.dispatch(message)).to.equal("terminated");
		expect(calls).to.deep.equal(["term"]);
		expect(recorded).to.have.length(0);
		expect(consumer.stats.terminated).to.equal(1);
	});

	it("terminates an envelope whose orgId disagrees with the subject it arrived on", async () => {
		// The tenant is the address, not the payload. A forged body must not scope a write.
		const { consumer, recorded } = consumerWithRecorder();
		const { message, calls } = fakeMessage(authFailedEvent({ orgId: OTHER_ORG, subject: SUBJECT }));

		expect(await consumer.dispatch(message)).to.equal("terminated");
		expect(calls).to.deep.equal(["term"]);
		expect(recorded).to.have.length(0);
	});
});
