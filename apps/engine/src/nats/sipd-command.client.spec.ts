import { describe, expect, it } from "bun:test";
import {
	SIP_ANSWER_RPC,
	SIP_HANGUP_RPC,
	SIP_ORIGINATE_RPC,
	SIP_REINVITE_RPC,
	SIP_RING_RPC,
	subjectFor,
} from "@optimiq-voice/events";
import { SipdCommandClient } from "./sipd-command.client";
import type { NatsConnection } from "nats";

/**
 * The engine's half of `rpc.sip.v1.{ring,answer,hangup,reinvite,originate}`, with a fake connection.
 *
 * Three things are worth proving here and nowhere else, and each of them fails silently in
 * production if it is wrong.
 *
 * 1. **Which subject each command goes to.** Four are instance-addressed and one is flat, and a
 *    command addressed at the wrong edge is answered `unknown_dialog` by a process that never had
 *    the call — which looks exactly like a call that ended.
 * 2. **That a refusal is DATA and a dead edge is data too, and that they are distinguishable.** The
 *    caller branches on `reason`; a client that threw on either would make every call site wrap the
 *    ordinary path in a `try`.
 * 3. **That the bytes on the wire are the bare contract.** The responder is Go and reads the struct;
 *    a Nest `{pattern, data}` frame would be refused three layers from the serializer that caused it.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const EDGE = "sipd-7c9f";

interface RecordedRequest {
	readonly subject: string;
	readonly payload: unknown;
	readonly timeoutMs: number;
}

function fakeConnection(options: { readonly closed?: boolean } = {}) {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const requests: RecordedRequest[] = [];
	const replies = new Map<string, unknown>();
	let failure: Error | undefined;
	let rawReply: string | undefined;

	const connection = {
		request: async (subject: string, payload: Uint8Array, opts?: { timeout?: number }) => {
			requests.push({
				subject,
				payload: JSON.parse(decoder.decode(payload)) as unknown,
				timeoutMs: opts?.timeout ?? 0,
			});
			await Promise.resolve();
			if (failure !== undefined) {
				throw failure;
			}
			if (rawReply !== undefined) {
				return { data: encoder.encode(rawReply) };
			}
			return { data: encoder.encode(JSON.stringify(replies.get(subject) ?? { ok: true })) };
		},
		isClosed: () => options.closed === true,
	} as unknown as NatsConnection;

	return {
		connection,
		requests,
		reply: (subject: string, value: unknown) => {
			replies.set(subject, value);
		},
		/** Bytes that are not the contract — a Go struct that drifted, or a proxy that answered. */
		answerWith: (bytes: string) => {
			rawReply = bytes;
		},
		fail: (error: Error) => {
			failure = error;
		},
	};
}

function client(fake: ReturnType<typeof fakeConnection>): SipdCommandClient {
	return new SipdCommandClient(() => fake.connection);
}

describe("addressing the sip edge", () => {
	it("sends ring, answer, hangup and reinvite at the instance HOLDING the dialog", async () => {
		const fake = fakeConnection();
		const sipd = client(fake);

		fake.reply(subjectFor.sipRingRpc(EDGE), { ok: true, legId: "leg-a", instanceId: EDGE });
		fake.reply(subjectFor.sipAnswerRpc(EDGE), { ok: true, legId: "leg-a", instanceId: EDGE });
		fake.reply(subjectFor.sipHangupRpc(EDGE), { ok: true, legId: "leg-a", instanceId: EDGE });
		fake.reply(subjectFor.sipReinviteRpc(EDGE), { ok: true, legId: "leg-a", instanceId: EDGE });

		await sipd.ring(EDGE, { legId: "leg-a", status: 180 });
		await sipd.answer(EDGE, { legId: "leg-a", sdpAnswer: "v=0\r\n" });
		await sipd.hangup(EDGE, { legId: "leg-a", cause: 16 });
		await sipd.reinvite(EDGE, { legId: "leg-a", sdpOffer: "v=0\r\n", intent: "hold" });

		expect(fake.requests.map((request) => request.subject)).toEqual([
			"rpc.sip.v1.ring.sipd-7c9f",
			"rpc.sip.v1.answer.sipd-7c9f",
			"rpc.sip.v1.hangup.sipd-7c9f",
			"rpc.sip.v1.reinvite.sipd-7c9f",
		]);
	});

	it("builds the subject from the instance it was TOLD, never from a fixed one", async () => {
		const fake = fakeConnection();
		const sipd = client(fake);

		await sipd.hangup("sipd-other", { legId: "leg-a" });

		expect(fake.requests[0]?.subject).toBe(subjectFor.sipHangupRpc("sipd-other"));
		expect(fake.requests[0]?.subject).not.toBe(subjectFor.sipHangupRpc(EDGE));
	});

	it("sends originate FLAT, because the dialog it creates has no owner to address yet", async () => {
		const fake = fakeConnection();
		const sipd = client(fake);
		fake.reply(subjectFor.sipOriginateRpc(), {
			ok: true,
			legId: "leg-b",
			// The edge that TOOK it. The engine records this and addresses every later command at it.
			instanceId: "sipd-2b41",
			sipCallId: "a84b4c76e66710@pc33",
		});

		const reply = await sipd.originate({
			legId: "leg-b",
			orgId: ORG,
			callId: "call-1",
			target: { kind: "aor", aor: "sip:1002@acme.example.com" },
			sdpOffer: "v=0\r\n",
		});

		expect(fake.requests[0]?.subject).toBe("rpc.sip.v1.originate");
		expect(reply.instanceId).toBe("sipd-2b41");
	});

	it("puts the BARE contract on the wire, with no Nest framing around it", async () => {
		const fake = fakeConnection();
		const sipd = client(fake);

		await sipd.ring(EDGE, { legId: "leg-a", status: 183, sdpAnswer: "v=0\r\n" });

		expect(fake.requests[0]?.payload).toEqual({
			legId: "leg-a",
			status: 183,
			sdpAnswer: "v=0\r\n",
		});
	});

	it("takes every deadline from the contract rather than a literal in this file", async () => {
		const fake = fakeConnection();
		const sipd = client(fake);

		await sipd.ring(EDGE, { legId: "leg-a", status: 180 });
		await sipd.answer(EDGE, { legId: "leg-a", sdpAnswer: "v=0\r\n" });
		await sipd.hangup(EDGE, { legId: "leg-a" });
		await sipd.reinvite(EDGE, { legId: "leg-a", sdpOffer: "v=0\r\n", intent: "move" });
		await sipd.originate({
			legId: "leg-b",
			orgId: ORG,
			callId: "call-1",
			target: { kind: "uri", uri: "sip:1002@acme.example.com" },
			sdpOffer: "v=0\r\n",
		});

		expect(fake.requests.map((request) => request.timeoutMs)).toEqual([
			SIP_RING_RPC.timeoutMs,
			SIP_ANSWER_RPC.timeoutMs,
			SIP_HANGUP_RPC.timeoutMs,
			SIP_REINVITE_RPC.timeoutMs,
			SIP_ORIGINATE_RPC.timeoutMs,
		]);
		// The one deadline whose value is an argument rather than a number: `answer` replies when the
		// 2xx is on the SOCKET, not on the ACK, so it is a second and not the thirty-two its SIP
		// transaction may take.
		expect(SIP_ANSWER_RPC.timeoutMs).toBe(1_000);
	});
});

describe("refuse, never throw", () => {
	it("returns a refusal as data, with the edge's own reason and instance intact", async () => {
		const fake = fakeConnection();
		const sipd = client(fake);
		fake.reply(subjectFor.sipAnswerRpc(EDGE), {
			ok: false,
			legId: "leg-a",
			instanceId: EDGE,
			reason: "dialog_gone",
			error: "a CANCEL won the race",
		});

		const reply = await sipd.answer(EDGE, { legId: "leg-a", sdpAnswer: "v=0\r\n" });

		expect(reply.ok).toBe(false);
		expect(reply.reason).toBe("dialog_gone");
		// The edge ANSWERED, so it is named. This is what tells a refusal apart from an absence.
		expect(reply.instanceId).toBe(EDGE);
	});

	it("passes `not_supported` through, which is what reinvite answers until slice 5", async () => {
		const fake = fakeConnection();
		const sipd = client(fake);
		fake.reply(subjectFor.sipReinviteRpc(EDGE), {
			ok: false,
			legId: "leg-a",
			instanceId: EDGE,
			reason: "not_supported",
		});

		const reply = await sipd.reinvite(EDGE, {
			legId: "leg-a",
			sdpOffer: "v=0\r\n",
			intent: "hold",
		});

		expect(reply.reason).toBe("not_supported");
	});

	it("turns a timeout into a refusal the caller can attribute, and does NOT throw", async () => {
		const fake = fakeConnection();
		const sipd = client(fake);
		fake.fail(new Error("TIMEOUT"));

		const reply = await sipd.hangup(EDGE, { legId: "leg-a", cause: 16 });

		expect(reply.ok).toBe(false);
		expect(reply.reason).toBe("internal");
		// The leg is echoed from the REQUEST: a refusal the caller cannot attribute is a log line
		// nobody can act on.
		expect(reply.legId).toBe("leg-a");
		// And no `instanceId`, which is the whole distinction from the refusal above: the field means
		// "who answered", and on a timeout nobody did.
		expect(reply.instanceId).toBeUndefined();
	});

	it("treats a dead edge the same way, because the caller's move is the same", async () => {
		const fake = fakeConnection();
		const sipd = client(fake);
		fake.fail(new Error("503 no responders available"));

		const reply = await sipd.ring(EDGE, { legId: "leg-a", status: 180 });

		expect(reply).toEqual({
			ok: false,
			legId: "leg-a",
			reason: "internal",
			error: "Error: 503 no responders available",
		});
	});

	it("refuses a reply that is not the contract rather than handing a half-parsed one up", async () => {
		const fake = fakeConnection();
		const sipd = client(fake);
		// A Go struct that drifted from the Zod source is the one failure nothing else catches.
		fake.answerWith(JSON.stringify({ ok: true }));

		const reply = await sipd.answer(EDGE, { legId: "leg-a", sdpAnswer: "v=0\r\n" });

		expect(reply.ok).toBe(false);
		expect(reply.reason).toBe("internal");
		expect(reply.error).toContain("not the contract");
	});

	it("refuses without touching the wire when the engine has no connection", async () => {
		const sipd = new SipdCommandClient(() => undefined);

		const reply = await sipd.hangup(EDGE, { legId: "leg-a" });

		expect(reply.ok).toBe(false);
		expect(reply.reason).toBe("internal");
		expect(sipd.isConnected).toBe(false);
	});

	it("refuses on a closed connection, rather than requesting into a socket that is gone", async () => {
		const fake = fakeConnection({ closed: true });
		const sipd = client(fake);

		const reply = await sipd.originate({
			legId: "leg-b",
			orgId: ORG,
			callId: "call-1",
			target: { kind: "trunk", trunkId: ORG, number: "+15551230000" },
			sdpOffer: "v=0\r\n",
		});

		expect(reply.ok).toBe(false);
		expect(fake.requests).toHaveLength(0);
	});
});
