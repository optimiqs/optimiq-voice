import { describe, expect, it } from "bun:test";
import { parseAriEvent } from "@optimiq-voice/media-ari";
import { ROUTING_ARTIFACT_VERSION } from "@optimiq-voice/routing";
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
import type { ControlledLeg } from "./call-control";
import type { CallEventOf, CdrLegWriteEnvelope, SipTransferRequest } from "@optimiq-voice/events";
import type { PlanNode, PlanNodeTable, RoutingArtifact } from "@optimiq-voice/routing";
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
 * Wired for the same reason `NO_PARK_HANDOFF` is — the orchestrator pushes onto it in its
 * constructor — and kept rather than discarded because this is the file where a walk ORIGINATES
 * B-legs, which is the only place the desk phone that answers a call actually gets its channel.
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
 * The orchestrator's ROUTING behaviour: resolve on `StasisStart`, walk the plan, and enrich the
 * CDR with where the call went.
 *
 * `channel-orchestrator.spec.ts` covers the same class with routing OFF, which is the state
 * machines, the events, the KV mirror and the CDR. This file is the other half — the seam between
 * those and `packages/routing` — and it is the only place a fake artifact appears.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const ARI_CHANNEL = "1754400000.42";
const DID = "+12125550100";

interface PublishedEvent {
	readonly type: string;
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
		ENGINE_ROUTING_ENABLED: true,
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

/** A minimal artifact: one DID, pointing at whatever node the spec supplies. */
function artifactWith(nodes: readonly PlanNode[], entryNodeId: string): RoutingArtifact {
	return {
		artifactVersion: ROUTING_ARTIFACT_VERSION,
		organizationId: ORG,
		snapshotHash: "hash-1",
		compiledAt: "2026-08-05T12:00:00.000Z",
		settings: {},
		nodes: Object.fromEntries(nodes.map((node) => [node.id, node])) as PlanNodeTable,
		timeConditions: {},
		inbound: {
			rules: [],
			didDefaults: {
				[DID]: {
					phoneNumberId: "0195c0f0-1c2f-7000-8000-0000000000d1",
					e164: DID,
					enabled: true,
					recordEnabled: false,
					destinationNodeId: entryNodeId,
				},
			},
			noMatchNodeId: "hangup:UNALLOCATED_NUMBER",
		},
		internal: {
			featureCodes: [],
			voicemailPrefixes: [],
			numbers: {},
			mailboxes: {},
			parkSlots: [],
			noMatchNodeId: "hangup:UNALLOCATED_NUMBER",
		},
		outbound: {
			enabled: true,
			rules: [],
			noMatchNodeId: "hangup:UNALLOCATED_NUMBER",
			deniedNodeId: "hangup:OUTGOING_CALL_BARRED",
		},
		callBlock: [],
		extensionsByNumber: {},
		diagnostics: [],
	} as unknown as RoutingArtifact;
}

const TERMINALS: PlanNode[] = [
	{ id: "hangup:UNALLOCATED_NUMBER", kind: "hangup", cause: "UNALLOCATED_NUMBER" },
	{ id: "hangup:CALL_REJECTED", kind: "hangup", cause: "CALL_REJECTED" },
	{ id: "hangup:NORMAL_CLEARING", kind: "hangup", cause: "NORMAL_CLEARING" },
];

interface HarnessOptions {
	readonly artifact?: RoutingArtifact;
	readonly env?: Partial<EngineEnv>;
	/** Channel variables the media fake reports. `{}` is a call the dialplan told nothing. */
	readonly variables?: Record<string, string>;
	/** A DID index for the cases that are about the lookup. Defaults to one that never resolves. */
	readonly didIndex?: Pick<DidIndexSource, "organizationFor">;
	/** A mailbox source for the `*97` cases. Defaults to one that answers "unreadable". */
	readonly mailbox?: Pick<VoicemailMailboxRpcSource, "list">;
}

function harness(options: HarnessOptions = {}) {
	const signals = new CallSignalBus();
	// The orchestrator is built below but has to be reachable from the media fake, because a real
	// media server answers by DELIVERING AN EVENT — the whole point of `ensureAnswered`.
	const holder: { orchestrator?: ChannelOrchestrator } = {};
	const media = makeFakeMediaPort({
		variables: options.variables ?? { OPTIMIQ_ORG_ID: ORG },
		onOriginate: (request) => {
			signals.emit(legSignalKey(request.channelId), { kind: "answered" });
		},
		onAnswer: (channelId) => {
			if (channelId !== ARI_CHANNEL) {
				return;
			}
			queueMicrotask(() => {
				void holder.orchestrator?.handleEvent(
					mediaEvent("ChannelStateChange", { channel: channel({ state: "Up" }) }),
				);
			});
		},
	});

	const published: PublishedEvent[] = [];
	const events = {
		publish: async (type: string, input: { data: Record<string, unknown> }) => {
			published.push({ type, data: input.data });
			return undefined as unknown as CallEventOf<"channel.created">;
		},
	} as unknown as CallEventPublisher;

	const kv = new Map<string, ChannelSnapshot>();
	const cdrs: CdrLegWriteEnvelope[] = [];
	const jetstream = {
		putChannel: async (snapshot: ChannelSnapshot) => {
			kv.set(snapshot.channelId, snapshot);
		},
		deleteChannel: async (snapshot: ChannelSnapshot) => {
			kv.delete(snapshot.channelId);
		},
		publishCdrLeg: async (envelope: CdrLegWriteEnvelope) => {
			cdrs.push(envelope);
		},
	} as unknown as JetStreamService;

	const routing = {
		get: async () => options.artifact,
	} as unknown as RoutingArtifactSource;

	const dtmf = new DtmfRegistry();
	const runtime = makeVerbExecutorRuntime({
		media,
		collectDtmf: (context, verb) => dtmf.forChannel(context.channelId).collect(verb),
	});

	const sipTransfer = fakeSipTransfer();

	const orchestrator = new ChannelOrchestrator(
		fakeEnv(options.env),
		media,
		runtime,
		dtmf,
		events,
		jetstream,
		routing,
		// No mailbox responder in a spec, which is also the production state until the API side
		// lands: a `*97` announces the mailbox as unavailable rather than as empty.
		(options.mailbox ?? NO_MAILBOX) as VoicemailMailboxRpcSource,
		(options.didIndex ?? NO_DID_INDEX) as DidIndexSource,
		signals,
		new ConferenceRegistry(),
		...(fakeQueueOrchestratorArgs() as [never, never, never, never, never]),
		new ParkRegistry(),
		new CallControlRegistry(),
		NO_PARK_HANDOFF,
		sipTransfer.service,
	);

	holder.orchestrator = orchestrator;
	return {
		orchestrator,
		media,
		published,
		kv,
		cdrs,
		signals,
		dtmf,
		sipCallPath: sipTransfer.attached,
	};
}

function channel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: ARI_CHANNEL,
		name: "PJSIP/trunk-00000001",
		state: "Ring",
		caller: { name: "Ada", number: "+15551234567" },
		dialplan: { context: "optimiq-inbound", exten: DID, priority: 1 },
		...overrides,
	};
}

/**
 * One raw ARI frame, driven through the real boundary the process uses — parse, then map.
 *
 * The orchestrator consumes {@link MediaEvent} and knows nothing about ARI; starting from a frame
 * keeps these fixtures anchored to something a media server actually emits. Every ARI type used
 * here has a domain counterpart, so an `undefined` mapping is a bug in the fixture, not a case.
 */
function mediaEvent(ariType: string, extra: Record<string, unknown>): MediaEvent {
	const event = toMediaEvent(
		parseAriEvent({ type: ariType, application: "optimiq-engine", ...extra }),
	);
	if (event === undefined) {
		throw new Error(`${ariType} maps to no MediaEvent`);
	}
	return event;
}

/** Arrive, then let the detached walk settle. */
async function arrive(h: ReturnType<typeof harness>): Promise<void> {
	await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
	await h.orchestrator.awaitWalks();
}

describe("routed inbound calls", () => {
	it("resolves the DID and walks the plan it produced", async () => {
		const h = harness({
			artifact: artifactWith(
				[
					...TERMINALS,
					{
						id: "ext:1",
						kind: "extension",
						extensionId: "0195c0f0-1c2f-7000-8000-0000000000f1",
						number: "1001",
						tollClass: "internal",
						recordPolicy: "none",
						timeoutSeconds: 20,
						doNotDisturb: false,
					} as PlanNode,
				],
				"ext:1",
			),
		});

		await arrive(h);

		expect(h.media.originated()[0]?.endpoint).toBe("PJSIP/1001");
		expect(h.media.methods()).toContain("createBridge");
		expect(h.published.map((event) => event.type)).toContain("channel.bridged");
	});

	it("does NOT run the pre-routing announcement over the plan", async () => {
		const h = harness({
			env: { ENGINE_INBOUND_ANNOUNCEMENT: "sound:welcome" },
			artifact: artifactWith(
				[...TERMINALS, { id: "p", kind: "playback", promptId: "greeting" } as PlanNode],
				"p",
			),
		});

		await arrive(h);

		const played = h.media.calls
			.filter((call) => call.method === "play")
			.map((call) => (call.args[1] as { media: string[] }).media[0]);
		expect(played).toEqual(["sound:greeting"]);
	});

	it("rejects a DID nothing matches with UNALLOCATED_NUMBER, never a guess", async () => {
		const h = harness({ artifact: artifactWith(TERMINALS, "hangup:UNALLOCATED_NUMBER") });
		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", {
				channel: channel({ dialplan: { context: "optimiq-inbound", exten: "+19998887777" } }),
				args: [],
			}),
		);
		await h.orchestrator.awaitWalks();

		expect(h.media.hungUp()).toContainEqual({
			channelId: ARI_CHANNEL,
			cause: "UNALLOCATED_NUMBER",
		});
	});

	it("falls back to the unrouted program when the organization has no artifact", async () => {
		const h = harness();
		await arrive(h);

		// Ring + answer, and no rejection: a control plane that is briefly unreachable must not
		// silently drop every inbound call.
		expect(h.media.methods()).toEqual(["watchChannel", "ring", "answer"]);
	});

	it("honours a call-block rule by walking the terminal the resolver chose", async () => {
		const artifact = artifactWith(TERMINALS, "hangup:NORMAL_CLEARING");
		const blocked = {
			...artifact,
			callBlock: [
				{
					id: "0195c0f0-1c2f-7000-8000-0000000000b1",
					direction: "inbound",
					action: "block",
					pattern: { kind: "exact", value: "+15551234567" },
					label: "known nuisance",
				},
			],
		} as unknown as import("@optimiq-voice/routing").RoutingArtifact;

		const h = harness({ artifact: blocked });
		await arrive(h);

		expect(h.media.hungUp()).toContainEqual({ channelId: ARI_CHANNEL, cause: "CALL_REJECTED" });
		// A blocked caller is never answered, so it is never billed.
		expect(h.media.methods()).not.toContain("answer");
	});
});

describe("CDR destination enrichment", () => {
	it("fills destinationType and destinationRef from the walk", async () => {
		const h = harness({
			artifact: artifactWith(
				[
					...TERMINALS,
					{
						id: "ivr:1",
						kind: "ivr-menu",
						ivrMenuId: "0195c0f0-1c2f-7000-8000-0000000000f9",
						digitTimeoutMs: 10,
						interDigitTimeoutMs: 10,
						maxDigits: 1,
						maxFailures: 0,
						maxTimeouts: 0,
						directDialEnabled: false,
						options: [],
					} as PlanNode,
				],
				"ivr:1",
			),
		});

		await arrive(h);
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: channel(), cause: 16 }),
		);

		expect(h.cdrs[0]?.data).toMatchObject({
			destinationType: "ivr-menu",
			destinationRef: "0195c0f0-1c2f-7000-8000-0000000000f9",
		});
	});

	it("mirrors the destination onto the channel snapshot, so a failover can write it too", async () => {
		const h = harness({
			artifact: artifactWith(
				[...TERMINALS, { id: "p", kind: "playback", promptId: "greeting" } as PlanNode],
				"p",
			),
		});

		await arrive(h);

		const snapshot = [...h.kv.values()][0];
		expect(snapshot?.variables.OPTIMIQ_DESTINATION_TYPE).toBe("playback");
	});

	it("still reports `unknown` for a leg that was never routed", async () => {
		const h = harness();
		await arrive(h);
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: channel(), cause: 16 }),
		);

		expect(h.cdrs[0]?.data).toMatchObject({ destinationType: "unknown", destinationRef: null });
	});
});

describe("legs the walker originated", () => {
	it("does NOT file a B-leg's StasisStart as a new inbound call", async () => {
		const h = harness();
		// Stand in for the walker: a watched key is what marks a leg as ours.
		const seen: string[] = [];
		h.signals.watch(legSignalKey("b-leg-1"), (signal) => seen.push(signal.kind));

		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel({ id: "b-leg-1" }), args: [] }),
		);

		expect(seen).toEqual(["entered"]);
		expect(h.orchestrator.activeChannelCount).toBe(0);
		expect(h.published).toEqual([]);
	});

	it("republishes a B-leg's answer on the signal bus", async () => {
		const h = harness();
		const seen: string[] = [];
		h.signals.watch(legSignalKey("b-leg-1"), (signal) => seen.push(signal.kind));

		await h.orchestrator.handleEvent(
			mediaEvent("ChannelStateChange", { channel: channel({ id: "b-leg-1", state: "Up" }) }),
		);
		expect(seen).toEqual(["answered"]);
	});

	it("republishes a B-leg's death with the Q.850 cause the failover keys off", async () => {
		const h = harness();
		const seen: unknown[] = [];
		h.signals.watch(legSignalKey("b-leg-1"), (signal) => seen.push(signal));

		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: channel({ id: "b-leg-1" }), cause: 17 }),
		);
		expect(seen).toEqual([{ kind: "ended", cause: "USER_BUSY", causeCode: 17 }]);
	});

	it("republishes recording progress so a voicemail can finish", async () => {
		const h = harness();
		const seen: unknown[] = [];
		h.signals.watch("recording:vm-1", (signal) => seen.push(signal));

		await h.orchestrator.handleEvent(
			mediaEvent("RecordingFinished", {
				recording: { name: "vm-1", format: "wav", duration: 3 },
			}),
		);
		expect(seen).toEqual([{ kind: "recording-finished", durationMs: 3_000 }]);
	});

	it("republishes a failed recording with the media server's reason", async () => {
		const h = harness();
		const seen: unknown[] = [];
		h.signals.watch("recording:vm-1", (signal) => seen.push(signal));

		await h.orchestrator.handleEvent(
			mediaEvent("RecordingFailed", {
				recording: { name: "vm-1", format: "wav", cause: "disk full" },
			}),
		);
		expect(seen).toEqual([{ kind: "recording-failed", reason: "disk full" }]);
	});
});

describe("drain with routing on", () => {
	it("drops every waiter, so an in-flight walk can settle instead of holding the drain", async () => {
		const h = harness();
		h.signals.watch(legSignalKey("b-leg-1"), () => undefined);
		await h.orchestrator.drain(0);

		expect(h.signals.watchedKeyCount).toBe(0);
		expect(h.orchestrator.isDraining).toBe(true);
	});

	it("reports no walks in flight once they have settled", async () => {
		const h = harness({ artifact: artifactWith(TERMINALS, "hangup:NORMAL_CLEARING") });
		await arrive(h);
		expect(h.orchestrator.activeWalkCount).toBe(0);
	});
});

// =================================================================================================
// B-leg CDRs
// =================================================================================================

/** The ARI channel shape a leg the engine originated arrives as. */
function bLegChannel(id: string): Record<string, unknown> {
	return {
		id,
		name: `PJSIP/1001-${id.slice(-4)}`,
		state: "Up",
		caller: { name: "", number: "" },
		dialplan: { context: "optimiq-internal", exten: "1001", priority: 1 },
	};
}

/** An extension node the plan can dial. */
function extensionNode(id: string, number: string, extensionId: string): PlanNode {
	return {
		id,
		kind: "extension",
		extensionId,
		number,
		tollClass: "internal",
		recordPolicy: "none",
		timeoutSeconds: 20,
		doNotDisturb: false,
	} as PlanNode;
}

describe("B-leg CDRs", () => {
	/**
	 * The gap this closes: a call to a ring group produced FIVE legs and ONE record. Everything a
	 * PBX is asked about the other four — which agent answered, how long each phone rang, what the
	 * losers were told — is unanswerable from the caller's row alone.
	 */
	it("gives an originated leg its own record, linked to the A-leg by callId", async () => {
		const extensionId = "0195c0f0-1c2f-7000-8000-0000000000f1";
		const h = harness({
			artifact: artifactWith([...TERMINALS, extensionNode("ext:1", "1001", extensionId)], "ext:1"),
		});

		await arrive(h);
		const bLegChannelId = h.media.originated()[0]?.channelId as string;
		expect(bLegChannelId).toBeDefined();

		// Both legs end. The B-leg first, as a callee hanging up does.
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: bLegChannel(bLegChannelId), cause: 16 }),
		);
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: channel(), cause: 16 }),
		);

		expect(h.cdrs).toHaveLength(2);
		const [bLeg, aLeg] = h.cdrs;
		expect(bLeg?.data.leg).toBe("b");
		expect(aLeg?.data.leg).toBe("a");
		// One call, two rows: the correlation the `call_legs` table has always modelled.
		expect(bLeg?.data.callId).toBe(aLeg?.data.callId as string);
		// The B-leg names the leg that dialled it; the A-leg names nobody.
		expect(bLeg?.data.originatingLegId).toBeTruthy();
		expect(aLeg?.data.originatingLegId).toBeNull();
		// The B-leg reports who it reached, not who called.
		expect(bLeg?.data.toNumber).toBe("1001");
		expect(bLeg?.data.destinationType).toBe("extension");
		expect(bLeg?.data.destinationRef).toBe(extensionId);
		// A callee's hangup is attributed to the callee, never to the caller.
		expect(bLeg?.data.hangupSide).toBe("callee");
	});

	it("plays hold music at the FAR END when a phone presses hold", async () => {
		const h = harness({
			artifact: artifactWith(
				[...TERMINALS, extensionNode("ext:1", "1001", "0195c0f0-1c2f-7000-8000-0000000000f1")],
				"ext:1",
			),
		});

		await arrive(h);
		const bLegChannelId = h.media.originated()[0]?.channelId as string;

		await h.orchestrator.handleEvent(
			// ARI spells it lower-case on the wire; the parser is what normalises it.
			mediaEvent("ChannelHold", { channel: bLegChannel(bLegChannelId), musicclass: "default" }),
		);

		// The person who needs music is the CALLER, not the agent who pressed the key: the agent can
		// hear their own phone, and a caller in silence concludes the call has dropped.
		const started = h.media.calls.find((call) => call.method === "startMusicOnHold");
		expect(started?.args).toEqual([ARI_CHANNEL, "default"]);
		expect(h.published.filter((event) => event.type === "channel.held")).toHaveLength(1);

		await h.orchestrator.handleEvent(
			mediaEvent("ChannelUnhold", { channel: bLegChannel(bLegChannelId) }),
		);
		expect(h.media.calls.some((call) => call.method === "stopMusicOnHold")).toBe(true);
		expect(h.published.filter((event) => event.type === "channel.unheld")).toHaveLength(1);
	});

	it("records the bridge on both legs, so a call can be reassembled from either", async () => {
		const h = harness({
			artifact: artifactWith(
				[...TERMINALS, extensionNode("ext:1", "1001", "0195c0f0-1c2f-7000-8000-0000000000f1")],
				"ext:1",
			),
		});

		await arrive(h);
		const bLegChannelId = h.media.originated()[0]?.channelId as string;

		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: bLegChannel(bLegChannelId), cause: 16 }),
		);

		// The B-leg died while both were still in the bridge, so it names its peer.
		expect(h.cdrs[0]?.data.bridgeLegId).toBeTruthy();
	});

	it("mirrors an originated leg into the channels bucket under the same call", async () => {
		const h = harness({
			artifact: artifactWith(
				[...TERMINALS, extensionNode("ext:1", "1001", "0195c0f0-1c2f-7000-8000-0000000000f1")],
				"ext:1",
			),
		});

		await arrive(h);

		const snapshots = [...h.kv.values()];
		expect(snapshots.filter((snapshot) => snapshot.variables.OPTIMIQ_LEG === "b")).toHaveLength(1);
		expect(new Set(snapshots.map((snapshot) => snapshot.callId)).size).toBe(1);
	});

	it("publishes channel.created for the leg it dialled, marked as the B side", async () => {
		const h = harness({
			artifact: artifactWith(
				[...TERMINALS, extensionNode("ext:1", "1001", "0195c0f0-1c2f-7000-8000-0000000000f1")],
				"ext:1",
			),
		});

		await arrive(h);

		const created = h.published.filter((event) => event.type === "channel.created");
		expect(created).toHaveLength(2);
		expect(created.map((event) => event.data.leg).sort()).toEqual(["a", "b"]);
	});
});

// =================================================================================================
// Multi-tenant attribution
// =================================================================================================

describe("attributing an inbound call to a tenant", () => {
	/**
	 * The blocker this closes. Without the index the engine could only read `OPTIMIQ_ORG_ID` off the
	 * channel, so one dialplan served one tenant and every other tenant's DID was rejected.
	 */
	it("resolves the organization from the did-index when the channel carries none", async () => {
		const looked: (string | undefined)[] = [];
		const h = harness({
			artifact: artifactWith(TERMINALS, "hangup:NORMAL_CLEARING"),
			variables: {},
			didIndex: {
				organizationFor: async (did: string | undefined) => {
					looked.push(did);
					return { organizationId: ORG, phoneNumberId: "pn-1", e164: DID, enabled: true };
				},
			},
		});

		await arrive(h);

		expect(looked).toEqual([DID]);
		expect(h.cdrs).toHaveLength(0);
		// The call was accepted and walked, not rejected at the door.
		expect(h.media.hungUp().map((entry) => entry.cause)).not.toContain("INVALID_PROFILE");
	});

	/**
	 * The one ordering decision that matters: putting the development default ABOVE the index would
	 * make a box with the variable set answer every tenant's DID as its own tenant — reintroducing
	 * the exact bug the index exists to prevent, through the fallback meant to make one box handy.
	 */
	it("prefers the did-index over ENGINE_DEFAULT_ORGANIZATION_ID", async () => {
		const other = "0195c0f0-1c2f-7000-8000-000000000002";
		const h = harness({
			artifact: artifactWith(TERMINALS, "hangup:NORMAL_CLEARING"),
			variables: {},
			env: { ENGINE_DEFAULT_ORGANIZATION_ID: other },
			didIndex: {
				organizationFor: async () => ({ organizationId: ORG, enabled: true }),
			},
		});

		await arrive(h);
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: channel(), cause: 16 }),
		);

		expect(h.cdrs[0]?.orgId).toBe(ORG);
	});

	it("rejects with INVALID_PROFILE when nothing can attribute the call", async () => {
		const h = harness({ variables: {} });

		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		await h.orchestrator.awaitWalks();

		expect(h.media.hungUp()).toContainEqual({ channelId: ARI_CHANNEL, cause: "INVALID_PROFILE" });
		// Never filed under a guess: no CDR, no events, nothing in KV.
		expect(h.cdrs).toEqual([]);
	});
});

// =================================================================================================
// SIP dialogs
// =================================================================================================

/**
 * The correlation `rpc.sip.v1.transfer` rests on, exercised where the interesting leg exists.
 *
 * The A-leg case belongs in `channel-orchestrator.spec.ts`. What only this file can drive is the
 * leg the WALK dialled — the desk phone that ANSWERED — because that aggregate is created by the
 * walker's own hook rather than by the arrival path, and it is the leg somebody's thumb is on when
 * they reach for the TRANSFER key on an incoming call.
 */
describe("sip dialog correlation", () => {
	const EXTENSION_ID = "0195c0f0-1c2f-7000-8000-0000000000f1";
	const TARGET_ID = "0195c0f0-1c2f-7000-8000-0000000000f2";

	/** As much of a REFER as `resolveDialog` reads. */
	function refer(sipCallId: string): SipTransferRequest {
		return { sipCallId } as unknown as SipTransferRequest;
	}

	/** The ring-group-of-one artifact every case here uses, plus a dialable transfer target. */
	function artifact(): RoutingArtifact {
		const base = artifactWith(
			[
				...TERMINALS,
				extensionNode("ext:1", "1001", EXTENSION_ID),
				extensionNode("ext:2", "1002", TARGET_ID),
			],
			"ext:1",
		);
		return {
			...base,
			internal: {
				...base.internal,
				numbers: {
					"1002": { number: "1002", kind: "extension", entityId: TARGET_ID, nodeId: "ext:2" },
				},
			},
		} as unknown as RoutingArtifact;
	}

	/** Arrive, then deliver the callee's own `StasisStart` carrying its dialog. */
	async function answeredBy(sipCallId: string): Promise<{
		readonly h: ReturnType<typeof harness>;
		readonly bLegChannelId: string;
	}> {
		const h = harness({ artifact: artifact() });
		await arrive(h);
		const bLegChannelId = h.media.originated()[0]?.channelId as string;
		h.media.variables["CHANNEL(pjsip,call-id)"] = sipCallId;
		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: bLegChannel(bLegChannelId), args: [] }),
		);
		return { h, bLegChannelId };
	}

	it("indexes the leg a walk dialled, which is the only way an ANSWERED call can be transferred", async () => {
		const { h, bLegChannelId } = await answeredBy("callee@1.2.3.4");

		await expect(h.sipCallPath().resolveDialog(refer("callee@1.2.3.4"))).resolves.toBe(
			bLegChannelId,
		);
		// And the leg the responder authorises against knows the number it was dialled TO, which is
		// the half of its participation check that a callee matches on.
		expect(h.sipCallPath().legFor(bLegChannelId)?.destinationNumber).toBe("1001");
	});

	it("keeps the callee's dialog out of the caller's index entry", async () => {
		const { h } = await answeredBy("callee@1.2.3.4");

		// The A-leg arrived before the fake knew any Call-ID, so it holds none — and the B-leg's must
		// not have been filed against it.
		await expect(h.sipCallPath().resolveDialog(refer("caller@1.2.3.4"))).resolves.toBe(undefined);
	});

	it("releases the callee's key when the callee hangs up", async () => {
		const { h, bLegChannelId } = await answeredBy("callee@1.2.3.4");

		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: bLegChannel(bLegChannelId), cause: 16 }),
		);

		await expect(h.sipCallPath().resolveDialog(refer("callee@1.2.3.4"))).resolves.toBe(undefined);
	});

	it("accepts a Refer-To the tenant's plan can reach", async () => {
		const { h, bLegChannelId } = await answeredBy("callee@1.2.3.4");
		const leg = h.sipCallPath().legFor(bLegChannelId);

		await expect(h.sipCallPath().isDialableTarget?.(leg as ControlledLeg, "1002")).resolves.toBe(
			true,
		);
	});

	it("refuses one it cannot, BEFORE the transfer tears the call apart", async () => {
		const { h, bLegChannelId } = await answeredBy("callee@1.2.3.4");
		const leg = h.sipCallPath().legFor(bLegChannelId);

		// `unknown_target` at the responder. Attempting it instead would hang the transferor up and
		// re-route the transferee at a destination that was never going to answer.
		await expect(h.sipCallPath().isDialableTarget?.(leg as ControlledLeg, "9999")).resolves.toBe(
			false,
		);
		await expect(h.sipCallPath().isDialableTarget?.(leg as ControlledLeg, "  ")).resolves.toBe(
			false,
		);
	});

	it("lets a transfer through when the artifact cannot be read, rather than failing the feature", async () => {
		const h = harness();
		await arrive(h);
		const leg = h.sipCallPath().legFor(ARI_CHANNEL);

		// A cache miss on a briefly unreachable control plane must not refuse every transfer key in
		// the building; the routing walk behind it still reports whatever it finds.
		await expect(h.sipCallPath().isDialableTarget?.(leg as ControlledLeg, "1002")).resolves.toBe(
			true,
		);
	});
});
