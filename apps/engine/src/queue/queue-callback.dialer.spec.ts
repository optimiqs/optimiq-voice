import { describe, expect, it } from "bun:test";
import { QueueCallbackDialerService } from "./queue-callback.dialer";
import type { JetStreamService } from "../nats/jetstream.service";
import type { QueueCallbackRequest } from "./queue-callback";

/**
 * The wire half of virtual hold's dialler.
 *
 * The one property worth proving here and nowhere else is that it ANSWERS. `QueueCallbackDialer`
 * documents that a dial never throws, and the reason is not tidiness: a throw would abandon the
 * sweep with the token still marked due and no attempt recorded, which is an unbounded retry loop
 * against one unreachable handset. So every way this can go wrong is asserted to come back as a
 * `refused` the runner can spend an attempt on.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000e1";

function request(overrides: Partial<QueueCallbackRequest> = {}): QueueCallbackRequest {
	return {
		orgId: ORG,
		queueId: QUEUE,
		callerNumber: "+15551234567",
		ringTimeoutSeconds: 30,
		attempts: 0,
		heldMs: 60_000,
		...overrides,
	};
}

function dialer(reply: unknown | "throws" | "no-connection") {
	const sent: { subject: string; body: Record<string, unknown> }[] = [];
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const jetstream = {
		rawConnection:
			reply === "no-connection"
				? undefined
				: {
						request: async (subject: string, data: Uint8Array) => {
							sent.push({
								subject,
								body: JSON.parse(decoder.decode(data)) as Record<string, unknown>,
							});
							if (reply === "throws") {
								throw new Error("no responders available for request");
							}
							return { data: encoder.encode(JSON.stringify(reply)) };
						},
					},
	} as unknown as JetStreamService;
	return { sent, built: new QueueCallbackDialerService(jetstream) };
}

describe("QueueCallbackDialerService", () => {
	it("asks the fleet on the flat subject and answers with the call it created", async () => {
		const d = dialer({ ok: true, callbackId: "cb", callId: "call-9", legId: "leg-9" });

		expect(await d.built.place(request({ relatedCallId: ORG, queueNumber: "4010" }))).toEqual({
			kind: "placed",
			callId: "call-9",
		});
		expect(d.sent[0]?.subject).toBe("rpc.engine.v1.queue-callback");
		expect(d.sent[0]?.body.to).toBe("+15551234567");
		expect(d.sent[0]?.body.relatedCallId).toBe(ORG);
		expect(d.sent[0]?.body.queueNumber).toBe("4010");
	});

	/**
	 * `callbackId` becomes the media channel's id, and the responder is idempotent on it. A second
	 * attempt that reused the first one's would be answered with the ids of the call that already
	 * failed — a retry that never rings.
	 */
	it("mints a fresh handle per attempt, so a retry is not answered with the failed call", async () => {
		const d = dialer({ ok: true, callbackId: "cb", callId: "call-9" });
		await d.built.place(request());
		await d.built.place(request());

		expect(d.sent[0]?.body.callbackId).not.toBe(d.sent[1]?.body.callbackId);
	});

	it("refuses rather than throwing when no engine answers", async () => {
		const d = dialer("throws");
		expect(await d.built.place(request())).toEqual({ kind: "refused", reason: "internal" });
	});

	it("refuses rather than throwing when the engine has no broker connection", async () => {
		const d = dialer("no-connection");
		expect((await d.built.place(request())).kind).toBe("refused");
	});

	it("passes the engine's own refusal code through, so busy and unroutable stay apart", async () => {
		const d = dialer({
			ok: false,
			callbackId: "cb",
			reason: "extension_offline",
			error: "no contact",
		});
		expect(await d.built.place(request())).toEqual({
			kind: "refused",
			reason: "extension_offline",
		});
	});

	/**
	 * A reply this instance cannot read is NOT evidence that nothing was placed — the far side may
	 * well have rung the customer. It is still one spent attempt, because the alternative rings that
	 * customer forever.
	 */
	it("counts an unreadable reply as a spent attempt", async () => {
		const d = dialer({ ok: true, callbackId: "cb" });
		expect(await d.built.place(request())).toEqual({ kind: "refused", reason: "internal" });
	});
});
