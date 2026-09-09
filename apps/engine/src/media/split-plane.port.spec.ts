import { describe, expect, it } from "bun:test";
import { RPC_SUBJECTS } from "@optimiq-voice/events";
import { hangupCauseCode } from "@optimiq-voice/telephony";
import { MediaOperationNotSupportedError } from "./media-not-supported.error";
import { MediadMediaPort } from "./mediad-media.port";
import { FakeMediadTransport } from "./mediad-transport.fake";
import { SipRenegotiateService } from "./sip-renegotiate.service";
import {
	SplitPlaneBadRequestError,
	SplitPlaneLegStateError,
	SplitPlaneMediaPort,
} from "./split-plane.port";
import type { SipdCommandPort } from "../nats/sipd-command.client";
import type {
	SipAnswerRequest,
	SipAnswerResponse,
	SipHangupRequest,
	SipHangupResponse,
	SipOriginateRequest,
	SipOriginateResponse,
	SipReinviteRequest,
	SipReinviteResponse,
	SipRingRequest,
	SipRingResponse,
	SipResolveTargetRequest,
	SipResolveTargetResponse,
} from "@optimiq-voice/events";

const TIMEOUT_MS = 500;
const ORG = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293";
const CALL = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4c";
const CH = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b53";
const INSTANCE = "sipd-7c9f";

const OFFER =
	"v=0\r\no=- 12345 1 IN IP4 203.0.113.9\r\ns=-\r\nc=IN IP4 203.0.113.9\r\nt=0 0\r\n" +
	"m=audio 41000 RTP/AVP 0 8 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\n";

/**
 * A {@link SipdCommandPort} that records every command and replies `ok` by default.
 *
 * The signalling half of the composite's seam, exactly as {@link FakeMediadTransport} is the media
 * half: a spec can drive the whole port with no broker on either plane.
 */
class FakeSipdCommandPort implements SipdCommandPort {
	readonly ringCalls: { instanceId: string; request: SipRingRequest }[] = [];
	readonly answerCalls: { instanceId: string; request: SipAnswerRequest }[] = [];
	readonly hangupCalls: { instanceId: string; request: SipHangupRequest }[] = [];
	readonly originateCalls: SipOriginateRequest[] = [];
	readonly originateOwners: (string | undefined)[] = [];
	resolveTarget?: (request: SipResolveTargetRequest) => Promise<SipResolveTargetResponse>;

	/** When set, `answer` refuses — the CANCEL-lost-the-race branch (§4.4). */
	refuseAnswer = false;
	refuseOriginate = false;
	/** The instance the originate reply names, which the composite must record for later commands. */
	originateInstanceId: string | undefined = "sipd-out-1";

	async ring(instanceId: string, request: SipRingRequest): Promise<SipRingResponse> {
		this.ringCalls.push({ instanceId, request });
		return { ok: true, legId: request.legId, instanceId };
	}

	async answer(instanceId: string, request: SipAnswerRequest): Promise<SipAnswerResponse> {
		this.answerCalls.push({ instanceId, request });
		if (this.refuseAnswer) {
			return { ok: false, legId: request.legId, reason: "dialog_gone", error: "cancelled" };
		}
		return { ok: true, legId: request.legId, instanceId };
	}

	async hangup(instanceId: string, request: SipHangupRequest): Promise<SipHangupResponse> {
		this.hangupCalls.push({ instanceId, request });
		return { ok: true, legId: request.legId, instanceId, method: "bye" };
	}

	async reinvite(instanceId: string, request: SipReinviteRequest): Promise<SipReinviteResponse> {
		return { ok: true, legId: request.legId, instanceId };
	}

	async originate(
		request: SipOriginateRequest,
		instanceId?: string,
	): Promise<SipOriginateResponse> {
		this.originateCalls.push(request);
		this.originateOwners.push(instanceId);
		if (this.refuseOriginate)
			return { ok: false, legId: request.legId, reason: "internal", error: "timeout" };
		return { ok: true, legId: request.legId, instanceId: this.originateInstanceId };
	}
}

function newComposite(): {
	port: SplitPlaneMediaPort;
	media: MediadMediaPort;
	transport: FakeMediadTransport;
	sipd: FakeSipdCommandPort;
} {
	const transport = new FakeMediadTransport();
	const media = new MediadMediaPort(transport, TIMEOUT_MS);
	const sipd = new FakeSipdCommandPort();
	return { port: new SplitPlaneMediaPort(media, sipd), media, transport, sipd };
}

describe("answer", () => {
	it("allocates a mediad session then sends sipd.answer with the returned SDP", async () => {
		const { port, transport, sipd } = newComposite();
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});

		await port.answer(CH);

		// Media first: the allocate carried the A-leg's offer under the leg's own session id.
		const allocate = transport.on(RPC_SUBJECTS.mediaAllocateSession)[0]?.payload as Record<
			string,
			unknown
		>;
		expect(allocate["sessionId"]).toBe(CH);
		expect(allocate["sdpOffer"]).toBe(OFFER);

		// Then the 200 OK, addressed at the owning instance, carrying the answer mediad produced.
		expect(sipd.answerCalls).toHaveLength(1);
		expect(sipd.answerCalls[0]?.instanceId).toBe(INSTANCE);
		expect(sipd.answerCalls[0]?.request.legId).toBe(CH);
		expect(sipd.answerCalls[0]?.request.sdpAnswer).toContain("v=0");
	});

	it("throws when the leg was never registered", async () => {
		const { port } = newComposite();
		await expect(port.answer(CH)).rejects.toThrow(SplitPlaneLegStateError);
	});

	it("throws a signalling refusal when the edge lost the race to a CANCEL", async () => {
		const { port, sipd } = newComposite();
		sipd.refuseAnswer = true;
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});

		await expect(port.answer(CH)).rejects.toThrow(/refused by the sip edge/);
	});

	/**
	 * The refusal above is a NORMAL outcome, and in the race that causes it the `dialog.terminated`
	 * has usually already torn the aggregate down — so nothing downstream would ever release the
	 * session just allocated. Same shape as `originate`'s cleanup, for the same reason.
	 */
	it("releases the session it allocated when signalling refuses the answer", async () => {
		const { port, transport, sipd, media } = newComposite();
		sipd.refuseAnswer = true;
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});

		await expect(port.answer(CH)).rejects.toThrow(/refused by the sip edge/);

		expect(transport.on(RPC_SUBJECTS.mediaReleaseSession)).toHaveLength(1);
		expect(await media.channelExists(CH)).toBe(false);
	});
});

describe("ring", () => {
	it("sends a 180 to the owning instance", async () => {
		const { port, sipd } = newComposite();
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});

		await port.ring(CH);

		expect(sipd.ringCalls).toHaveLength(1);
		expect(sipd.ringCalls[0]?.instanceId).toBe(INSTANCE);
		expect(sipd.ringCalls[0]?.request.legId).toBe(CH);
		expect(sipd.ringCalls[0]?.request.status).toBe(180);
	});
});

describe("originate", () => {
	it("cleans up media and the resolved SIP owner when an originate reply is lost", async () => {
		const { port, transport, sipd } = newComposite();
		sipd.resolveTarget = async () => ({
			ok: true,
			legId: CH,
			instanceId: INSTANCE,
			transport: "udp",
			requestUri: "sip:phone@device",
		});
		sipd.refuseOriginate = true;
		transport.reply(RPC_SUBJECTS.mediaCreateOffer, { ok: true, sessionId: CH, sdpOffer: OFFER });
		port.registerOutboundLeg(CH, { orgId: ORG, callId: CALL });
		await expect(
			port.originate({
				endpoint: "PJSIP/1002",
				application: "engine",
				channelId: CH,
				target: { kind: "aor", aor: "sip:1002@realm" },
			}),
		).rejects.toThrow(/timeout/);
		expect(sipd.hangupCalls[0]?.instanceId).toBe(INSTANCE);
		expect(transport.on(RPC_SUBJECTS.mediaReleaseSession)).toHaveLength(1);
	});

	it("selects WebRTC and pins origination to the registered browser's contact and SIP owner", async () => {
		const { port, transport, sipd } = newComposite();
		sipd.resolveTarget = async () => ({
			ok: true,
			legId: CH,
			instanceId: INSTANCE,
			transport: "wss",
			requestUri: "sip:browser@random.invalid;transport=ws",
		});
		transport.reply(RPC_SUBJECTS.mediaCreateOffer, { ok: true, sessionId: CH, sdpOffer: OFFER });
		port.registerOutboundLeg(CH, { orgId: ORG, callId: CALL });
		await port.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: CH,
			target: { kind: "aor", aor: "sip:1002@realm" },
		});
		expect(transport.on(RPC_SUBJECTS.mediaCreateOffer)[0]?.payload).toMatchObject({
			transport: "webrtc",
		});
		expect(sipd.originateCalls[0]?.target).toEqual({
			kind: "aor",
			aor: "sip:1002@realm",
			contactUri: "sip:browser@random.invalid;transport=ws",
		});
		expect(sipd.originateOwners).toEqual([INSTANCE]);
	});

	it("does not allocate media when the destination is unregistered", async () => {
		const { port, transport, sipd } = newComposite();
		sipd.resolveTarget = async () => ({ ok: false, legId: CH, reason: "unregistered_target" });
		port.registerOutboundLeg(CH, { orgId: ORG, callId: CALL });
		await expect(
			port.originate({
				endpoint: "PJSIP/1002",
				application: "engine",
				channelId: CH,
				target: { kind: "aor", aor: "sip:1002@realm" },
			}),
		).rejects.toThrow(/refused by the sip edge/);
		expect(transport.requests).toHaveLength(0);
		expect(sipd.originateCalls).toHaveLength(0);
	});

	it("creates an offer, sends sipd.originate with target and offer, and records the instance", async () => {
		const { port, transport, sipd } = newComposite();
		transport.reply(RPC_SUBJECTS.mediaCreateOffer, {
			ok: true,
			sessionId: CH,
			sdpOffer: OFFER,
			instanceId: "mediad-fake",
			address: "203.0.113.10",
			rtpPort: 30_000,
			rtcpPort: 30_001,
			telephoneEventPayloadType: 101,
		});
		port.registerOutboundLeg(CH, { orgId: ORG, callId: CALL });

		const result = await port.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: CH,
			variables: {
				"PJSIP_HEADER(add,Alert-Info)": "<sip:localhost>;info=alert-autoanswer",
				"PJSIP_HEADER(add,Call-Info)": "<sip:localhost>;answer-after=0",
				"PJSIP_HEADER(add,Authorization)": "must-not-forward",
			},
			target: { kind: "aor", aor: "sip:1002@realm" },
		});

		expect(result.channelId).toBe(CH);
		expect(transport.on(RPC_SUBJECTS.mediaCreateOffer)).toHaveLength(1);
		expect(sipd.originateCalls).toHaveLength(1);
		expect(sipd.originateCalls[0]?.target).toEqual({ kind: "aor", aor: "sip:1002@realm" });
		expect(sipd.originateCalls[0]?.sdpOffer).toBe(OFFER);

		expect(sipd.originateCalls[0]?.headers).toEqual({
			"Alert-Info": "<sip:localhost>;info=alert-autoanswer",
			"Call-Info": "<sip:localhost>;answer-after=0",
		});

		// The reply's instance was recorded: a later hangup is addressed at it and not at nothing.
		await port.hangup(CH, "NORMAL_CLEARING");
		expect(sipd.hangupCalls[0]?.instanceId).toBe("sipd-out-1");
	});

	it("throws bad_request when no dial target is present", async () => {
		const { port } = newComposite();
		port.registerOutboundLeg(CH, { orgId: ORG, callId: CALL });

		await expect(
			port.originate({ endpoint: "PJSIP/1002", application: "engine", channelId: CH }),
		).rejects.toThrow(SplitPlaneBadRequestError);
	});
});

describe("hangup", () => {
	it("BYEs the dialog then releases the media", async () => {
		const { port, transport, sipd } = newComposite();
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});

		await port.hangup(CH, "NORMAL_CLEARING");

		// Signalling half, with the domain cause mapped to its Q.850 code.
		expect(sipd.hangupCalls).toHaveLength(1);
		expect(sipd.hangupCalls[0]?.instanceId).toBe(INSTANCE);
		expect(sipd.hangupCalls[0]?.request.cause).toBe(hangupCauseCode("NORMAL_CLEARING"));
		// Media half, after it.
		expect(transport.on(RPC_SUBJECTS.mediaReleaseSession)).toHaveLength(1);
	});

	it("tolerates a leg with no known instance and just releases media", async () => {
		const { port, transport, sipd } = newComposite();
		port.registerOutboundLeg(CH, { orgId: ORG, callId: CALL });

		await port.hangup(CH, "NORMAL_CLEARING");

		expect(sipd.hangupCalls).toHaveLength(0);
		expect(transport.on(RPC_SUBJECTS.mediaReleaseSession)).toHaveLength(1);
	});
});

describe("channel variables (§3.4)", () => {
	it("round-trips through the local store with no wire trip on either plane", async () => {
		const { port, transport, sipd } = newComposite();

		expect(await port.getVariable(CH, "OPTIMIQ_LEG")).toBeUndefined();
		await port.setVariable(CH, "OPTIMIQ_LEG", "b");
		expect(await port.getVariable(CH, "OPTIMIQ_LEG")).toBe("b");

		expect(transport.requests).toHaveLength(0);
		expect(sipd.ringCalls).toHaveLength(0);
		expect(sipd.answerCalls).toHaveLength(0);
	});

	it("forgets a leg's variables on forget", async () => {
		const { port } = newComposite();
		await port.setVariable(CH, "OPTIMIQ_LEG", "b");
		port.forget(CH);
		expect(await port.getVariable(CH, "OPTIMIQ_LEG")).toBeUndefined();
	});
});

describe("delegation and refusals", () => {
	it("delegates bridgeMode to the media plane", () => {
		const { port, media } = newComposite();
		expect(port.bridgeMode).toBe(media.bridgeMode);
	});

	it("refuses snoop, naming both planes", async () => {
		const { port } = newComposite();
		const attempt = port.snoop({
			channelId: CH,
			snoopChannelId: "snoop-1",
			application: "engine",
			spy: "both",
		});
		await expect(attempt).rejects.toThrow(MediaOperationNotSupportedError);
		try {
			await attempt;
		} catch (error) {
			expect((error as MediaOperationNotSupportedError).operation).toBe("snoop");
			expect((error as MediaOperationNotSupportedError).driver).toBe("split-plane");
		}
	});

	it("refuses echo, naming both planes", async () => {
		const { port } = newComposite();
		const attempt = port.echo(CH);
		await expect(attempt).rejects.toThrow(MediaOperationNotSupportedError);
		try {
			await attempt;
		} catch (error) {
			expect((error as MediaOperationNotSupportedError).operation).toBe("echo");
			expect((error as MediaOperationNotSupportedError).driver).toBe("split-plane");
		}
	});
});

describe("remote SDP renegotiation", () => {
	it("refuses another tenant, call, SIP owner and an ended leg before media allocation", async () => {
		const { port, transport } = newComposite();
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});
		const request = {
			legId: CH,
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		};
		for (const invalid of [
			{ ...request, orgId: "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b50" },
			{ ...request, callId: "other" },
			{ ...request, sipdInstanceId: "another-edge" },
		]) {
			expect(await port.renegotiate(invalid)).toEqual({
				ok: false,
				legId: CH,
				reason: "unknown_leg",
			});
		}
		port.forget(CH);
		expect((await port.renegotiate(request)).reason).toBe("unknown_leg");
		expect(transport.requests).toHaveLength(0);
	});

	it("returns the media answer for the existing session and surfaces a refused offer", async () => {
		const { port, transport } = newComposite();
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});
		const answer = OFFER + "a=recvonly\r\n";
		transport.reply(RPC_SUBJECTS.mediaAllocateSession, {
			ok: true,
			sessionId: CH,
			sdpAnswer: answer,
		});
		const request = {
			legId: CH,
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER + "a=sendonly\r\n",
		};
		expect(await port.renegotiate(request)).toEqual({ ok: true, legId: CH, sdpAnswer: answer });
		expect(transport.on(RPC_SUBJECTS.mediaAllocateSession)[0]?.payload).toMatchObject({
			sessionId: CH,
			sdpOffer: request.sdpOffer,
		});
		transport.reply(RPC_SUBJECTS.mediaAllocateSession, {
			ok: false,
			sessionId: CH,
			reason: "not_supported",
		});
		expect((await port.renegotiate(request)).reason).toBe("not_supported");
	});

	it("bounds the RPC input and refuses renegotiation during shutdown", async () => {
		const { port, transport } = newComposite();
		const service = new SipRenegotiateService(
			{ ENGINE_INSTANCE_ID: "engine-test" } as never,
			{} as never,
			port,
		);
		expect((await service.answer(new TextEncoder().encode("{"))).reason).toBe("bad_request");
		service.onApplicationShutdown();
		const request = {
			legId: CH,
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		};
		expect((await service.answer(new TextEncoder().encode(JSON.stringify(request)))).reason).toBe(
			"shutting_down",
		);
		expect(transport.requests).toHaveLength(0);
	});
});

describe("remote hangup cleanup", () => {
	it("releases the media session without sending another SIP hangup", async () => {
		const { port, transport, sipd } = newComposite();
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});
		await port.answer(CH);
		await port.releaseEndedLeg(CH);
		expect(
			transport.requests.some((request) =>
				request.subject.startsWith(RPC_SUBJECTS.mediaReleaseSession),
			),
		).toBe(true);
		expect(sipd.hangupCalls).toHaveLength(0);
		await expect(port.ring(CH)).rejects.toThrow(SplitPlaneLegStateError);
	});
});

describe("resolveTargets", () => {
	it("asks the sip edge on behalf of the leg being planned, not a fabricated id", async () => {
		const { port, sipd } = newComposite();
		const asked: string[] = [];
		sipd.resolveTarget = async (request) => {
			asked.push(request.legId);
			return {
				ok: true,
				legId: request.legId,
				contacts: [
					{ requestUri: "sip:a@one", transport: "udp" as const, instanceId: INSTANCE, q: 1 },
					{ requestUri: "sip:b@two", transport: "udp" as const, instanceId: INSTANCE, q: 0.5 },
				],
			};
		};
		const groups = await port.resolveTargets(ORG, { kind: "aor", aor: "sip:1002@realm" }, CH);
		expect(asked).toEqual([CH]);
		expect(groups).toEqual([
			[{ kind: "aor", aor: "sip:1002@realm", contactUri: "sip:a@one" }],
			[{ kind: "aor", aor: "sip:1002@realm", contactUri: "sip:b@two" }],
		]);
	});

	it("attributes a refusal to the real leg", async () => {
		const { port, sipd } = newComposite();
		sipd.resolveTarget = async () => ({ ok: false, legId: CH, reason: "unregistered_target" });
		await expect(
			port.resolveTargets(ORG, { kind: "aor", aor: "sip:1002@realm" }, CH),
		).rejects.toThrow(new RegExp(`resolve-targets ${CH} refused by the sip edge`));
	});
});
