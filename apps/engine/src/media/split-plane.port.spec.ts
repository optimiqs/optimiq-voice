import { describe, expect, it } from "bun:test";
import { RPC_SUBJECTS } from "@optimiq-voice/events";
import { hangupCauseCode } from "@optimiq-voice/telephony";
import { MediaOperationNotSupportedError } from "./media-not-supported.error";
import { MediadMediaPort } from "./mediad-media.port";
import { FakeMediadTransport } from "./mediad-transport.fake";
import { SipRenegotiateService } from "./sip-renegotiate.service";
import {
	CLIR_VARIABLE,
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
	/** When set, `ring` refuses — an edge that will not carry a 183 for this dialog. */
	refuseRing = false;
	refuseOriginate = false;
	/** The instance the originate reply names, which the composite must record for later commands. */
	originateInstanceId: string | undefined = "sipd-out-1";
	/** The dialog `Call-ID` the originate reply names. The only place this side is ever told it. */
	originateSipCallId: string | undefined = "9f1c2b7ae4@carrier.test";

	async ring(instanceId: string, request: SipRingRequest): Promise<SipRingResponse> {
		this.ringCalls.push({ instanceId, request });
		if (this.refuseRing) {
			return { ok: false, legId: request.legId, reason: "not_supported", error: "no early media" };
		}
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
		return {
			ok: true,
			legId: request.legId,
			instanceId: this.originateInstanceId,
			...(this.originateSipCallId === undefined ? {} : { sipCallId: this.originateSipCallId }),
		};
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

describe("early media", () => {
	function inbound(port: SplitPlaneMediaPort): void {
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});
	}

	it("allocates a mediad session then sends a 183 carrying the answer", async () => {
		const { port, transport, sipd } = newComposite();
		inbound(port);

		await port.earlyMedia(CH);

		const allocate = transport.on(RPC_SUBJECTS.mediaAllocateSession)[0]?.payload as Record<
			string,
			unknown
		>;
		expect(allocate["sessionId"]).toBe(CH);
		expect(allocate["sdpOffer"]).toBe(OFFER);
		expect(sipd.ringCalls).toHaveLength(1);
		expect(sipd.ringCalls[0]?.instanceId).toBe(INSTANCE);
		expect(sipd.ringCalls[0]?.request.status).toBe(183);
		expect(sipd.ringCalls[0]?.request.sdpAnswer).toContain("v=0");
	});

	/**
	 * A carrier that sends 183, then 180, then 183 again is ordinary. Renegotiating the caller on each
	 * one would allocate a second session for a leg that has one and cut the announcement they are
	 * listening to in half.
	 */
	it("is idempotent across a chatty carrier's repeated 18x", async () => {
		const { port, transport, sipd } = newComposite();
		inbound(port);

		await port.earlyMedia(CH);
		await port.earlyMedia(CH);
		await port.earlyMedia(CH);

		expect(transport.on(RPC_SUBJECTS.mediaAllocateSession)).toHaveLength(1);
		expect(sipd.ringCalls).toHaveLength(1);
	});

	/** RFC 3261 §13.2.1: the 200 repeats the answer the 183 committed, byte for byte. */
	it("makes the later 200 OK repeat the 183's answer rather than negotiating a second one", async () => {
		const { port, transport, sipd } = newComposite();
		inbound(port);

		await port.earlyMedia(CH);
		await port.answer(CH);

		expect(transport.on(RPC_SUBJECTS.mediaAllocateSession)).toHaveLength(1);
		expect(sipd.answerCalls).toHaveLength(1);
		expect(sipd.answerCalls[0]?.request.sdpAnswer).toBe(
			sipd.ringCalls[0]?.request.sdpAnswer as string,
		);
	});

	it("releases the session it allocated when the edge refuses the 183, and stays unlatched", async () => {
		const { port, transport, sipd } = newComposite();
		sipd.refuseRing = true;
		inbound(port);

		await expect(port.earlyMedia(CH)).rejects.toThrow(/refused by the sip edge/);

		expect(transport.on(RPC_SUBJECTS.mediaReleaseSession)).toHaveLength(1);
		// A refused response committed no exchange, so a later answer must negotiate for itself
		// rather than repeating bytes the caller never received.
		sipd.refuseRing = false;
		await port.answer(CH);
		expect(transport.on(RPC_SUBJECTS.mediaAllocateSession)).toHaveLength(2);
	});

	it("throws when the leg was never registered", async () => {
		const { port } = newComposite();
		await expect(port.earlyMedia(CH)).rejects.toThrow(SplitPlaneLegStateError);
	});

	/** The only path from a walker-dialled B-leg back to the caller: it has no registry entry. */
	it("records the leg an origination was placed for", async () => {
		const { port, transport, sipd } = newComposite();
		sipd.resolveTarget = async () => ({
			ok: true,
			legId: CH,
			instanceId: INSTANCE,
			transport: "udp",
			requestUri: "sip:1002@device",
		});
		transport.reply(RPC_SUBJECTS.mediaCreateOffer, { ok: true, sessionId: CH, sdpOffer: OFFER });
		port.registerOutboundLeg(CH, { orgId: ORG, callId: CALL });

		await port.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: CH,
			originatorChannelId: "a-leg-1",
			target: { kind: "aor", aor: "sip:1002@realm" },
		});

		expect(port.originatorOf(CH)).toBe("a-leg-1");
		port.forget(CH);
		expect(port.originatorOf(CH)).toBeUndefined();
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

		// The reply's SIP `Call-ID` was recorded. There is no `CHANNEL(pjsip,call-id)` on this plane —
		// the orchestrator's fallback read is an Asterisk function this port answers out of a local
		// map nothing else writes — so without this stamp an originated leg has no dialog identity at
		// all: its CDR row carries no `sip_call_id` and `resolveSipDialog` cannot find it, which is
		// what made the engine answer `unknown_dialog` to a REFER the ANSWERING party sent.
		expect(await port.getVariable(CH, "OPTIMIQ_SIP_CALL_ID")).toBe("9f1c2b7ae4@carrier.test");

		// The reply's instance was recorded: a later hangup is addressed at it and not at nothing.
		await port.hangup(CH, "NORMAL_CLEARING");
		expect(sipd.hangupCalls[0]?.instanceId).toBe("sipd-out-1");
	});

	it("leaves the dialog variable alone when the originate reply names no Call-ID", async () => {
		// An older edge, or one that could not read its own dialog back. Absent is honest: the
		// orchestrator falls through to its other source rather than indexing an empty key.
		const { port, transport, sipd } = newComposite();
		sipd.originateSipCallId = undefined;
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
		await port.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: CH,
			target: { kind: "aor", aor: "sip:1002@realm" },
		});
		expect(await port.getVariable(CH, "OPTIMIQ_SIP_CALL_ID")).toBeUndefined();
	});

	it("carries callerIdPresentation to sipd, and OPTIMIQ_CLIR beats the setting", async () => {
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

		// No setting and no override: the field is absent, which the edge reads as `allowed`.
		await port.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: CH,
			target: { kind: "aor", aor: "sip:1002@realm" },
		});
		expect(sipd.originateCalls[0]?.callerIdPresentation).toBeUndefined();

		// The setting alone.
		await port.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: CH,
			target: { kind: "aor", aor: "sip:1002@realm" },
			callerIdPresentation: "restricted",
		});
		expect(sipd.originateCalls[1]?.callerIdPresentation).toBe("restricted");

		// The override wins over it — a caller who dialled `*82` un-withholds a restricted extension.
		await port.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: CH,
			target: { kind: "aor", aor: "sip:1002@realm" },
			callerIdPresentation: "restricted",
			variables: { [CLIR_VARIABLE]: "allowed" },
		});
		expect(sipd.originateCalls[2]?.callerIdPresentation).toBe("allowed");

		// An override stamped on the ORIGINATING leg reaches the B-leg the walk dials.
		await port.setVariable("caller-leg", CLIR_VARIABLE, "restricted");
		await port.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: CH,
			target: { kind: "aor", aor: "sip:1002@realm" },
			originatorChannelId: "caller-leg",
		});
		expect(sipd.originateCalls[3]?.callerIdPresentation).toBe("restricted");

		// Nonsense falls through to the setting rather than failing the dial.
		await port.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: CH,
			target: { kind: "aor", aor: "sip:1002@realm" },
			callerIdPresentation: "restricted",
			variables: { [CLIR_VARIABLE]: "maybe" },
		});
		expect(sipd.originateCalls[4]?.callerIdPresentation).toBe("restricted");
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

	/**
	 * A relay that has died holding the session cannot confirm the release, and it has no session
	 * left to leak on its side either. The throw used to come out of the `finally` and skip
	 * `forget`, so the leg stayed pinned here — and counted in `activeChannels` — for the life of
	 * the process, which is what a `mediad` crash turned every live call into.
	 */
	it("BYEs and forgets the leg even when the media relay never answers the release", async () => {
		const { port, transport, sipd } = newComposite();
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});
		transport.failure = new Error("mediad is gone");

		await port.hangup(CH, "NORMAL_CLEARING");

		expect(sipd.hangupCalls).toHaveLength(1);
		await expect(port.ring(CH)).rejects.toThrow(SplitPlaneLegStateError);
	});

	/**
	 * The plane-loss teardown's cost. Once the relay is known to be gone, a release is not attempted
	 * at all: the outcome is identical, and paying the RPC timeout once per leg is the difference
	 * between ending fifty calls in a moment and ending them over half a minute.
	 */
	it("skips the media release entirely once the relay is declared lost", async () => {
		const { port, transport, sipd } = newComposite();
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});
		port.setMediaPlaneLost(true);

		await port.hangup(CH, "NORMAL_TEMPORARY_FAILURE");

		expect(transport.on(RPC_SUBJECTS.mediaReleaseSession)).toHaveLength(0);
		// The BYE still goes out: `sipd` is the plane that is still there, and it is the only thing
		// that can tell both parties the call is over.
		expect(sipd.hangupCalls).toHaveLength(1);
		await expect(port.ring(CH)).rejects.toThrow(SplitPlaneLegStateError);
	});

	/** The index the signalling-plane teardown reads: which legs died with which `sipd`. */
	it("lists the legs each sip instance holds, and forgets them on teardown", async () => {
		const { port } = newComposite();
		const other = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b54";
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});
		port.registerInboundLeg(other, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: "sipd-other",
			sdpOffer: OFFER,
		});

		expect(port.legsForInstance(INSTANCE)).toEqual([CH]);
		expect([...port.legIds].sort()).toEqual([CH, other].sort());

		port.forget(CH);
		expect(port.legsForInstance(INSTANCE)).toEqual([]);
	});

	it("forgets a remotely ended leg even when the media relay never answers the release", async () => {
		const { port, transport } = newComposite();
		port.registerInboundLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			sdpOffer: OFFER,
		});
		transport.failure = new Error("mediad is gone");

		await port.releaseEndedLeg(CH);

		await expect(port.ring(CH)).rejects.toThrow(SplitPlaneLegStateError);
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
		// Each contact carries the edge that answered for it, so the dial does not re-resolve what
		// this call already resolved. See `DialTarget.resolvedEdge`.
		const edge = { instanceId: INSTANCE, transport: "udp" as const };
		expect(groups).toEqual([
			[{ kind: "aor", aor: "sip:1002@realm", contactUri: "sip:a@one", resolvedEdge: edge }],
			[{ kind: "aor", aor: "sip:1002@realm", contactUri: "sip:b@two", resolvedEdge: edge }],
		]);
	});

	it("dials a resolved contact without asking the edge to resolve it a second time", async () => {
		const { port, transport, sipd } = newComposite();
		let resolves = 0;
		sipd.resolveTarget = async (request) => {
			resolves += 1;
			return {
				ok: true,
				legId: request.legId,
				contacts: [
					{ requestUri: "sip:a@one", transport: "wss" as const, instanceId: INSTANCE, q: 1 },
				],
			};
		};
		const [group] = await port.resolveTargets(ORG, { kind: "aor", aor: "sip:1002@realm" }, CH);
		expect(resolves).toBe(1);

		transport.reply(RPC_SUBJECTS.mediaCreateOffer, { ok: true, sessionId: CH, sdpOffer: OFFER });
		port.registerOutboundLeg(CH, { orgId: ORG, callId: CALL });
		await port.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: CH,
			target: group?.[0],
		});

		// Still one resolve: the walk's answer was reused rather than asked for again.
		expect(resolves).toBe(1);
		// And the carried edge still drives both decisions the second lookup used to make.
		expect(transport.on(RPC_SUBJECTS.mediaCreateOffer)[0]?.payload).toMatchObject({
			transport: "webrtc",
		});
		expect(sipd.originateOwners[0]).toBe(INSTANCE);
		// The target that reached the edge is the WIRE shape, with no engine-local note on it.
		expect(sipd.originateCalls[0]?.target).toEqual({
			kind: "aor",
			aor: "sip:1002@realm",
			contactUri: "sip:a@one",
		});
	});

	it("attributes a refusal to the real leg", async () => {
		const { port, sipd } = newComposite();
		sipd.resolveTarget = async () => ({ ok: false, legId: CH, reason: "unregistered_target" });
		await expect(
			port.resolveTargets(ORG, { kind: "aor", aor: "sip:1002@realm" }, CH),
		).rejects.toThrow(new RegExp(`resolve-targets ${CH} refused by the sip edge`));
	});
});

describe("adoption after an engine replica dies", () => {
	/**
	 * The half of adoption that was missing, and the reason it was expensive to miss.
	 *
	 * Everything this port holds is in memory by nature, so a survivor that rebuilt the aggregate
	 * from the `channels` snapshot still had no leg record — and `hangup` TOLERATES a missing leg, so
	 * the adopted call's BYE was never sent. The aggregate was torn down and the CDR filed while both
	 * phones were still up and still hearing each other. Dropping `registerAdoptedLeg` from the
	 * orchestrator's install path makes `sipd.hangupCalls` empty here, which is exactly that bug.
	 */
	it("sends the BYE for a leg adopted from a dead engine", async () => {
		const { port, transport, sipd } = newComposite();
		port.registerAdoptedLeg(CH, { orgId: ORG, callId: CALL, sipdInstanceId: INSTANCE });

		await port.hangup(CH, "NORMAL_CLEARING");

		expect(sipd.hangupCalls).toHaveLength(1);
		expect(sipd.hangupCalls[0]?.instanceId).toBe(INSTANCE);
		expect(transport.on(RPC_SUBJECTS.mediaReleaseSession)).toHaveLength(1);
	});

	/**
	 * The variable store is the SOURCE of truth on this plane — there is no dialplan and no media
	 * server holding a copy — so an adopted leg with an empty store answers every read `undefined`,
	 * which is how a resumed call loses its recording flag and its CDR cause.
	 */
	it("restores the adopted leg's channel variables", async () => {
		const { port } = newComposite();
		port.registerAdoptedLeg(CH, {
			orgId: ORG,
			callId: CALL,
			sipdInstanceId: INSTANCE,
			variables: { OPTIMIQ_SIPD_INSTANCE_ID: INSTANCE, OPTIMIQ_CDR_HANGUP_CAUSE_CODE: "16" },
		});

		expect(await port.getVariable(CH, "OPTIMIQ_CDR_HANGUP_CAUSE_CODE")).toBe("16");
		expect(port.legsForInstance(INSTANCE)).toEqual([CH]);
	});

	/**
	 * The SDP offer does not travel in the snapshot and is deliberately NOT invented. An adopted leg
	 * is already answered, and `answer` is the only operation that wants the offer — failing loudly
	 * beats answering a second call with a body from the first.
	 */
	it("refuses to answer an adopted leg rather than inventing an offer", async () => {
		const { port } = newComposite();
		port.registerAdoptedLeg(CH, { orgId: ORG, callId: CALL, sipdInstanceId: INSTANCE });

		await expect(port.answer(CH)).rejects.toThrow(SplitPlaneLegStateError);
	});
});
