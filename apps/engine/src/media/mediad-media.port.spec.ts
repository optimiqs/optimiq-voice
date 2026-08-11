import { describe, expect, it } from "bun:test";
import {
	mediaAllocateSessionRequestSchema,
	mediaBridgeSessionsRequestSchema,
	mediaReleaseSessionRequestSchema,
	mediaSendDtmfRequestSchema,
	mediaStartPlaybackRequestSchema,
	mediaStartRecordingRequestSchema,
	mediaStopPlaybackRequestSchema,
	mediaStopRecordingRequestSchema,
	mediaUnbridgeSessionsRequestSchema,
	RPC_SUBJECTS,
} from "@optimiq-voice/events";
import {
	MediaCommandRefusedError,
	MediaOperationNotSupportedError,
} from "./media-not-supported.error";
import { MediadMediaPort } from "./mediad-media.port";
import { FakeMediadTransport } from "./mediad-transport.fake";
import type { MediaPort } from "./media-port";

const TIMEOUT_MS = 500;
const ORG = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293";
const CALL = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4c";
const SESSION = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b53";

const OFFER =
	"v=0\r\no=- 12345 1 IN IP4 203.0.113.9\r\ns=-\r\nc=IN IP4 203.0.113.9\r\nt=0 0\r\n" +
	"m=audio 41000 RTP/AVP 0 8 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\n";

function newPort(): { port: MediadMediaPort; transport: FakeMediadTransport } {
	const transport = new FakeMediadTransport();
	return { port: new MediadMediaPort(transport, TIMEOUT_MS), transport };
}

describe("request framing", () => {
	/**
	 * The framing is the whole reason this seam exists. `mediad` unmarshals the BARE contract
	 * struct, so a request wrapped in Nest's `{pattern, data}` frame is refused as `bad_request`
	 * three layers away from the serializer that caused it.
	 */
	it("puts the bare contract payload on the wire, with no Nest envelope", async () => {
		const { port, transport } = newPort();

		await port.allocateSession({ sessionId: SESSION, orgId: ORG, callId: CALL, sdpOffer: OFFER });

		const [request] = transport.on(RPC_SUBJECTS.mediaAllocateSession);
		expect(request).toBeDefined();
		const payload = request?.payload as Record<string, unknown>;
		expect(payload["pattern"]).toBeUndefined();
		expect(payload["data"]).toBeUndefined();
		expect(payload["id"]).toBeUndefined();
		expect(payload["sessionId"]).toBe(SESSION);
	});

	/** Every request must satisfy the schema the Go responder was generated from. */
	it("sends payloads the contract itself accepts", async () => {
		const { port, transport } = newPort();

		await port.allocateSession({
			sessionId: SESSION,
			orgId: ORG,
			callId: CALL,
			legId: "leg-1",
			sdpOffer: OFFER,
			direction: "inactive",
		});
		await port.createBridge({ bridgeId: "bridge-1" });
		await port.addToBridge("bridge-1", ["leg-a", "leg-b"]);
		await port.destroyBridge("bridge-1");
		await port.play("leg-a", { media: ["sound:welcome"], playbackRef: "pb-1", language: "en" });
		await port.stopPlayback("pb-1");
		await port.releaseSession(SESSION);

		const schemas: Record<string, { parse(value: unknown): unknown }> = {
			[RPC_SUBJECTS.mediaAllocateSession]: mediaAllocateSessionRequestSchema,
			[RPC_SUBJECTS.mediaBridgeSessions]: mediaBridgeSessionsRequestSchema,
			[RPC_SUBJECTS.mediaUnbridgeSessions]: mediaUnbridgeSessionsRequestSchema,
			[RPC_SUBJECTS.mediaReleaseSession]: mediaReleaseSessionRequestSchema,
			[RPC_SUBJECTS.mediaStartPlayback]: mediaStartPlaybackRequestSchema,
			[RPC_SUBJECTS.mediaStopPlayback]: mediaStopPlaybackRequestSchema,
		};
		expect(transport.requests.length).toBeGreaterThan(0);
		for (const request of transport.requests) {
			const schema = schemas[request.subject];
			expect(schema).toBeDefined();
			expect(() => schema?.parse(request.payload)).not.toThrow();
		}
	});

	it("uses the configured deadline on every request", async () => {
		const { port, transport } = newPort();
		await port.releaseSession(SESSION);
		expect(transport.requests[0]?.timeoutMs).toBe(TIMEOUT_MS);
	});
});

describe("allocateSession", () => {
	it("round-trips an offer to an answer", async () => {
		const { port, transport } = newPort();

		const response = await port.allocateSession({
			sessionId: SESSION,
			orgId: ORG,
			callId: CALL,
			sdpOffer: OFFER,
		});

		expect(response.ok).toBe(true);
		expect(response.sdpAnswer).toContain("v=0");
		expect(response.rtpPort).toBe(30_000);
		expect(response.rtcpPort).toBe(30_001);
		expect(response.codec).toBe("PCMU");
		expect(response.instanceId).toBe("mediad-fake");

		const payload = transport.on(RPC_SUBJECTS.mediaAllocateSession)[0]?.payload as Record<
			string,
			unknown
		>;
		expect(payload["sdpOffer"]).toBe(OFFER);
		// The default is stated rather than left to the responder, so both ends agree even if one
		// of them is an older build.
		expect(payload["direction"]).toBe("sendrecv");
	});

	it("makes the session visible to channelExists, and a release hides it again", async () => {
		const { port } = newPort();

		expect(await port.channelExists(SESSION)).toBe(false);
		await port.allocateSession({ sessionId: SESSION, orgId: ORG, callId: CALL, sdpOffer: OFFER });
		expect(await port.channelExists(SESSION)).toBe(true);
		await port.releaseSession(SESSION);
		expect(await port.channelExists(SESSION)).toBe(false);
	});

	/**
	 * A refusal is a REPLY, and the engine branches on the code. Surfacing it as a typed error with
	 * the code intact is what lets a caller tell "try another instance" from "route this to
	 * Asterisk".
	 */
	it("turns a refusal into a typed error carrying the reason", async () => {
		const { port, transport } = newPort();
		transport.reply(RPC_SUBJECTS.mediaAllocateSession, {
			ok: false,
			sessionId: SESSION,
			instanceId: "mediad-7",
			reason: "capacity",
			error: "every port pair in the configured range is in use",
		});

		const attempt = port.allocateSession({
			sessionId: SESSION,
			orgId: ORG,
			callId: CALL,
			sdpOffer: OFFER,
		});

		await expect(attempt).rejects.toThrow(MediaCommandRefusedError);
		try {
			await attempt;
		} catch (error) {
			expect((error as MediaCommandRefusedError).reason).toBe("capacity");
			expect((error as MediaCommandRefusedError).instanceId).toBe("mediad-7");
		}
	});

	/**
	 * The responder is a DIFFERENT LANGUAGE compiled from the same schema, so a drifted Go struct is
	 * a real possibility. Failing here names the field; failing later names a call.
	 */
	it("rejects a reply that does not satisfy the contract", async () => {
		const { port, transport } = newPort();
		transport.reply(RPC_SUBJECTS.mediaAllocateSession, { ok: true });

		await expect(
			port.allocateSession({ sessionId: SESSION, orgId: ORG, callId: CALL, sdpOffer: OFFER }),
		).rejects.toThrow();
	});

	it("propagates a transport failure rather than pretending the session exists", async () => {
		const { port, transport } = newPort();
		transport.failure = new Error("no reply within 500ms");

		await expect(
			port.allocateSession({ sessionId: SESSION, orgId: ORG, callId: CALL, sdpOffer: OFFER }),
		).rejects.toThrow("no reply within 500ms");
		expect(await port.channelExists(SESSION)).toBe(false);
	});
});

describe("bridging", () => {
	/** A relay with no members is nothing on the wire, so `createBridge` costs no round trip. */
	it("creates a bridge locally, with no request", async () => {
		const { port, transport } = newPort();
		const handle = await port.createBridge({ bridgeId: "bridge-1", name: "call-1" });
		expect(handle.bridgeId).toBe("bridge-1");
		expect(transport.requests).toHaveLength(0);
	});

	/** One member is a leg waiting for its peer — the state between an answer and a dial. */
	it("waits for the second leg before relaying", async () => {
		const { port, transport } = newPort();
		await port.createBridge({ bridgeId: "bridge-1" });
		await port.addToBridge("bridge-1", ["leg-a"]);
		expect(transport.on(RPC_SUBJECTS.mediaBridgeSessions)).toHaveLength(0);

		await port.addToBridge("bridge-1", ["leg-b"]);
		const [request] = transport.on(RPC_SUBJECTS.mediaBridgeSessions);
		expect(request?.payload).toEqual({ bridgeId: "bridge-1", sessionIds: ["leg-a", "leg-b"] });
	});

	it("relays immediately when both legs arrive at once", async () => {
		const { port, transport } = newPort();
		await port.createBridge({ bridgeId: "bridge-1" });
		await port.addToBridge("bridge-1", ["leg-a", "leg-b"]);
		expect(transport.on(RPC_SUBJECTS.mediaBridgeSessions)).toHaveLength(1);
	});

	/**
	 * N-way audio is MIXING — a decode, a jitter buffer and a mix-minus per participant — which is
	 * rung 6. Relaying the first two would put the third participant in a room they cannot hear.
	 */
	it("refuses a third leg, naming conferencing", async () => {
		const { port } = newPort();
		await port.createBridge({ bridgeId: "bridge-1" });
		await port.addToBridge("bridge-1", ["leg-a", "leg-b"]);

		const attempt = port.addToBridge("bridge-1", ["leg-c"]);
		await expect(attempt).rejects.toThrow(MediaOperationNotSupportedError);
		try {
			await attempt;
		} catch (error) {
			expect((error as MediaOperationNotSupportedError).capability).toContain("rung 6");
		}
	});

	it("unbridges on removeFromBridge and on destroyBridge", async () => {
		const { port, transport } = newPort();
		await port.createBridge({ bridgeId: "bridge-1" });
		await port.addToBridge("bridge-1", ["leg-a", "leg-b"]);

		await port.removeFromBridge("bridge-1", ["leg-b"]);
		await port.destroyBridge("bridge-1");

		const unbridges = transport.on(RPC_SUBJECTS.mediaUnbridgeSessions);
		expect(unbridges).toHaveLength(2);
		expect(unbridges[0]?.payload).toEqual({ bridgeId: "bridge-1" });
	});

	/** The engine retries a teardown; a media plane that threw would fail a call over a duplicate. */
	it("ignores a removeFromBridge for a bridge it does not know", async () => {
		const { port, transport } = newPort();
		await port.removeFromBridge("never-existed", ["leg-a"]);
		expect(transport.requests).toHaveLength(0);
	});

	/** Releasing a leg must not leave it a member of a bridge that outlives it. */
	it("drops a released leg out of its bridge", async () => {
		const { port } = newPort();
		await port.createBridge({ bridgeId: "bridge-1" });
		await port.addToBridge("bridge-1", ["leg-a", "leg-b"]);

		await port.releaseSession("leg-b");
		// Room for a new second member: if the released leg were still counted this would be a third.
		await expect(port.addToBridge("bridge-1", ["leg-c"])).resolves.toBeUndefined();
	});
});

describe("hangup", () => {
	/**
	 * The MEDIA half of a teardown. `mediad` never speaks SIP, so the BYE is `apps/sipd`'s; what
	 * this guarantees is the port back in the pool and the directory entry gone.
	 */
	it("releases the session and drops the Q.850 cause", async () => {
		const { port, transport } = newPort();
		await port.allocateSession({ sessionId: SESSION, orgId: ORG, callId: CALL, sdpOffer: OFFER });

		await port.hangup(SESSION, "NORMAL_CLEARING");

		const [request] = transport.on(RPC_SUBJECTS.mediaReleaseSession);
		expect(request?.payload).toEqual({ sessionId: SESSION });
		expect(await port.channelExists(SESSION)).toBe(false);
	});
});

describe("watchChannel", () => {
	/**
	 * The one method where doing nothing is CORRECT rather than a silent no-op: `mediad` publishes
	 * org-wide, so there is no per-leg subscription that could stop early. The contract is met.
	 */
	it("is satisfied by construction and issues no request", async () => {
		const { port, transport } = newPort();
		await expect(port.watchChannel(SESSION)).resolves.toBeUndefined();
		expect(transport.requests).toHaveLength(0);
	});
});

describe("playback (rung 1)", () => {
	it("starts a playback and hands back the caller's own reference", async () => {
		const { port, transport } = newPort();

		const handle = await port.play("leg-a", {
			media: ["sound:welcome", "sound:menu"],
			playbackRef: "pb-1",
		});

		// The CALLER's reference, not the reply's. They are equal by contract, and returning the one
		// the caller already holds means a lost reply cannot produce a handle it does not recognise.
		expect(handle.playbackRef).toBe("pb-1");

		const payload = transport.on(RPC_SUBJECTS.mediaStartPlayback)[0]?.payload as Record<
			string,
			unknown
		>;
		// A leg id IS a session id under this driver: both are engine-assigned, so there is no
		// mapping table to lose on a restart.
		expect(payload["sessionId"]).toBe("leg-a");
		expect(payload["playbackRef"]).toBe("pb-1");
		expect(payload["media"]).toEqual(["sound:welcome", "sound:menu"]);
	});

	it("passes the media ref through untranslated", async () => {
		// `routing/media-refs.ts` has already rendered the domain MediaRef into the media server's
		// flat vocabulary. Translating it a second time here would put the prompt library's layout
		// on both sides of the seam.
		const { port, transport } = newPort();

		await port.play("leg-a", { media: ["sound:/mnt/prompts/greeting"], playbackRef: "pb-1" });

		const payload = transport.on(RPC_SUBJECTS.mediaStartPlayback)[0]?.payload as Record<
			string,
			unknown
		>;
		expect(payload["media"]).toEqual(["sound:/mnt/prompts/greeting"]);
	});

	it("omits language rather than sending an empty one", async () => {
		const { port, transport } = newPort();

		await port.play("leg-a", { media: ["sound:welcome"], playbackRef: "pb-1" });

		const payload = transport.on(RPC_SUBJECTS.mediaStartPlayback)[0]?.payload as Record<
			string,
			unknown
		>;
		expect("language" in payload).toBe(false);
	});

	it("carries language when the caller has an opinion", async () => {
		const { port, transport } = newPort();

		await port.play("leg-a", { media: ["sound:welcome"], playbackRef: "pb-1", language: "es" });

		const payload = transport.on(RPC_SUBJECTS.mediaStartPlayback)[0]?.payload as Record<
			string,
			unknown
		>;
		expect(payload["language"]).toBe("es");
	});

	it("returns as soon as playback has started, without waiting for the prompt to end", async () => {
		// The contract the whole barge-in path rests on: `play` hands back a handle the moment audio
		// begins, and the END of the prompt is a JetStream event nothing above this seam consumes.
		const { port, transport } = newPort();

		await port.play("leg-a", { media: ["sound:welcome"], playbackRef: "pb-1" });

		expect(transport.on(RPC_SUBJECTS.mediaStartPlayback)).toHaveLength(1);
		expect(transport.on(RPC_SUBJECTS.mediaStopPlayback)).toHaveLength(0);
	});

	it("stops a playback by reference alone", async () => {
		// `MediaPort.stopPlayback(playbackRef)` has no channel id to give, so neither does the wire.
		const { port, transport } = newPort();

		await port.stopPlayback("pb-1");

		const payload = transport.on(RPC_SUBJECTS.mediaStopPlayback)[0]?.payload as Record<
			string,
			unknown
		>;
		expect(payload).toEqual({ playbackRef: "pb-1" });
	});

	it("treats stopping an already-finished playback as a no-op", async () => {
		// The COMMON path, not an edge case: `gather` stops its prompt whatever ended the
		// collection, so a caller who listens to the whole menu produces this on every call.
		const { port, transport } = newPort();
		transport.reply(RPC_SUBJECTS.mediaStopPlayback, {
			ok: true,
			playbackRef: "pb-1",
			stopped: false,
			instanceId: "mediad-fake",
		});

		await expect(port.stopPlayback("pb-1")).resolves.toBeUndefined();
	});

	it("surfaces a refused media scheme as a typed command refusal", async () => {
		// A generator scheme is an argument this media plane cannot serve, not an operation it does
		// not have — so it is a MediaCommandRefusedError with mediad's own reason on it, and the
		// caller can route the leg to Asterisk instead of reading a message.
		const { port, transport } = newPort();
		transport.reply(RPC_SUBJECTS.mediaStartPlayback, {
			ok: false,
			sessionId: "leg-a",
			playbackRef: "pb-1",
			instanceId: "mediad-7c9f",
			reason: "not_supported",
			error: "tone: is a generator scheme mediad has no synthesiser for",
		});

		const attempt = port.play("leg-a", { media: ["tone://ring"], playbackRef: "pb-1" });
		await expect(attempt).rejects.toThrow(MediaCommandRefusedError);
		try {
			await attempt;
		} catch (error) {
			const refusal = error as MediaCommandRefusedError;
			expect(refusal.reason).toBe("not_supported");
			expect(refusal.instanceId).toBe("mediad-7c9f");
		}
	});

	it("surfaces a missing prompt as a refusal rather than silence", async () => {
		// The defect this whole vocabulary exists to prevent is a play that reports success and
		// sends nothing, so a prompt mediad cannot read must reach the caller as an error.
		const { port, transport } = newPort();
		transport.reply(RPC_SUBJECTS.mediaStartPlayback, {
			ok: false,
			sessionId: "leg-a",
			playbackRef: "pb-1",
			reason: "bad_request",
			error: "sound:missing: audio: no such prompt",
		});

		await expect(
			port.play("leg-a", { media: ["sound:missing"], playbackRef: "pb-1" }),
		).rejects.toThrow(MediaCommandRefusedError);
	});
});

describe("DTMF generation (rung 3)", () => {
	it("sends the digits under the leg's session id, with nothing else on the payload", async () => {
		const { port, transport } = newPort();
		await port.sendDtmf(SESSION, { digits: "1234" });

		const [request] = transport.on(RPC_SUBJECTS.mediaSendDtmf);
		expect(request?.payload).toEqual({ sessionId: SESSION, digits: "1234" });
		// The contract has to accept what the adapter actually sends.
		expect(mediaSendDtmfRequestSchema.parse(request?.payload)).toBeDefined();
	});

	it("carries the timings only when the caller has an opinion", async () => {
		const { port, transport } = newPort();
		await port.sendDtmf(SESSION, { digits: "9", toneDurationMs: 250, gapMs: 50 });

		const [request] = transport.on(RPC_SUBJECTS.mediaSendDtmf);
		expect(request?.payload).toEqual({
			sessionId: SESSION,
			digits: "9",
			toneDurationMs: 250,
			gapMs: 50,
		});
	});

	it("resolves as soon as injection has started, mirroring ARI", async () => {
		// `client.channels.sendDtmf` queues the frames and answers, and the interface hands back
		// nothing — so a late resolution would tell a caller nothing an early one did not.
		const { port } = newPort();
		await expect(port.sendDtmf(SESSION, { digits: "1" })).resolves.toBeUndefined();
	});

	it("surfaces a leg with no RFC 4733 type as a typed command refusal", async () => {
		// The operation exists and this media plane cannot serve that argument — the same distinction
		// `tone://` draws at `play` — so it is a MediaCommandRefusedError the caller can route
		// around, not a capability refusal.
		const { port, transport } = newPort();
		transport.reply(RPC_SUBJECTS.mediaSendDtmf, {
			ok: false,
			sessionId: SESSION,
			instanceId: "mediad-7c9f",
			reason: "not_supported",
			error: "this leg negotiated no RFC 4733 telephone-event payload type",
		});

		const attempt = port.sendDtmf(SESSION, { digits: "1" });
		await expect(attempt).rejects.toThrow(MediaCommandRefusedError);
		try {
			await attempt;
		} catch (error) {
			expect((error as MediaCommandRefusedError).reason).toBe("not_supported");
		}
	});
});

describe("recording (rung 4)", () => {
	it("records ONE direction, mirroring ARI's channels.record on a plain channel", async () => {
		// A voicemail message should hold the caller, not the greeting that was played at them. The
		// conversation case only exists on ARI because call-control interposes a snoop channel first.
		const { port, transport } = newPort();
		const handle = await port.record(SESSION, { name: "rec-1", format: "wav" });

		const [request] = transport.on(RPC_SUBJECTS.mediaStartRecording);
		expect(request?.payload).toEqual({
			sessionId: SESSION,
			recordingRef: "rec-1",
			direction: "receive",
			format: "wav",
		});
		expect(mediaStartRecordingRequestSchema.parse(request?.payload)).toBeDefined();
		// The CALLER's name and format, so a lost reply cannot produce a handle it does not recognise.
		expect(handle).toEqual({ name: "rec-1", format: "wav" });
	});

	it("converts the seconds on the seam into the milliseconds on the wire", async () => {
		// `RecordRequest` speaks seconds because ARI does; every rpc.media.v1.* payload speaks
		// milliseconds because the rest of this backbone does.
		const { port, transport } = newPort();
		await port.record(SESSION, {
			name: "rec-1",
			format: "wav",
			maxDurationSeconds: 120,
			maxSilenceSeconds: 5,
		});

		const [request] = transport.on(RPC_SUBJECTS.mediaStartRecording);
		expect(request?.payload).toMatchObject({ maxDurationMs: 120_000, maxSilenceMs: 5_000 });
	});

	it("sends beep and terminateOn through rather than dropping them", async () => {
		// mediad refuses both by name. Dropping them at the adapter would make the two drivers
		// silently disagree about what was asked for — a voicemail with no beep, and one that ignores
		// `#` and runs to its duration limit.
		const { port, transport } = newPort();
		await port.record(SESSION, {
			name: "rec-1",
			format: "wav",
			beep: true,
			terminateOn: "#",
		});

		const [request] = transport.on(RPC_SUBJECTS.mediaStartRecording);
		expect(request?.payload).toMatchObject({ beep: true, terminateOn: "#" });
	});

	it("surfaces the beep refusal as a typed command refusal", async () => {
		const { port, transport } = newPort();
		transport.reply(RPC_SUBJECTS.mediaStartRecording, {
			ok: false,
			sessionId: SESSION,
			recordingRef: "rec-1",
			instanceId: "mediad-7c9f",
			reason: "not_supported",
			error: "beep needs a tone generator, which mediad does not have",
		});

		await expect(
			port.record(SESSION, { name: "rec-1", format: "wav", beep: true }),
		).rejects.toThrow(MediaCommandRefusedError);
	});

	it("asks for both directions through the media plane's own surface", async () => {
		// The snoop replacement, and it lives above MediaPort for the same reason allocateSession
		// does: RecordRequest has nowhere to say which direction, because on ARI the direction was
		// encoded in which channel id was passed.
		const { port, transport } = newPort();
		const objectKey = await port.startRecording({
			sessionId: SESSION,
			recordingRef: "rec-1",
			direction: "both",
		});

		const [request] = transport.on(RPC_SUBJECTS.mediaStartRecording);
		expect(request?.payload).toEqual({
			sessionId: SESSION,
			recordingRef: "rec-1",
			direction: "both",
			format: "wav",
		});
		// The object key is derived by mediad from the session it already holds, and it is the same
		// `<org>/<call>/<ref>.wav` the engine computes for `channel.record.started` — which is what
		// makes the two agree without either telling the other.
		expect(objectKey).toBe("org/call/rec-1.wav");
	});

	it("stops a recording by reference alone", async () => {
		const { port, transport } = newPort();
		await port.stopRecording("rec-1");

		const [request] = transport.on(RPC_SUBJECTS.mediaStopRecording);
		expect(request?.payload).toEqual({ recordingRef: "rec-1" });
		expect(mediaStopRecordingRequestSchema.parse(request?.payload)).toBeDefined();
	});

	it("treats stopping an already-finished recording as a no-op", async () => {
		// The normal case: a recording that hit its duration limit, or whose leg hung up, has already
		// finalised itself by the time a teardown gets around to stopping it.
		const { port, transport } = newPort();
		transport.reply(RPC_SUBJECTS.mediaStopRecording, {
			ok: true,
			recordingRef: "rec-1",
			stopped: false,
			instanceId: "mediad-fake",
		});

		await expect(port.stopRecording("rec-1")).resolves.toBeUndefined();
	});
});

describe("the not-supported map", () => {
	/**
	 * Every unreached rung fails LOUDLY. A media plane that quietly accepted `record` would produce
	 * a call that sounds perfect and has no recording, discovered days later with nothing in any log
	 * to say why — the worst defect shape a telephony system has.
	 */
	const refusals: readonly [string, string, (port: MediaPort) => Promise<unknown>][] = [
		["answer", "signalling", (port) => port.answer("leg-a")],
		["ring", "signalling", (port) => port.ring("leg-a")],
		[
			"originate",
			"signalling",
			(port) => port.originate({ endpoint: "PJSIP/1001", application: "app", channelId: "leg-b" }),
		],
		["getVariable", "dialplan", (port) => port.getVariable("leg-a", "X")],
		["setVariable", "dialplan", (port) => port.setVariable("leg-a", "X", "1")],
		[
			// The one refusal here that is NOT a rung. A snoop channel exists because ARI addresses
			// everything by channel id, so a tap has to be a channel; mediad records both directions
			// of a session directly and needs no such object.
			"snoop",
			"a snoop tap",
			(port) =>
				port.snoop({
					channelId: "leg-a",
					snoopChannelId: "snoop-1",
					application: "app",
					spy: "both",
				}),
		],
		["startMusicOnHold", "rung 5", (port) => port.startMusicOnHold("leg-a")],
		["stopMusicOnHold", "rung 5", (port) => port.stopMusicOnHold("leg-a")],
		["hold", "rung 5", (port) => port.hold("leg-a")],
		["unhold", "rung 5", (port) => port.unhold("leg-a")],
		["mute", "rung 5", (port) => port.mute("leg-a", "both")],
		["unmute", "rung 5", (port) => port.unmute("leg-a", "both")],
	];

	for (const [operation, capabilityHint, call] of refusals) {
		it(`refuses ${operation} and names what it needs`, async () => {
			const { port, transport } = newPort();

			const attempt = call(port);
			await expect(attempt).rejects.toThrow(MediaOperationNotSupportedError);
			try {
				await attempt;
			} catch (error) {
				const refusal = error as MediaOperationNotSupportedError;
				expect(refusal.operation).toBe(operation);
				expect(refusal.capability.toLowerCase()).toContain(capabilityHint.toLowerCase());
				expect(refusal.driver).toBe("mediad");
				// The message has to be actionable on its own: a reader with only the log line must
				// learn how to serve the call today.
				expect(refusal.message).toContain("ENGINE_MEDIA_DRIVER=ari");
			}
			// A refusal never touches the wire: it is a capability statement, not a failed command.
			expect(transport.requests).toHaveLength(0);
		});
	}

	/** The map must stay a map: nothing may quietly resolve. */
	it("covers every MediaPort method as either supported or refused", () => {
		const supported = [
			"createBridge",
			"addToBridge",
			"removeFromBridge",
			"destroyBridge",
			"hangup",
			"channelExists",
			"watchChannel",
			// Rung 1. `play` and `stopPlayback` moved out of the refused list when mediad learned to
			// source frames from a file — see the playback describe block above.
			"play",
			"stopPlayback",
			// Rung 3. Generating a digit, which the relay could never do: there is no inbound packet
			// to forward.
			"sendDtmf",
			// Rung 4. `record` captures ONE direction, mirroring ARI's `channels.record` on a plain
			// channel; both directions is `startRecording`, above the interface, because
			// `RecordRequest` has nowhere to say which.
			"record",
			"stopRecording",
		];
		const refused = refusals.map(([operation]) => operation);
		const methods = [...supported, ...refused].sort();
		const expected = [
			"addToBridge",
			"answer",
			"channelExists",
			"createBridge",
			"destroyBridge",
			"getVariable",
			"hangup",
			"hold",
			"mute",
			"originate",
			"play",
			"record",
			"removeFromBridge",
			"ring",
			"sendDtmf",
			"setVariable",
			"snoop",
			"startMusicOnHold",
			"stopMusicOnHold",
			"stopPlayback",
			"stopRecording",
			"unhold",
			"unmute",
			"watchChannel",
		];
		expect(methods).toEqual(expected);
		expect(methods).toHaveLength(24);
	});
});
