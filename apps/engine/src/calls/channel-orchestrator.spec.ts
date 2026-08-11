import { beforeEach, describe, expect, it } from "bun:test";
import { parseAriEvent } from "@optimiq-voice/media-ari";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { fakeQueueOrchestratorArgs } from "../queue/queue-services.fake";
import { CallSignalBus, legSignalKey } from "../routing/call-signals";
import { ConferenceRegistry } from "../routing/conference-registry";
import { ParkRegistry } from "../routing/park-registry";
import { DtmfRegistry } from "../verbs/dtmf-registry";
import { makeVerbExecutorRuntime } from "../verbs/verb-executor";
import { toMediaEvent } from "./ari-mapping";
import { CallControlRegistry } from "./call-control-registry";
import { ChannelOrchestrator } from "./channel-orchestrator.service";
import type { EngineEnv } from "../config/engine-env";
import type { MediaEvent } from "../media/media-event";
import type { CallEventPublisher } from "../nats/call-event-publisher.service";
import type { JetStreamService } from "../nats/jetstream.service";
import type { ParkHandoffService } from "../nats/park-handoff.service";
import type { SipTransferCallPath, SipTransferService } from "../nats/sip-transfer.service";
import type { DidIndexSource } from "../routing/did-index.source";
import type { RoutingArtifactSource } from "../routing/routing-artifact.source";
import type { VoicemailMailboxRpcSource } from "../routing/voicemail-mailbox.source";
import type { CallEventOf, CdrLegWriteEnvelope, SipTransferRequest } from "@optimiq-voice/events";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

/**
 * A DID index that never resolves anything.
 *
 * Every case in the pure suite drives a call that already carries `OPTIMIQ_ORG_ID`, so the lookup
 * is not what is under test here and a stub that always misses keeps each case exercising exactly
 * the path it was written for. The lookup itself is covered by `did-index.source.spec.ts`, and the
 * multi-tenant flow end to end by the integration suite.
 */
const NO_DID_INDEX = {
	organizationFor: async () => undefined,
} as unknown as DidIndexSource;

/**
 * No mailbox responder — which is production's state too until the API side of
 * `rpc.voicemail.v1.list` lands. A `*97` therefore announces the mailbox as unavailable rather
 * than as empty, and `plan-walker.spec.ts` is where that distinction is asserted.
 */
const NO_MAILBOX = {
	list: async () => ({ found: false, messages: [], reason: "no responder in this spec" }),
} as unknown as VoicemailMailboxRpcSource;

/**
 * A park-handoff seam that answers nothing.
 *
 * Every spec in this file is a SINGLE instance, so no claim it reads can name a foreign owner and
 * nothing here ever reaches the wire. It is wired rather than cast away because the orchestrator
 * registers its handler on this object at construction — a missing one would fail in the
 * constructor rather than in the test that cared.
 */
const NO_PARK_HANDOFF = {
	setHandler: () => undefined,
	handoff: async () => {
		throw new Error("no cross-instance park handoff in this spec");
	},
} as unknown as ParkHandoffService;

/**
 * A SIP transfer responder that keeps the call path instead of serving it.
 *
 * The broker half is proven in `nats/sip-transfer.service.spec.ts` with a fake call path; this is
 * the other side of the same seam, and holding onto what the orchestrator attaches is what lets a
 * spec ask the REAL index whether a REFER would find the call — without a socket, and without
 * reaching into a private map to do it.
 */
function fakeSipTransfer(): {
	readonly service: SipTransferService;
	readonly attached: () => SipTransferCallPath;
} {
	let attached: SipTransferCallPath | undefined;
	const service = {
		attach: (callPath: SipTransferCallPath) => {
			attached = callPath;
		},
	} as unknown as SipTransferService;
	return {
		service,
		attached: () => {
			if (attached === undefined) {
				throw new Error("the orchestrator attached no sip transfer call path");
			}
			return attached;
		},
	};
}

/**
 * Orchestrator specs, driven entirely by fakes.
 *
 * Every collaborator the orchestrator has is a port: the media server, the event publisher and
 * the JetStream side. So a whole call — arrival, answer, DTMF, hangup, CDR, KV lifecycle — runs in
 * process with no Asterisk, no NATS and no clock control. The live versions of these paths are
 * proven separately in `test/engine-integration.spec.ts`.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const ARI_CHANNEL = "1754400000.42";

interface PublishedEvent {
	readonly type: string;
	readonly orgId: string;
	readonly callId: string;
	readonly data: Record<string, unknown>;
}

function fakeEnv(overrides: Partial<EngineEnv> = {}): EngineEnv {
	return {
		NODE_ENV: "test",
		ENGINE_PORT: 4010,
		ENGINE_HOST: "127.0.0.1",
		ARI_URL: "http://asterisk:8088",
		ARI_USERNAME: "ari",
		ARI_PASSWORD: "secret",
		ARI_APP: "optimiq-engine",
		ARI_SUBSCRIBE_ALL: false,
		ARI_REQUEST_TIMEOUT_MS: 10_000,
		NATS_URL: "nats://localhost:4222",
		ENGINE_ENSURE_STREAMS: false,
		ENGINE_DRAIN_TIMEOUT_MS: 1_000,
		// These specs cover the ORCHESTRATOR — channel state, events, KV and the CDR — with no
		// artifact in play. Routing has its own specs (`src/routing/*.spec.ts`), and leaving it on
		// here would make every one of these assertions depend on a fake artifact source instead.
		ENGINE_ROUTING_ENABLED: false,
		ENGINE_ROUTING_RPC_TIMEOUT_MS: 2_000,
		ENGINE_EXTENSION_DIAL_TEMPLATE: "PJSIP/{number}",
		ENGINE_TRUNK_DIAL_TEMPLATE: "PJSIP/{number}@{trunk}",
		ENGINE_DEFAULT_RING_TIMEOUT_SECONDS: 30,
		ENGINE_PROMPT_MEDIA_PREFIX: "sound:",
		ENGINE_UNAVAILABLE_ANNOUNCEMENT: "sound:unavailable",
		ENGINE_VOICEMAIL_GREETING: "sound:unavailable",
		ENGINE_RECORDING_FORMAT: "wav",
		...overrides,
	} as EngineEnv;
}

function harness(env: EngineEnv = fakeEnv()) {
	const media = makeFakeMediaPort({ variables: { OPTIMIQ_ORG_ID: ORG } });
	const mediaCalls = media.calls;
	const variables = media.variables;

	const published: PublishedEvent[] = [];
	const events = {
		publish: async (
			type: string,
			input: { orgId: string; callId: string; data: Record<string, unknown> },
		) => {
			published.push({ type, orgId: input.orgId, callId: input.callId, data: input.data });
			return undefined as unknown as CallEventOf<"channel.created">;
		},
	} as unknown as CallEventPublisher;

	const kv = new Map<string, ChannelSnapshot>();
	const cdrs: CdrLegWriteEnvelope[] = [];
	const jetstream = {
		putChannel: async (snapshot: ChannelSnapshot) => {
			kv.set(`${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`, snapshot);
		},
		deleteChannel: async (snapshot: ChannelSnapshot) => {
			kv.delete(`${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`);
		},
		publishCdrLeg: async (envelope: CdrLegWriteEnvelope) => {
			cdrs.push(envelope);
		},
	} as unknown as JetStreamService;

	const dtmf = new DtmfRegistry();
	const runtime = makeVerbExecutorRuntime({
		media,
		collectDtmf: (context, verb) => dtmf.forChannel(context.channelId).collect(verb),
	});

	const signals = new CallSignalBus();
	const routing = {
		get: async () => undefined,
	} as unknown as RoutingArtifactSource;

	const sipTransfer = fakeSipTransfer();

	const orchestrator = new ChannelOrchestrator(
		env,
		media,
		runtime,
		dtmf,
		events,
		jetstream,
		routing,
		NO_MAILBOX,
		NO_DID_INDEX,
		signals,
		new ConferenceRegistry(),
		...(fakeQueueOrchestratorArgs() as [never, never, never, never, never]),
		new ParkRegistry(),
		new CallControlRegistry(),
		NO_PARK_HANDOFF,
		sipTransfer.service,
	);

	return {
		orchestrator,
		mediaCalls,
		published,
		kv,
		cdrs,
		variables,
		dtmf,
		mediaPort: media,
		jetstream,
		signals,
		routing,
		sipCallPath: sipTransfer.attached,
	};
}

function channel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: ARI_CHANNEL,
		name: "PJSIP/trunk-00000001",
		state: "Ring",
		caller: { name: "Ada", number: "+15551234567" },
		dialplan: { context: "local-ctx", exten: "+15559876543", priority: 1 },
		...overrides,
	};
}

/**
 * One raw ARI frame, driven through the real boundary the process uses.
 *
 * The orchestrator consumes {@link MediaEvent} and knows nothing about ARI, so these specs could
 * hand-build domain events directly. They deliberately do not: parsing a frame and mapping it is
 * what `AriConnectionService` does on every live event, so driving the same path keeps the fixtures
 * honest — a domain event no media server could actually produce would prove nothing.
 */
function mediaEvent(ariType: string, extra: Record<string, unknown>): MediaEvent {
	const event = maybeMediaEvent(ariType, extra);
	if (event === undefined) {
		throw new Error(`${ariType} maps to no MediaEvent; use maybeMediaEvent to assert that`);
	}
	return event;
}

/** The same, for the cases where "the engine is not told at all" is the assertion. */
function maybeMediaEvent(ariType: string, extra: Record<string, unknown>): MediaEvent | undefined {
	return toMediaEvent(parseAriEvent({ type: ariType, application: "optimiq-engine", ...extra }));
}

function typesOf(published: readonly PublishedEvent[]): string[] {
	return published.map((event) => event.type);
}

describe("inbound call arrival", () => {
	it("creates a leg, publishes channel.created, mirrors KV, and runs the P2 program", async () => {
		const h = harness();
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));

		expect(typesOf(h.published)).toEqual(["channel.created"]);
		expect(h.published[0]?.orgId).toBe(ORG);
		expect(h.published[0]?.data).toMatchObject({
			leg: "a",
			direction: "inbound",
			from: { number: "+15551234567", name: "Ada" },
			to: { number: "+15559876543" },
			routingContext: "local-ctx",
		});

		expect(h.orchestrator.activeChannelCount).toBe(1);
		expect(h.kv.size).toBe(1);
		expect(h.mediaCalls.map((call) => call.method)).toEqual(["watchChannel", "ring", "answer"]);
	});

	it("plays the announcement only once the channel is really Up", async () => {
		const h = harness(fakeEnv({ ENGINE_INBOUND_ANNOUNCEMENT: "sound:welcome" }));
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));

		// `answer` is a request, not a state: nothing may be played yet.
		expect(h.mediaCalls.map((call) => call.method)).toEqual(["watchChannel", "ring", "answer"]);

		await h.orchestrator.handleEvent(
			mediaEvent("ChannelStateChange", { channel: channel({ state: "Up" }) }),
		);
		expect(h.mediaCalls.map((call) => call.method)).toEqual([
			"watchChannel",
			"ring",
			"answer",
			"play",
		]);
		expect(h.mediaCalls[3]?.args[1]).toMatchObject({ media: ["sound:welcome"] });
	});

	it("REJECTS a call with no resolvable organization rather than guessing a tenant", async () => {
		const h = harness();
		delete h.variables.OPTIMIQ_ORG_ID;

		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));

		expect(h.published).toEqual([]);
		expect(h.orchestrator.activeChannelCount).toBe(0);
		expect(h.kv.size).toBe(0);
		expect(h.mediaCalls).toEqual([{ method: "hangup", args: [ARI_CHANNEL, "INVALID_PROFILE"] }]);
	});

	it("accepts the configured fallback organization in single-tenant development", async () => {
		const h = harness(fakeEnv({ ENGINE_DEFAULT_ORGANIZATION_ID: ORG }));
		delete h.variables.OPTIMIQ_ORG_ID;

		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		expect(typesOf(h.published)).toEqual(["channel.created"]);
	});

	it("ignores a redelivered StasisStart, which a masquerade produces", async () => {
		const h = harness();
		const start = mediaEvent("StasisStart", { channel: channel(), args: [] });
		await h.orchestrator.handleEvent(start);
		await h.orchestrator.handleEvent(start);

		expect(typesOf(h.published)).toEqual(["channel.created"]);
		expect(h.orchestrator.activeChannelCount).toBe(1);
	});

	it("reads the direction from a channel variable", async () => {
		const h = harness();
		h.variables.OPTIMIQ_CALL_DIRECTION = "outbound";
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		expect(h.published[0]?.data).toMatchObject({ direction: "outbound" });
	});
});

/**
 * The half of `rpc.sip.v1.transfer` that lives in this file: turning the `Call-ID` a desk phone puts
 * on its REFER into a channel this process is holding.
 *
 * Driven through the seam the responder actually calls rather than through a private map, so what is
 * asserted here is the same thing `apps/sipd` gets on the wire.
 */
describe("sip dialog correlation", () => {
	const SIP_CALL_ID = "3c26700c1adf-6qgy0fkn7cvb";

	/** As much of a REFER as `resolveDialog` reads, which is the Call-ID and nothing else. */
	function refer(sipCallId: string): SipTransferRequest {
		return { sipCallId } as unknown as SipTransferRequest;
	}

	async function arriveWithDialog(
		h: ReturnType<typeof harness>,
		sipCallId = SIP_CALL_ID,
	): Promise<void> {
		// `CHANNEL(pjsip,call-id)` and not `PJSIP_HEADER(read,…)`: the header function is unreadable on
		// an outgoing leg, which is the leg a phone that ANSWERED a call is sitting on.
		h.variables["CHANNEL(pjsip,call-id)"] = sipCallId;
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
	}

	it("records the Call-ID as a channel variable, so it survives into the KV snapshot", async () => {
		const h = harness();
		await arriveWithDialog(h);

		const [snapshot] = [...h.kv.values()];
		// A variable rather than a field: this is what an instance taking over a failover reads.
		expect(snapshot?.variables.OPTIMIQ_SIP_CALL_ID).toBe(SIP_CALL_ID);
	});

	it("puts it on channel.created, a contract field nothing has ever populated", async () => {
		const h = harness();
		await arriveWithDialog(h);

		expect(h.published[0]?.data).toMatchObject({ sipCallId: SIP_CALL_ID });
	});

	it("resolves a REFER naming that dialog onto the media channel carrying it", async () => {
		const h = harness();
		await arriveWithDialog(h);

		await expect(h.sipCallPath().resolveDialog(refer(SIP_CALL_ID))).resolves.toBe(ARI_CHANNEL);
		// And the leg the responder then authorises is the one this process is actually holding.
		expect(h.sipCallPath().legFor(ARI_CHANNEL)?.callerIdNumber).toBe("+15551234567");
	});

	it("resolves nothing for a Call-ID no live call carries", async () => {
		const h = harness();
		await arriveWithDialog(h);

		// `unknown_dialog` at the responder — a phone guessing, or a call that has already ended.
		await expect(h.sipCallPath().resolveDialog(refer("somebody-else@1.2.3.4"))).resolves.toBe(
			undefined,
		);
	});

	it("takes the call when the media server cannot answer the Call-ID, and indexes nothing", async () => {
		const h = harness();
		// A Local half, a snoop, or a media server with no SIP notion at all.
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));

		expect(h.orchestrator.activeChannelCount).toBe(1);
		expect(h.published[0]?.data).not.toHaveProperty("sipCallId");
		await expect(h.sipCallPath().resolveDialog(refer(SIP_CALL_ID))).resolves.toBe(undefined);
	});

	it("takes a Call-ID the media server exported with the event, without a second round trip", async () => {
		const h = harness();
		h.variables["CHANNEL(pjsip,call-id)"] = "read@1.2.3.4";

		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", {
				// `channelvars`, which is what an `ari.conf` configured to export variables sends. A
				// dialplan that has already stamped the Call-ID is believed rather than re-read.
				channel: channel({ channelvars: { OPTIMIQ_SIP_CALL_ID: "stamped@1.2.3.4" } }),
				args: [],
			}),
		);

		await expect(h.sipCallPath().resolveDialog(refer("stamped@1.2.3.4"))).resolves.toBe(
			ARI_CHANNEL,
		);
		await expect(h.sipCallPath().resolveDialog(refer("read@1.2.3.4"))).resolves.toBe(undefined);
	});

	it("releases the key when the leg ends, so the index cannot outlive the call", async () => {
		const h = harness();
		await arriveWithDialog(h);

		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: channel(), cause: 16 }),
		);

		expect(h.orchestrator.activeChannelCount).toBe(0);
		await expect(h.sipCallPath().resolveDialog(refer(SIP_CALL_ID))).resolves.toBe(undefined);
	});

	it("answers no dialog at all once the instance is draining", async () => {
		const h = harness();
		await arriveWithDialog(h);
		await h.orchestrator.drain(0);

		// Accepting one here would start a routing walk this process is about to abandon.
		await expect(h.sipCallPath().resolveDialog(refer(SIP_CALL_ID))).resolves.toBe(undefined);
	});
});

describe("progress", () => {
	async function arrived() {
		const h = harness();
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		h.published.length = 0;
		h.mediaCalls.length = 0;
		return h;
	}

	it("publishes channel.ringing on the alerting state", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelStateChange", { channel: channel({ state: "Ringing" }) }),
		);
		expect(typesOf(h.published)).toEqual(["channel.ringing"]);
	});

	it("publishes channel.answered exactly once when the channel comes Up", async () => {
		const h = await arrived();
		const up = mediaEvent("ChannelStateChange", { channel: channel({ state: "Up" }) });
		await h.orchestrator.handleEvent(up);
		await h.orchestrator.handleEvent(up);
		expect(typesOf(h.published)).toEqual(["channel.answered"]);
	});

	it("is never told about a media-server state with no user-visible meaning", async () => {
		const h = await arrived();
		// The drop moved down to the seam: `Busy` has no domain call state, so the mapping produces
		// no event at all rather than one the orchestrator would have to recognise and ignore.
		// Either way nothing is published, which is the fact this case has always been about.
		expect(maybeMediaEvent("ChannelStateChange", { channel: channel({ state: "Busy" }) })).toBe(
			undefined,
		);
		expect(h.published).toEqual([]);
	});

	it("ignores a state change for a channel it is not tracking", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelStateChange", { channel: channel({ id: "other", state: "Up" }) }),
		);
		expect(h.published).toEqual([]);
	});

	it("publishes each DTMF digit and queues it for a gather", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDtmfReceived", { channel: channel(), digit: "7", duration_ms: 130 }),
		);

		expect(typesOf(h.published)).toEqual(["channel.dtmf"]);
		expect(h.published[0]?.data).toMatchObject({ digit: "7", durationMs: 130, source: "rfc2833" });
		expect(h.dtmf.size).toBe(1);
	});

	it("republishes a digit on the signal bus, including for a leg it does not track", async () => {
		const h = await arrived();
		const heard: string[] = [];
		h.signals.watch(legSignalKey("originated-leg"), (signal) => {
			if (signal.kind === "dtmf") {
				heard.push(signal.digit);
			}
		});

		// A leg the plan walker originated has no aggregate — it is deliberately never filed as a
		// call of its own — so this is the ONLY way its digits reach anything, and answer
		// confirmation is a question asked of exactly such a leg.
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDtmfReceived", {
				channel: channel({ id: "originated-leg" }),
				digit: "1",
				duration_ms: 120,
			}),
		);

		expect(heard).toEqual(["1"]);
		expect(h.published).toEqual([]);
	});

	it("drops a non-DTMF symbol rather than publishing an invalid event", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDtmfReceived", { channel: channel(), digit: "X", duration_ms: 10 }),
		);
		expect(h.published).toEqual([]);
	});

	it("records engine channel variables and ignores everything else", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelVarset", { channel: channel(), variable: "OPTIMIQ_X", value: "1" }),
		);
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelVarset", { channel: channel(), variable: "SIPCALLID", value: "abc" }),
		);
		// Observable through the KV mirror on the next state change.
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelStateChange", { channel: channel({ state: "Up" }) }),
		);
		const snapshot = [...h.kv.values()][0];
		expect(snapshot?.variables.OPTIMIQ_X).toBe("1");
		expect(snapshot?.variables.SIPCALLID).toBeUndefined();
	});
});

describe("teardown", () => {
	async function answered() {
		const h = harness();
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelStateChange", { channel: channel({ state: "Up" }) }),
		);
		h.published.length = 0;
		h.mediaCalls.length = 0;
		return h;
	}

	it("publishes hangup, then destroyed, then writes the CDR, then clears KV", async () => {
		const h = await answered();
		expect(h.kv.size).toBe(1);

		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", {
				channel: channel({ state: "Down" }),
				cause: 16,
				cause_txt: "Normal Clearing",
			}),
		);

		expect(typesOf(h.published)).toEqual(["channel.hangup", "channel.destroyed"]);
		expect(h.published[0]?.data).toMatchObject({
			cause: "NORMAL_CLEARING",
			causeCode: 16,
			side: "caller",
		});
		expect(h.cdrs).toHaveLength(1);
		expect(h.cdrs[0]?.data).toMatchObject({
			disposition: "answered",
			hangupCause: "NORMAL_CLEARING",
		});
		expect(h.kv.size).toBe(0);
		expect(h.orchestrator.activeChannelCount).toBe(0);
	});

	it("keeps the cause the far end sent, not the one ChannelDestroyed reports later", async () => {
		const h = await answered();
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelHangupRequest", { channel: channel(), cause: 17 }),
		);
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", {
				channel: channel(),
				cause: 16,
				cause_txt: "Normal Clearing",
			}),
		);

		expect(h.published[0]?.data).toMatchObject({ cause: "USER_BUSY" });
		expect(h.cdrs[0]?.data).toMatchObject({ hangupCause: "USER_BUSY" });
	});

	it("preserves the RAW ARI code even when the cause has no name", async () => {
		const h = await answered();
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", {
				channel: channel(),
				cause: 47,
				cause_txt: "Resource unavailable",
			}),
		);
		expect(h.published[0]?.data).toMatchObject({
			cause: "NORMAL_UNSPECIFIED",
			causeCode: 47,
		});
	});

	it("writes a no-answer CDR that bills nothing for a leg that never answered", async () => {
		const h = harness();
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: channel(), cause: 19, cause_txt: "No answer" }),
		);

		expect(h.cdrs[0]?.data).toMatchObject({
			disposition: "no-answer",
			hangupCause: "NO_ANSWER",
			billsecMs: 0,
			answeredAt: null,
		});
	});

	it("ignores a ChannelDestroyed for a channel it never tracked", async () => {
		const h = harness();
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: channel({ id: "ghost" }), cause: 16 }),
		);
		expect(h.published).toEqual([]);
		expect(h.cdrs).toEqual([]);
	});

	it("releases the DTMF queue when the leg goes away", async () => {
		const h = await answered();
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDtmfReceived", { channel: channel(), digit: "1", duration_ms: 100 }),
		);
		expect(h.dtmf.size).toBe(1);
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: channel(), cause: 16 }),
		);
		expect(h.dtmf.size).toBe(0);
	});
});

describe("drain", () => {
	let harnessInstance: ReturnType<typeof harness>;

	beforeEach(() => {
		harnessInstance = harness(fakeEnv({ ENGINE_DRAIN_TIMEOUT_MS: 50 }));
	});

	it("rejects a new call with a cause the carrier can fail over on", async () => {
		await harnessInstance.orchestrator.drain(0);
		harnessInstance.mediaCalls.length = 0;

		await harnessInstance.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(), args: [] }),
		);

		expect(harnessInstance.published).toEqual([]);
		expect(harnessInstance.mediaCalls).toEqual([
			{ method: "hangup", args: [ARI_CHANNEL, "NORMAL_TEMPORARY_FAILURE"] },
		]);
		expect(harnessInstance.orchestrator.isDraining).toBe(true);
	});

	it("returns immediately when there is nothing to drain", async () => {
		const started = Date.now();
		await harnessInstance.orchestrator.drain(5_000);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("hangs up stragglers once the deadline passes", async () => {
		await harnessInstance.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(), args: [] }),
		);
		harnessInstance.mediaCalls.length = 0;

		await harnessInstance.orchestrator.drain(50);

		expect(harnessInstance.mediaCalls).toEqual([
			{ method: "hangup", args: [ARI_CHANNEL, "NORMAL_TEMPORARY_FAILURE"] },
		]);
	});
});

describe("resilience", () => {
	it("never throws out of handleEvent, whatever a collaborator does", async () => {
		const h = harness();
		// A publisher that throws is exactly the failure that must not end a live call — and, in
		// the real process, must not take the WebSocket callback (and therefore every other call)
		// down with it.
		const failing = {
			publish: async () => {
				throw new Error("broker unreachable");
			},
		} as unknown as CallEventPublisher;

		const orchestrator = new ChannelOrchestrator(
			fakeEnv(),
			h.mediaPort,
			makeVerbExecutorRuntime({
				media: h.mediaPort,
				collectDtmf: async () => ({ digits: [], endReason: "cancelled" }),
			}),
			new DtmfRegistry(),
			failing,
			h.jetstream,
			h.routing,
			NO_MAILBOX,
			NO_DID_INDEX,
			h.signals,
			new ConferenceRegistry(),
			...(fakeQueueOrchestratorArgs() as [never, never, never, never, never]),
			new ParkRegistry(),
			new CallControlRegistry(),
			NO_PARK_HANDOFF,
			fakeSipTransfer().service,
		);

		await expect(
			orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] })),
		).resolves.toBeUndefined();
		expect(orchestrator.activeChannelCount).toBe(1);
	});
});
