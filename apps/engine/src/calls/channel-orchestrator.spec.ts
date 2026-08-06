import { beforeEach, describe, expect, it } from "bun:test";
import { parseAriEvent } from "@optimiq-voice/media-ari";
import { makeFakeMediaPort } from "../ari/media-port.fake";
import { fakeQueueOrchestratorArgs } from "../queue/queue-services.fake";
import { CallSignalBus } from "../routing/call-signals";
import { DtmfRegistry } from "../verbs/dtmf-registry";
import { makeVerbExecutorRuntime } from "../verbs/verb-executor";
import { ChannelOrchestrator } from "./channel-orchestrator.service";
import type { EngineEnv } from "../config/engine-env";
import type { CallEventPublisher } from "../nats/call-event-publisher.service";
import type { JetStreamService } from "../nats/jetstream.service";
import type { DidIndexSource } from "../routing/did-index.source";
import type { RoutingArtifactSource } from "../routing/routing-artifact.source";
import type { VoicemailMailboxRpcSource } from "../routing/voicemail-mailbox.source";
import type { CallEventOf, CdrLegWriteEnvelope } from "@optimiq-voice/events";
import type { AriEvent } from "@optimiq-voice/media-ari";
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
		...(fakeQueueOrchestratorArgs() as [never, never, never, never, never]),
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

function ariEvent(type: string, extra: Record<string, unknown>): AriEvent {
	return parseAriEvent({ type, application: "optimiq-engine", ...extra });
}

function typesOf(published: readonly PublishedEvent[]): string[] {
	return published.map((event) => event.type);
}

describe("inbound call arrival", () => {
	it("creates a leg, publishes channel.created, mirrors KV, and runs the P2 program", async () => {
		const h = harness();
		await h.orchestrator.handleEvent(ariEvent("StasisStart", { channel: channel(), args: [] }));

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
		await h.orchestrator.handleEvent(ariEvent("StasisStart", { channel: channel(), args: [] }));

		// `answer` is a request, not a state: nothing may be played yet.
		expect(h.mediaCalls.map((call) => call.method)).toEqual(["watchChannel", "ring", "answer"]);

		await h.orchestrator.handleEvent(
			ariEvent("ChannelStateChange", { channel: channel({ state: "Up" }) }),
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

		await h.orchestrator.handleEvent(ariEvent("StasisStart", { channel: channel(), args: [] }));

		expect(h.published).toEqual([]);
		expect(h.orchestrator.activeChannelCount).toBe(0);
		expect(h.kv.size).toBe(0);
		expect(h.mediaCalls).toEqual([{ method: "hangup", args: [ARI_CHANNEL, "INVALID_PROFILE"] }]);
	});

	it("accepts the configured fallback organization in single-tenant development", async () => {
		const h = harness(fakeEnv({ ENGINE_DEFAULT_ORGANIZATION_ID: ORG }));
		delete h.variables.OPTIMIQ_ORG_ID;

		await h.orchestrator.handleEvent(ariEvent("StasisStart", { channel: channel(), args: [] }));
		expect(typesOf(h.published)).toEqual(["channel.created"]);
	});

	it("ignores a redelivered StasisStart, which a masquerade produces", async () => {
		const h = harness();
		const start = ariEvent("StasisStart", { channel: channel(), args: [] });
		await h.orchestrator.handleEvent(start);
		await h.orchestrator.handleEvent(start);

		expect(typesOf(h.published)).toEqual(["channel.created"]);
		expect(h.orchestrator.activeChannelCount).toBe(1);
	});

	it("reads the direction from a channel variable", async () => {
		const h = harness();
		h.variables.OPTIMIQ_CALL_DIRECTION = "outbound";
		await h.orchestrator.handleEvent(ariEvent("StasisStart", { channel: channel(), args: [] }));
		expect(h.published[0]?.data).toMatchObject({ direction: "outbound" });
	});
});

describe("progress", () => {
	async function arrived() {
		const h = harness();
		await h.orchestrator.handleEvent(ariEvent("StasisStart", { channel: channel(), args: [] }));
		h.published.length = 0;
		h.mediaCalls.length = 0;
		return h;
	}

	it("publishes channel.ringing on the alerting state", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent(
			ariEvent("ChannelStateChange", { channel: channel({ state: "Ringing" }) }),
		);
		expect(typesOf(h.published)).toEqual(["channel.ringing"]);
	});

	it("publishes channel.answered exactly once when the channel comes Up", async () => {
		const h = await arrived();
		const up = ariEvent("ChannelStateChange", { channel: channel({ state: "Up" }) });
		await h.orchestrator.handleEvent(up);
		await h.orchestrator.handleEvent(up);
		expect(typesOf(h.published)).toEqual(["channel.answered"]);
	});

	it("ignores an ARI state with no user-visible meaning", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent(
			ariEvent("ChannelStateChange", { channel: channel({ state: "Busy" }) }),
		);
		expect(h.published).toEqual([]);
	});

	it("ignores a state change for a channel it is not tracking", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent(
			ariEvent("ChannelStateChange", { channel: channel({ id: "other", state: "Up" }) }),
		);
		expect(h.published).toEqual([]);
	});

	it("publishes each DTMF digit and queues it for a gather", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent(
			ariEvent("ChannelDtmfReceived", { channel: channel(), digit: "7", duration_ms: 130 }),
		);

		expect(typesOf(h.published)).toEqual(["channel.dtmf"]);
		expect(h.published[0]?.data).toMatchObject({ digit: "7", durationMs: 130, source: "rfc2833" });
		expect(h.dtmf.size).toBe(1);
	});

	it("drops a non-DTMF symbol rather than publishing an invalid event", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent(
			ariEvent("ChannelDtmfReceived", { channel: channel(), digit: "X", duration_ms: 10 }),
		);
		expect(h.published).toEqual([]);
	});

	it("records engine channel variables and ignores everything else", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent(
			ariEvent("ChannelVarset", { channel: channel(), variable: "OPTIMIQ_X", value: "1" }),
		);
		await h.orchestrator.handleEvent(
			ariEvent("ChannelVarset", { channel: channel(), variable: "SIPCALLID", value: "abc" }),
		);
		// Observable through the KV mirror on the next state change.
		await h.orchestrator.handleEvent(
			ariEvent("ChannelStateChange", { channel: channel({ state: "Up" }) }),
		);
		const snapshot = [...h.kv.values()][0];
		expect(snapshot?.variables.OPTIMIQ_X).toBe("1");
		expect(snapshot?.variables.SIPCALLID).toBeUndefined();
	});
});

describe("teardown", () => {
	async function answered() {
		const h = harness();
		await h.orchestrator.handleEvent(ariEvent("StasisStart", { channel: channel(), args: [] }));
		await h.orchestrator.handleEvent(
			ariEvent("ChannelStateChange", { channel: channel({ state: "Up" }) }),
		);
		h.published.length = 0;
		h.mediaCalls.length = 0;
		return h;
	}

	it("publishes hangup, then destroyed, then writes the CDR, then clears KV", async () => {
		const h = await answered();
		expect(h.kv.size).toBe(1);

		await h.orchestrator.handleEvent(
			ariEvent("ChannelDestroyed", {
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
			ariEvent("ChannelHangupRequest", { channel: channel(), cause: 17 }),
		);
		await h.orchestrator.handleEvent(
			ariEvent("ChannelDestroyed", { channel: channel(), cause: 16, cause_txt: "Normal Clearing" }),
		);

		expect(h.published[0]?.data).toMatchObject({ cause: "USER_BUSY" });
		expect(h.cdrs[0]?.data).toMatchObject({ hangupCause: "USER_BUSY" });
	});

	it("preserves the RAW ARI code even when the cause has no name", async () => {
		const h = await answered();
		await h.orchestrator.handleEvent(
			ariEvent("ChannelDestroyed", {
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
		await h.orchestrator.handleEvent(ariEvent("StasisStart", { channel: channel(), args: [] }));
		await h.orchestrator.handleEvent(
			ariEvent("ChannelDestroyed", { channel: channel(), cause: 19, cause_txt: "No answer" }),
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
			ariEvent("ChannelDestroyed", { channel: channel({ id: "ghost" }), cause: 16 }),
		);
		expect(h.published).toEqual([]);
		expect(h.cdrs).toEqual([]);
	});

	it("releases the DTMF queue when the leg goes away", async () => {
		const h = await answered();
		await h.orchestrator.handleEvent(
			ariEvent("ChannelDtmfReceived", { channel: channel(), digit: "1", duration_ms: 100 }),
		);
		expect(h.dtmf.size).toBe(1);
		await h.orchestrator.handleEvent(
			ariEvent("ChannelDestroyed", { channel: channel(), cause: 16 }),
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
			ariEvent("StasisStart", { channel: channel(), args: [] }),
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
			ariEvent("StasisStart", { channel: channel(), args: [] }),
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
			...(fakeQueueOrchestratorArgs() as [never, never, never, never, never]),
		);

		await expect(
			orchestrator.handleEvent(ariEvent("StasisStart", { channel: channel(), args: [] })),
		).resolves.toBeUndefined();
		expect(orchestrator.activeChannelCount).toBe(1);
	});
});
