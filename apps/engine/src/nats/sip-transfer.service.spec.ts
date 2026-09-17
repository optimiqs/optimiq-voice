import { describe, expect, it } from "bun:test";
import { subjectFor } from "@optimiq-voice/events";
import { SipTransferService } from "./sip-transfer.service";
import type { CallControlResult, ControlledLeg, TransferRequest } from "../calls/call-control";
import type { EngineEnv } from "../config/engine-env";
import type { JetStreamService } from "./jetstream.service";
import type { SipTransferCallPath } from "./sip-transfer.service";
import type { SipTransferRequest } from "@optimiq-voice/events";

/**
 * The transport and authorisation halves of `rpc.sip.v1.transfer`, with a fake connection and a fake
 * call path.
 *
 * Two things are worth proving here and nowhere else. That the bytes on the wire ARE the contract —
 * the caller is Go and would not understand a NestJS frame, so the reply shape is the feature. And
 * that every path which does NOT move a call still ANSWERS: a desk phone waits on a NOTIFY that
 * `apps/sipd` can only send once it has an outcome, so a silence here is a transfer key that hangs.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_ORG = "0195c0f0-1c2f-7000-8000-000000000002";
const CALL_ID = "3c26700c1adf-6qgy0fkn7cvb";

function request(overrides: Partial<SipTransferRequest> = {}): SipTransferRequest {
	return {
		orgId: ORG,
		sipCallId: CALL_ID,
		fromTag: "as58c1f2b3",
		toTag: "9f2a11",
		referredBy: { aor: "sip:1001@acme.example.com", username: "1001" },
		target: { user: "1002", host: "acme.example.com" },
		kind: "blind",
		referCSeq: 3,
		...overrides,
	};
}

function leg(overrides: Partial<ControlledLeg> = {}): ControlledLeg {
	return {
		mediaChannelId: "media-1",
		legId: "leg-1",
		callId: "call-1",
		organizationId: ORG,
		isTearingDown: false,
		isAnswered: true,
		bridgeId: "bridge-1",
		peerMediaChannelId: "media-2",
		callerIdNumber: "1001",
		...overrides,
	} as ControlledLeg;
}

/**
 * A NATS connection made of two queues, as in `park-handoff.service.spec.ts`.
 *
 * `subscribe` yields whatever a spec delivers, and each delivered message records what was sent
 * back — the only way to see the reply frame, because the responder never returns it.
 */
function fakeConnection() {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const replies: unknown[] = [];
	const subscribed: { subject: string; queue?: string }[] = [];
	const pending: { data: Uint8Array; reply?: string }[] = [];
	let wake: (() => void) | undefined;

	async function* messages(): AsyncGenerator<{
		data: Uint8Array;
		reply?: string;
		respond: (data: Uint8Array) => void;
	}> {
		for (;;) {
			const next = pending.shift();
			if (next === undefined) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			yield {
				data: next.data,
				...(next.reply === undefined ? {} : { reply: next.reply }),
				respond: (data: Uint8Array) => {
					replies.push(JSON.parse(decoder.decode(data)) as unknown);
				},
			};
		}
	}

	const iterator = messages();
	const connection = {
		subscribe: (subject: string, options?: { queue?: string }) => {
			subscribed.push({
				subject,
				...(options?.queue === undefined ? {} : { queue: options.queue }),
			});
			return { [Symbol.asyncIterator]: () => iterator, unsubscribe: () => undefined };
		},
		isClosed: () => false,
	};

	return {
		connection,
		replies,
		subscribed,
		/** Delivers one raw request and settles the responder's answer. */
		deliver: async (bytes: string): Promise<void> => {
			pending.push({ data: encoder.encode(bytes), reply: "_INBOX.test" });
			wake?.();
			wake = undefined;
			for (let tick = 0; tick < 20; tick += 1) {
				await Promise.resolve();
			}
		},
	};
}

interface CallPathOptions {
	readonly resolved?: string | undefined;
	readonly resolveThrows?: boolean;
	readonly leg?: ControlledLeg | undefined;
	readonly result?: CallControlResult;
	readonly transferThrows?: boolean;
	/** Absent leaves the optional pre-flight check off, which is a supported call path. */
	readonly dialable?: boolean;
	readonly dialableThrows?: boolean;
	/** Whether this call path can broker an attended transfer at all. Off is a supported state. */
	readonly attended?: boolean;
	readonly replacedResolved?: string | undefined;
	readonly replacedResolveThrows?: boolean;
	readonly consultationLeg?: ControlledLeg | undefined;
	readonly attendedResult?: CallControlResult;
	readonly attendedThrows?: boolean;
}

/** The transferor's OTHER leg: the consultation the phone placed on its second line. */
const CONSULTATION_MEDIA_CHANNEL_ID = "media-consult";

function consultationLeg(overrides: Partial<ControlledLeg> = {}): ControlledLeg {
	return leg({
		mediaChannelId: CONSULTATION_MEDIA_CHANNEL_ID,
		legId: "leg-consult",
		callId: "call-2",
		bridgeId: "bridge-2",
		peerMediaChannelId: "media-3",
		...overrides,
	});
}

function callPath(options: CallPathOptions = {}): {
	readonly path: SipTransferCallPath;
	readonly transfers: { leg: ControlledLeg; request: TransferRequest }[];
	readonly joins: {
		transferor: ControlledLeg;
		consultation: ControlledLeg;
		destination: string;
	}[];
} {
	const transfers: { leg: ControlledLeg; request: TransferRequest }[] = [];
	const joins: {
		transferor: ControlledLeg;
		consultation: ControlledLeg;
		destination: string;
	}[] = [];
	const path: SipTransferCallPath = {
		resolveDialog: async () => {
			if (options.resolveThrows === true) {
				throw new Error("the registry is on fire");
			}
			return "resolved" in options ? options.resolved : "media-1";
		},
		legFor: (mediaChannelId) => {
			if (mediaChannelId === CONSULTATION_MEDIA_CHANNEL_ID) {
				return "consultationLeg" in options ? options.consultationLeg : consultationLeg();
			}
			return "leg" in options ? options.leg : leg();
		},
		...(options.dialable === undefined && options.dialableThrows !== true
			? {}
			: {
					isDialableTarget: async () => {
						if (options.dialableThrows === true) {
							throw new Error("the artifact source is on fire");
						}
						return options.dialable ?? true;
					},
				}),
		...(options.attended === true
			? {
					resolveReplacedDialog: async () => {
						if (options.replacedResolveThrows === true) {
							throw new Error("the registry is on fire");
						}
						return "replacedResolved" in options
							? options.replacedResolved
							: CONSULTATION_MEDIA_CHANNEL_ID;
					},
					completeAttendedTransfer: async (transferor, consultation, destination) => {
						joins.push({ transferor, consultation, destination });
						if (options.attendedThrows === true) {
							throw new Error("the media server is on fire");
						}
						return options.attendedResult ?? { ok: true, detail: "transferred" };
					},
				}
			: {}),
		transfer: async (target, transferRequest) => {
			transfers.push({ leg: target, request: transferRequest });
			if (options.transferThrows === true) {
				throw new Error("the media server is on fire");
			}
			return options.result ?? { ok: true, detail: "transferred" };
		},
	};
	return { path, transfers, joins };
}

/** A REFER carrying the `Replaces` of a consultation the phone completed itself. */
function attendedRequest(
	replaces: Partial<SipTransferRequest["replaces"]> = {},
): SipTransferRequest {
	return request({
		kind: "attended",
		target: { user: "1003", host: "acme.example.com" },
		replaces: { callId: "aa11@1.2.3.4", toTag: "b2", fromTag: "c3", earlyOnly: false, ...replaces },
	});
}

function service(
	fake: ReturnType<typeof fakeConnection>,
	path?: SipTransferCallPath,
): SipTransferService {
	const jetstream = { rawConnection: fake.connection } as unknown as JetStreamService;
	const built = new SipTransferService({ ENGINE_INSTANCE_ID: "engine-1" } as EngineEnv, jetstream);
	if (path !== undefined) {
		built.attach(path);
	}
	built.onApplicationBootstrap();
	return built;
}

describe("the sip transfer subscription", () => {
	it("answers on the flat contract subject, in a queue group so exactly one instance replies", () => {
		const fake = fakeConnection();
		const built = service(fake, callPath().path);

		expect(built.subject).toBe(subjectFor.sipTransferRpc());
		expect(fake.subscribed).toEqual([
			{ subject: "rpc.sip.v1.transfer", queue: "optimiq-engine-sip-transfer" },
		]);
		expect(built.stats.listening).toBe(true);
	});

	it("does not subscribe when the engine has no broker, rather than refusing to boot", () => {
		const jetstream = { rawConnection: undefined } as unknown as JetStreamService;
		const built = new SipTransferService(
			{ ENGINE_INSTANCE_ID: "engine-1" } as EngineEnv,
			jetstream,
		);
		built.onApplicationBootstrap();
		expect(built.stats.listening).toBe(false);
	});
});

describe("executing a transfer", () => {
	it("puts the contract on the wire, with no NestJS framing around it", async () => {
		const fake = fakeConnection();
		const path = callPath();
		const built = service(fake, path.path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies).toEqual([
			{
				ok: true,
				sipCallId: CALL_ID,
				instanceId: "engine-1",
				legId: "leg-1",
				callId: "call-1",
				destination: "1002",
			},
		]);
		expect(built.stats.served).toBe(1);
	});

	it("delegates to the existing transfer API as a blind transfer, and picks no routing context", async () => {
		const fake = fakeConnection();
		const path = callPath();
		service(fake, path.path);

		await fake.deliver(JSON.stringify(request()));

		expect(path.transfers).toHaveLength(1);
		// No `context`: CallControl defaults it to the internal namespace, and letting a request off
		// the SIP edge choose one would hand a phone the toll-fraud boundary.
		expect(path.transfers[0]?.request).toEqual({ kind: "blind", destination: "1002" });
		expect(path.transfers[0]?.leg.mediaChannelId).toBe("media-1");
	});

	it("goes ahead once the plan says the Refer-To is reachable", async () => {
		const fake = fakeConnection();
		const path = callPath({ dialable: true });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: true, destination: "1002" });
		expect(path.transfers).toHaveLength(1);
	});

	it("joins the two dialogs a Replaces names, and never dials the Refer-To", async () => {
		const fake = fakeConnection();
		const path = callPath({ attended: true });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(attendedRequest()));

		expect(fake.replies[0]).toEqual({
			ok: true,
			sipCallId: CALL_ID,
			instanceId: "engine-1",
			legId: "leg-1",
			callId: "call-1",
			destination: "1003",
		});
		expect(path.joins).toHaveLength(1);
		expect(path.joins[0]?.transferor.mediaChannelId).toBe("media-1");
		expect(path.joins[0]?.consultation.mediaChannelId).toBe(CONSULTATION_MEDIA_CHANNEL_ID);
		expect(path.joins[0]?.destination).toBe("1003");
		// A blind transfer would hang the transferor up and re-route the transferee, which is the one
		// thing an attended transfer must not do: the target is already answered and talking.
		expect(path.transfers).toHaveLength(0);
	});

	it("does not ask the dial plan about a target that is already on the phone", async () => {
		const fake = fakeConnection();
		const path = callPath({ attended: true, dialable: false });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(attendedRequest()));

		// `unknown_target` would refuse a legitimate transfer to anything reachable but not dialable.
		expect(fake.replies[0]).toMatchObject({ ok: true, destination: "1003" });
		expect(path.joins).toHaveLength(1);
	});

	it("accepts a REFER from the extension that ANSWERED the call, not only the one that placed it", async () => {
		const fake = fakeConnection();
		const path = callPath({
			leg: leg({ callerIdNumber: "+15551230000", destinationNumber: "1001" }),
		});
		service(fake, path.path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: true });
	});
});

describe("refusing a transfer", () => {
	it("refuses a payload that is not the contract, rather than staying silent", async () => {
		const fake = fakeConnection();
		service(fake, callPath().path);

		await fake.deliver('{"sipCallId":42}');

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "bad_request", sipCallId: "" });
	});

	it("refuses an attended transfer a call path cannot broker, without downgrading it", async () => {
		const fake = fakeConnection();
		const path = callPath();
		service(fake, path.path);

		await fake.deliver(JSON.stringify(attendedRequest()));

		// A downgrade would drop the consultation leg the user is currently talking to.
		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "attended_unsupported" });
		expect(path.transfers).toHaveLength(0);
	});

	it("refuses an attended transfer that names no consultation at all", async () => {
		const fake = fakeConnection();
		const path = callPath({ attended: true });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(request({ kind: "attended" })));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "bad_request" });
		expect(path.joins).toHaveLength(0);
	});

	it("refuses when the Replaces resolves to no live call on this instance", async () => {
		const fake = fakeConnection();
		const path = callPath({ attended: true, replacedResolved: undefined });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(attendedRequest()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "unknown_dialog", legId: "leg-1" });
		expect(path.joins).toHaveLength(0);
	});

	it("refuses when the consultation ended between the REFER and the join", async () => {
		const fake = fakeConnection();
		const path = callPath({ attended: true, consultationLeg: undefined });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(attendedRequest()));

		// The original call is untouched, so the phone can consult again.
		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "channel_gone" });
		expect(path.joins).toHaveLength(0);
	});

	it("refuses a Replaces that resolves into another tenant", async () => {
		const fake = fakeConnection();
		const path = callPath({
			attended: true,
			consultationLeg: consultationLeg({ organizationId: OTHER_ORG }),
		});
		service(fake, path.path);

		await fake.deliver(JSON.stringify(attendedRequest()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "not_permitted" });
		expect(path.joins).toHaveLength(0);
	});

	it("refuses a referrer who is not a party to the consultation they named", async () => {
		const fake = fakeConnection();
		const path = callPath({
			attended: true,
			consultationLeg: consultationLeg({ callerIdNumber: "2001", destinationNumber: "2002" }),
		});
		service(fake, path.path);

		// The engine cannot match the Replaces tags; being on BOTH calls is what authorises this.
		await fake.deliver(JSON.stringify(attendedRequest()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "not_permitted" });
		expect(path.joins).toHaveLength(0);
	});

	it("honours early-only against a dialog that is already confirmed", async () => {
		const fake = fakeConnection();
		const path = callPath({ attended: true });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(attendedRequest({ earlyOnly: true })));

		// RFC 3891 §3: a lost race must not cut somebody out of a live conversation.
		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "not_permitted" });
		expect(path.joins).toHaveLength(0);
	});

	it("reports a refused join as transfer_failed, leaving both calls up", async () => {
		const fake = fakeConnection();
		const path = callPath({
			attended: true,
			attendedResult: { ok: false, reason: "the consultation is not in a bridge" },
		});
		service(fake, path.path);

		await fake.deliver(JSON.stringify(attendedRequest()));

		expect(fake.replies[0]).toMatchObject({
			ok: false,
			reason: "transfer_failed",
			error: "the consultation is not in a bridge",
			legId: "leg-1",
		});
		expect(path.transfers).toHaveLength(0);
	});

	it("answers internal when resolving the Replaces throws", async () => {
		const fake = fakeConnection();
		const path = callPath({ attended: true, replacedResolveThrows: true });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(attendedRequest()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "internal" });
		expect(path.joins).toHaveLength(0);
	});

	it("answers internal when the join throws", async () => {
		const fake = fakeConnection();
		const path = callPath({ attended: true, attendedThrows: true });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(attendedRequest()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "internal", legId: "leg-1" });
	});

	it("refuses with correlation_unavailable when no call path is attached", async () => {
		const fake = fakeConnection();
		service(fake);

		await fake.deliver(JSON.stringify(request()));

		// The state of the engine TODAY: nothing records a SIP Call-ID, so nothing can resolve one.
		expect(fake.replies[0]).toMatchObject({
			ok: false,
			reason: "correlation_unavailable",
			sipCallId: CALL_ID,
			instanceId: "engine-1",
		});
	});

	it("distinguishes a dialog that resolved to nothing from one it could not look up", async () => {
		const fake = fakeConnection();
		service(fake, callPath({ resolved: undefined }).path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "unknown_dialog" });
	});

	it("refuses when the leg has gone between resolving the dialog and moving it", async () => {
		const fake = fakeConnection();
		service(fake, callPath({ leg: undefined }).path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "channel_gone" });
	});

	it("refuses a leg that is already tearing down", async () => {
		const fake = fakeConnection();
		service(fake, callPath({ leg: leg({ isTearingDown: true }) }).path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "channel_gone" });
	});

	it("refuses a Call-ID that resolves into another tenant", async () => {
		const fake = fakeConnection();
		const path = callPath({ leg: leg({ organizationId: OTHER_ORG }) });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "not_permitted" });
		expect(path.transfers).toHaveLength(0);
	});

	it("refuses a referrer who is not a party to the call it named", async () => {
		const fake = fakeConnection();
		const path = callPath({
			leg: leg({ callerIdNumber: "2001", destinationNumber: "2002" }),
		});
		service(fake, path.path);

		// The whole point: an authenticated extension guessing somebody else's Call-ID.
		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({
			ok: false,
			reason: "not_permitted",
			legId: "leg-1",
		});
		expect(path.transfers).toHaveLength(0);
	});

	it("refuses a Refer-To the plan cannot reach, without touching the call", async () => {
		const fake = fakeConnection();
		const path = callPath({ dialable: false });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({
			ok: false,
			reason: "unknown_target",
			legId: "leg-1",
		});
		// The whole point of checking first: a blind transfer hangs the transferor up and re-routes
		// the transferee, so attempting one at a destination that does not exist costs both of them
		// the call they are already on.
		expect(path.transfers).toHaveLength(0);
	});

	it("checks the target only AFTER the referrer has been authorised", async () => {
		const fake = fakeConnection();
		const path = callPath({ leg: leg({ organizationId: OTHER_ORG }), dialable: false });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(request()));

		// Otherwise an unauthorised request could probe another tenant's dial plan by timing.
		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "not_permitted" });
	});

	it("answers internal when the target check throws", async () => {
		const fake = fakeConnection();
		const path = callPath({ dialableThrows: true });
		service(fake, path.path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "internal", legId: "leg-1" });
		expect(path.transfers).toHaveLength(0);
	});

	it("reports the call path's own refusal reason as transfer_failed", async () => {
		const fake = fakeConnection();
		service(fake, callPath({ result: { ok: false, reason: "no route to 1002" } }).path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({
			ok: false,
			reason: "transfer_failed",
			error: "no route to 1002",
			legId: "leg-1",
		});
	});

	it("answers internal when resolution throws, because a silence costs the whole deadline", async () => {
		const fake = fakeConnection();
		service(fake, callPath({ resolveThrows: true }).path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "internal" });
	});

	it("answers internal when the transfer throws", async () => {
		const fake = fakeConnection();
		service(fake, callPath({ transferThrows: true }).path);

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "internal", legId: "leg-1" });
	});

	it("refuses with shutting_down once the instance is draining", async () => {
		const fake = fakeConnection();
		const built = service(fake, callPath().path);
		built.onApplicationShutdown();

		await fake.deliver(JSON.stringify(request()));

		expect(fake.replies[0]).toMatchObject({ ok: false, reason: "shutting_down" });
	});
});
