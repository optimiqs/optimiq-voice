import { describe, expect, it } from "bun:test";
import { parseAriEvent } from "@optimiq-voice/media-ari";
import { ROUTING_ARTIFACT_VERSION } from "@optimiq-voice/routing";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { MediadMediaPort } from "../media/mediad-media.port";
import { FakeMediadTransport } from "../media/mediad-transport.fake";
import { SplitPlaneMediaPort } from "../media/split-plane.port";
import { CHANNEL_OWNERSHIP_LEASE_MS, withChannelOwnership } from "../nats/channel-ownership";
import { fakeQueueOrchestratorArgs } from "../queue/queue-services.fake";
import { CallSignalBus, legSignalKey } from "../routing/call-signals";
import { ConferenceRegistry } from "../routing/conference-registry";
import { ParkRegistry } from "../routing/park-registry";
import { DtmfRegistry } from "../verbs/dtmf-registry";
import { makeVerbExecutorRuntime } from "../verbs/verb-executor";
import { toMediaEvent } from "./ari-mapping";
import { CallControlRegistry } from "./call-control-registry";
import { callIdForAriChannel, legIdForAriChannel } from "./channel-identity";
import { ChannelOrchestrator } from "./channel-orchestrator.service";
import type { EngineEnv } from "../config/engine-env";
import type { MediaEvent } from "../media/media-event";
import type { CallEventPublisher } from "../nats/call-event-publisher.service";
import type { JetStreamService } from "../nats/jetstream.service";
import type { OriginateCallPath, OriginateService } from "../nats/originate.service";
import type { ParkHandoffService } from "../nats/park-handoff.service";
import type { SipInviteCallPath, SipInviteService } from "../nats/sip-invite.service";
import type { SipTransferCallPath, SipTransferService } from "../nats/sip-transfer.service";
import type { SipdCommandPort } from "../nats/sipd-command.client";
import type { DidIndexSource } from "../routing/did-index.source";
import type { ExtensionFeatureRpcPort } from "../routing/extension-feature.source";
import type { LastCallerRpcSource } from "../routing/last-caller.source";
import type { RoutingArtifactSource } from "../routing/routing-artifact.source";
import type { SharedLineRegistry } from "../routing/shared-line-registry";
import type { SupervisorAuthzRpcPort } from "../routing/supervisor-authz.source";
import type { ToggleFeatureRpcPort } from "../routing/toggle-feature.source";
import type { VoicemailGreetingRpcPort } from "../routing/voicemail-greeting.source";
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
 * Feature-code seams that refuse.
 *
 * These specs are about the orchestrator's own wiring, not about `*72` or `*69` — those live in
 * `routing/plan-walker-features.spec.ts`, where the walker's ports are faked directly. Refusing
 * here keeps a star code dialled by accident from reaching a broker that is not running.
 */
const NO_FEATURES = {
	apply: async () => ({ applied: false, enabled: false, reason: "no responder in this spec" }),
} as unknown as ExtensionFeatureRpcPort;

const NO_LAST_CALLER = {
	lookup: async () => ({ found: false, reason: "no responder in this spec" }),
} as unknown as LastCallerRpcSource;

/**
 * A greeting sink that refuses, on the same terms as the two above it.
 *
 * `*99` is specced in `routing/plan-walker-features.spec.ts` against a fake port. A throw here is
 * what a walk with no responder sees, and it keeps a star code dialled by accident in one of these
 * specs from reaching a broker that is not running.
 */
const NO_GREETINGS = {
	greetingRecorded: async (): Promise<void> => {
		throw new Error("no responder in this spec");
	},
} as unknown as VoicemailGreetingRpcPort;

/**
 * A supervision gate that DENIES, which is the only safe default for a fake.
 *
 * The one port in the engine that must fail closed: `*0` is specced in
 * `routing/plan-walker-features.spec.ts` against a fake that answers both ways, and an orchestrator
 * spec that accidentally dialled it must not discover a tap. See `supervisor-authz.source.ts`.
 */
const NO_SUPERVISION = {
	authorize: async () => ({ allowed: false, reason: "no responder in this spec" }),
} as unknown as SupervisorAuthzRpcPort;

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
 * An originate responder that keeps the call path instead of serving it.
 *
 * The same arrangement as {@link fakeSipTransfer} above, and for the same reason: the broker half is
 * proven in `nats/originate.service.spec.ts` with a fake call path, and this is the other side of
 * the seam — what the orchestrator itself does when asked to place a click-to-call.
 */
function fakeOriginate(): {
	readonly service: OriginateService;
	readonly attached: () => OriginateCallPath;
} {
	let attached: OriginateCallPath | undefined;
	const service = {
		attach: (callPath: OriginateCallPath) => {
			attached = callPath;
		},
	} as unknown as OriginateService;
	return {
		service,
		attached: () => {
			if (attached === undefined) {
				throw new Error("the orchestrator attached no originate call path");
			}
			return attached;
		},
	};
}

/**
 * A sip-invite responder that keeps the call path instead of serving it.
 *
 * The same arrangement as {@link fakeOriginate} above. The broker half — framing, the toll-fraud
 * refusal, the Replaces gate — is proven in `nats/sip-invite.service.spec.ts` with a fake call path;
 * this is the other side of the seam, and having it here is what lets a spec admit a call the way
 * `apps/sipd` does.
 */
function fakeSipInvite(): {
	readonly service: SipInviteService;
	readonly attached: () => SipInviteCallPath;
} {
	let attached: SipInviteCallPath | undefined;
	const service = {
		attach: (callPath: SipInviteCallPath) => {
			attached = callPath;
		},
	} as unknown as SipInviteService;
	return {
		service,
		attached: () => {
			if (attached === undefined) {
				throw new Error("the orchestrator attached no sip invite call path");
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
		ENGINE_INSTANCE_ID: "engine-test",
		ENGINE_ROUTING_ENABLED: true,
		ENGINE_ROUTING_RPC_TIMEOUT_MS: 2_000,
		ENGINE_MEDIA_DRIVER: "ari",
		ENGINE_EXTENSION_DIAL_TEMPLATE: "PJSIP/{number}",
		ENGINE_TRUNK_DIAL_TEMPLATE: "PJSIP/{number}@{trunk}",
		ENGINE_DEFAULT_RING_TIMEOUT_SECONDS: 30,
		ENGINE_PROGRESS_TIMEOUT_SECONDS: 0,
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
	readonly nativeMedia?: SplitPlaneMediaPort;
	readonly artifact?: RoutingArtifact;
	readonly env?: Partial<EngineEnv>;
	/** Channel variables the media fake reports. `{}` is a call the dialplan told nothing. */
	readonly variables?: Record<string, string>;
	/** A DID index for the cases that are about the lookup. Defaults to one that never resolves. */
	readonly didIndex?: Pick<DidIndexSource, "organizationFor">;
	/** A mailbox source for the `*97` cases. Defaults to one that answers "unreadable". */
	readonly mailbox?: Pick<VoicemailMailboxRpcSource, "list">;
	/**
	 * What the media server delivers after the A-leg is answered, in place of the `Up` state change.
	 *
	 * The one seam that lets a spec make an event land in the MIDDLE of a walk. Everything else here
	 * drives events from outside, after `awaitWalks`, which is the one shape of arrival the engine
	 * never has to worry about.
	 */
	readonly onAnswered?: () => MediaEvent;
	/** Makes `MediaPort.originate` refuse, which is how an unregistered extension presents. */
	readonly originateFails?: boolean;
	/** The `*65`/`*64` write seam, for the cases that assert the orchestrator hands it to the walk. */
	readonly toggles?: ToggleFeatureRpcPort;
	/** The shared-line seizure registry, for the same reason. */
	readonly sharedLines?: SharedLineRegistry;
}

function harness(options: HarnessOptions = {}) {
	const env = fakeEnv(options.env);
	const signals = new CallSignalBus();
	// The orchestrator is built below but has to be reachable from the media fake, because a real
	// media server answers by DELIVERING AN EVENT — the whole point of `ensureAnswered`.
	const holder: { orchestrator?: ChannelOrchestrator } = {};
	const media = makeFakeMediaPort({
		variables: options.variables ?? { OPTIMIQ_ORG_ID: ORG },
		...(options.originateFails === true
			? { originateFails: () => new Error("Endpoint not found") }
			: {}),
		onOriginate: (request) => {
			signals.emit(legSignalKey(request.channelId), { kind: "answered" });
		},
		onAnswer: (channelId) => {
			if (channelId !== ARI_CHANNEL) {
				return;
			}
			queueMicrotask(() => {
				void holder.orchestrator?.handleEvent(
					options.onAnswered?.() ??
						mediaEvent("ChannelStateChange", { channel: channel({ state: "Up" }) }),
				);
			});
		},
	});

	const published: PublishedEvent[] = [];
	const events = {
		publish: async (type: string, input: { data: Record<string, unknown> }) => {
			published.push({ type, data: input.data });
			return {} as CallEventOf<"channel.created">;
		},
	} as unknown as CallEventPublisher;

	const kv = new Map<string, ChannelSnapshot>();
	const cdrs: CdrLegWriteEnvelope[] = [];
	const jetstream = {
		putChannel: async (snapshot: ChannelSnapshot, now = Date.now()) => {
			kv.set(
				snapshot.channelId,
				withChannelOwnership(snapshot, env.ENGINE_INSTANCE_ID, now + CHANNEL_OWNERSHIP_LEASE_MS),
			);
		},
		persistChannel: async (snapshot: ChannelSnapshot, now = Date.now()) => {
			kv.set(
				snapshot.channelId,
				withChannelOwnership(snapshot, env.ENGINE_INSTANCE_ID, now + CHANNEL_OWNERSHIP_LEASE_MS),
			);
			return true;
		},
		claimChannel: async (snapshot: ChannelSnapshot, now = Date.now()) => {
			if (kv.has(snapshot.channelId)) {
				return "owned";
			}
			kv.set(
				snapshot.channelId,
				withChannelOwnership(snapshot, env.ENGINE_INSTANCE_ID, now + CHANNEL_OWNERSHIP_LEASE_MS),
			);
			return "claimed";
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
		media: options.nativeMedia ?? media,
		collectDtmf: (context, verb) => dtmf.forChannel(context.channelId).collect(verb),
	});

	const sipTransfer = fakeSipTransfer();
	const originate = fakeOriginate();
	const sipInvite = fakeSipInvite();

	const orchestrator = new ChannelOrchestrator(
		env,
		options.nativeMedia ?? media,
		runtime,
		dtmf,
		events,
		jetstream,
		routing,
		// No mailbox responder in a spec, which is also the production state until the API side
		// lands: a `*97` announces the mailbox as unavailable rather than as empty.
		(options.mailbox ?? NO_MAILBOX) as VoicemailMailboxRpcSource,
		NO_FEATURES,
		NO_LAST_CALLER,
		NO_GREETINGS,
		NO_SUPERVISION,
		(options.didIndex ?? NO_DID_INDEX) as DidIndexSource,
		signals,
		new ConferenceRegistry(),
		...(fakeQueueOrchestratorArgs() as [never, never, never, never, never]),
		new ParkRegistry(),
		new CallControlRegistry(),
		NO_PARK_HANDOFF,
		sipTransfer.service,
		originate.service,
		sipInvite.service,
		undefined,
		undefined,
		undefined,
		undefined,
		options.toggles,
		options.sharedLines,
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
		originatePath: originate.attached,
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

	/**
	 * A phone that presses hold re-INVITEs with `sendonly` and names no music — SIP has no way to name
	 * any — so the far end got the media server's default class and a tenant's own music was reachable
	 * from a queue and a park lot and from nowhere else. The class the compiler resolved for the
	 * destination now travels onto the leg beside the destination itself, and the hold path reads it.
	 */
	it("plays the destination's own music-on-hold class at the held party", async () => {
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
						mohClass: "jazz",
					} as PlanNode,
				],
				"ext:1",
			),
		});

		await arrive(h);
		await h.orchestrator.handleEvent(mediaEvent("ChannelHold", { channel: channel() }));

		expect(h.media.calls.find((call) => call.method === "startMusicOnHold")?.args[1]).toBe("jazz");
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

	/**
	 * The caller hangs up mid-walk, which is the case the destination used to be lost in.
	 *
	 * A walk records where it went; the teardown writes the CDR. While the destination was recorded
	 * from the walk's RESULT, those two raced whenever the leg went away before the walk returned —
	 * a caller hanging up on a greeting, and, deterministically enough to fail an integration run
	 * about one time in four, a queue ejecting a caller nobody was there to answer. The loser was
	 * always the CDR: a caller who had demonstrably reached a menu was filed as `unknown`.
	 */
	const IVR_ID = "0195c0f0-1c2f-7000-8000-0000000000f9";

	function hangsUpDuringTheGreeting() {
		return harness({
			artifact: artifactWith(
				[
					...TERMINALS,
					{
						id: "ivr:1",
						kind: "ivr-menu",
						ivrMenuId: IVR_ID,
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
			// `ChannelDestroyed` instead of the `Up` the answer was waiting for: the leg dies, and the
			// CDR is written, while the walk is still inside the IVR node.
			onAnswered: () => mediaEvent("ChannelDestroyed", { channel: channel(), cause: 16 }),
		});
	}

	it("has already recorded the destination when a mid-walk teardown writes the CDR", async () => {
		const h = hangsUpDuringTheGreeting();
		await arrive(h);

		expect(h.cdrs).toHaveLength(1);
		expect(h.cdrs[0]?.data).toMatchObject({
			destinationType: "ivr-menu",
			destinationRef: IVR_ID,
		});
	});

	it("does not put a leg the walk hung up back into the channels bucket", async () => {
		const h = hangsUpDuringTheGreeting();
		await arrive(h);

		// The teardown deleted the entry. A mirror written after it — which is what the post-walk
		// destination write did — leaves a live channel in the bucket for a call that is over, and
		// nothing ever comes back to clear it.
		expect([...h.kv.keys()]).toEqual([]);
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
// The organization's simultaneous-call ceiling
// =================================================================================================

/**
 * `org_limit.max_concurrent_calls`, enforced at admission.
 *
 * The column existed, was writable, was rendered on a page, and was enforced by nothing. What these
 * specs pin is the two decisions that make the gate correct rather than merely present:
 *
 * 1. **A refused call consumes nothing.** No KV claim, no `channel.created`, no registry entry. Any
 *    one of those would make the refusal itself occupy a slot, so an organization at its ceiling
 *    would ratchet downwards with every call it turned away.
 * 2. **`SWITCH_CONGESTION`, not `NORMAL_TEMPORARY_FAILURE`.** The drain uses the latter precisely so
 *    a carrier fails the call over to another instance, which is exactly wrong here: every other
 *    instance is subject to the same quota and would refuse it too.
 */
describe("the organization's simultaneous-call ceiling", () => {
	function cappedArtifact(maxConcurrentCalls: number): RoutingArtifact {
		const base = artifactWith(TERMINALS, "hangup:NORMAL_CLEARING");
		return { ...base, settings: { ...base.settings, maxConcurrentCalls } } as RoutingArtifact;
	}

	/** A second arrival under a ceiling of one, with the first leg still live. */
	async function secondArrival(artifact: RoutingArtifact) {
		const h = harness({ artifact });
		// The first call is admitted and left UP: no `ChannelDestroyed`, so it is still occupying a
		// slot when the second arrives. A terminal plan would hang it up and free the slot again.
		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel({ id: "1754400000.1" }), args: [] }),
		);
		await h.orchestrator.awaitWalks();
		const before = h.media.calls.length;
		const publishedBefore = h.published.length;

		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel({ id: "1754400000.2" }), args: [] }),
		);
		await h.orchestrator.awaitWalks();
		return { h, before, publishedBefore };
	}

	it("admits every call when the tenant has no ceiling", async () => {
		const h = harness({ artifact: artifactWith(TERMINALS, "hangup:NORMAL_CLEARING") });
		await arrive(h);

		expect(h.published.map((event) => event.type)).toContain("channel.created");
	});

	it("refuses the call over the cap with a cause that says congestion, not failover", async () => {
		const { h, before } = await secondArrival(cappedArtifact(1));

		expect(h.media.calls.slice(before)).toEqual([
			{ method: "hangup", args: ["1754400000.2", "SWITCH_CONGESTION"] },
		]);
	});

	/** The half that stops a full tenant ratcheting downwards on every call it turns away. */
	it("publishes nothing and claims nothing for a call it refused", async () => {
		const { h, publishedBefore } = await secondArrival(cappedArtifact(1));

		expect(h.published.slice(publishedBefore)).toEqual([]);
		expect(h.kv.has("1754400000.2")).toBe(false);
	});

	/** At one of one the SECOND call is the one over the line — the `>=` the API's counter uses. */
	it("admits up to the ceiling and refuses only past it", async () => {
		const { h, before } = await secondArrival(cappedArtifact(2));

		expect(h.media.calls.slice(before)).not.toContainEqual({
			method: "hangup",
			args: ["1754400000.2", "SWITCH_CONGESTION"],
		});
	});

	/**
	 * A quota this process could not read must not become an outage. A tenant whose artifact has not
	 * compiled yet is a tenant with no ceiling, which is what they had before this gate existed.
	 */
	it("admits when there is no artifact to read a ceiling from", async () => {
		const h = harness();
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		await h.orchestrator.awaitWalks();

		expect(h.media.calls).not.toContainEqual({
			method: "hangup",
			args: [ARI_CHANNEL, "SWITCH_CONGESTION"],
		});
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
		const bLegSnapshot = [...h.kv.values()].find(
			(snapshot) => snapshot.variables.OPTIMIQ_LEG === "b",
		);
		expect(bLegSnapshot?.variables).toMatchObject({
			OPTIMIQ_ENGINE_INSTANCE_ID: "engine-test",
		});
		expect(Number(bLegSnapshot?.variables.OPTIMIQ_ENGINE_OWNER_EXPIRES_AT)).toBeGreaterThan(
			Date.now(),
		);

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

/**
 * Click-to-call, from the orchestrator's side of `rpc.engine.v1.originate`.
 *
 * The dial-plan half is `originate-plan.spec.ts` and the wire half is
 * `nats/originate.service.spec.ts`; what is only provable here is the MEDIA request — that the A-leg
 * is created towards the extension, in this engine's Stasis application, carrying the variables the
 * ordinary routing path needs in order to treat it as an ordinary A-leg. That last point is the
 * whole design: everything after the phone is answered is code that already existed.
 */
describe("placing a click-to-call", () => {
	const EXTENSION_ID = "0195c0f0-1c2f-7000-8000-0000000000f1";
	const ORIGINATE_ID = "0195c0f0-1c2f-7000-8000-0000000000a7";

	function clickToCallArtifact(realm?: string): RoutingArtifact {
		const base = artifactWith(
			[...TERMINALS, extensionNode("ext:1001", "1001", EXTENSION_ID)],
			"ext:1001",
		);
		return {
			...base,
			settings: { ...base.settings, ...(realm === undefined ? {} : { realm }) },
			internal: {
				...base.internal,
				numbers: {
					"1002": { number: "1002", kind: "extension", nodeId: "ext:1001" },
				},
			},
			extensionsByNumber: {
				"1001": {
					extensionId: EXTENSION_ID,
					number: "1001",
					tollClass: "national",
					enabled: true,
					nodeId: "ext:1001",
				},
			},
		} as unknown as RoutingArtifact;
	}

	function originateRequest(overrides: Record<string, unknown> = {}) {
		return {
			orgId: ORG,
			originateId: ORIGINATE_ID,
			fromExtension: "1001",
			to: "1002",
			...overrides,
		} as never;
	}

	it("claims a native caller before SIP origination and waits for answer before routing", async () => {
		const transport = new FakeMediadTransport();
		transport.reply("rpc.media.v1.create-offer", {
			ok: true,
			sessionId: ORIGINATE_ID,
			sdpOffer: "v=0\r\n",
		});
		const originated: { legId: string; target: unknown }[] = [];
		const signalling = {
			resolveTarget: async () => ({ ok: true, instanceId: "sipd-test", transport: "udp" }),
			originate: async (request: { legId: string; target: unknown }) => {
				originated.push(request);
				return { ok: true, legId: request.legId, instanceId: "sipd-test" };
			},
		} as unknown as SipdCommandPort;
		const nativeMedia = new SplitPlaneMediaPort(new MediadMediaPort(transport, 500), signalling);
		const h = harness({
			artifact: clickToCallArtifact("tenant.example"),
			nativeMedia,
			env: { ENGINE_MEDIA_DRIVER: "mediad" },
		});
		const placement = await h.originatePath().place(originateRequest());
		expect(placement).toMatchObject({
			kind: "placed",
			legId: ORIGINATE_ID,
			callId: callIdForAriChannel(ORIGINATE_ID),
		});
		expect(originated).toHaveLength(1);
		expect(originated[0]?.target).toEqual({ kind: "aor", aor: "sip:1001@tenant.example" });
		expect(h.orchestrator.activeChannelCount).toBe(1);
		const retry = await h.originatePath().place(originateRequest());
		expect(retry).toMatchObject({ kind: "placed", legId: ORIGINATE_ID });
		expect(originated).toHaveLength(1);
	});

	/**
	 * The dialog identity of a leg this engine ORIGINATED, which nothing on this plane recorded.
	 *
	 * The aggregate is filed BEFORE the INVITE goes out, so the arrival path has no `Call-ID` to
	 * read, and the composite's `getVariable` is a local map with no `CHANNEL(pjsip,call-id)` in it.
	 * So the leg carried no `sip_call_id` onto its CDR row and — the sharper half —
	 * `resolveSipDialog` could not find it, which is what made the engine answer `unknown_dialog` to
	 * a REFER sent by the party who ANSWERED.
	 */
	it("records the dialog the originate reply named, on the leg's first state change", async () => {
		const SIP_CALL_ID = "originated-9f1c2b7ae4@tenant.example";
		const transport = new FakeMediadTransport();
		transport.reply("rpc.media.v1.create-offer", {
			ok: true,
			sessionId: ORIGINATE_ID,
			sdpOffer: "v=0\r\n",
		});
		const signalling = {
			resolveTarget: async () => ({ ok: true, instanceId: "sipd-test", transport: "udp" }),
			originate: async (request: { legId: string }) => ({
				ok: true,
				legId: request.legId,
				instanceId: "sipd-test",
				sipCallId: SIP_CALL_ID,
			}),
		} as unknown as SipdCommandPort;
		const nativeMedia = new SplitPlaneMediaPort(new MediadMediaPort(transport, 500), signalling);
		const h = harness({
			artifact: clickToCallArtifact("tenant.example"),
			nativeMedia,
			env: { ENGINE_MEDIA_DRIVER: "mediad" },
		});

		await h.originatePath().place(originateRequest());
		// The reply landed on the PORT. Nothing has put it on the leg yet.
		expect([...h.kv.values()][0]?.variables.OPTIMIQ_SIP_CALL_ID).toBeUndefined();

		await h.orchestrator.handleEvent({
			type: "call-state-changed",
			channelId: ORIGINATE_ID,
			callState: "ringing",
		});

		expect([...h.kv.values()][0]?.variables.OPTIMIQ_SIP_CALL_ID).toBe(SIP_CALL_ID);
	});

	it("refuses to originate for a tenant that has configured no SIP realm", async () => {
		// No deployment-wide fallback: a realm names exactly one tenant, so borrowing one would dial
		// this extension into somebody else's domain. Refusing by name is the only safe answer.
		const signalling = { originate: async () => ({ ok: true }) } as unknown as SipdCommandPort;
		const nativeMedia = new SplitPlaneMediaPort(
			new MediadMediaPort(new FakeMediadTransport(), 500),
			signalling,
		);
		const h = harness({
			artifact: clickToCallArtifact(),
			nativeMedia,
			env: { ENGINE_MEDIA_DRIVER: "mediad" },
		});

		const placement = await h.originatePath().place(originateRequest());

		expect(placement).toMatchObject({
			kind: "refused",
			reason: "internal",
			error: "the organization has no SIP realm",
		});
		expect(h.orchestrator.activeChannelCount).toBe(0);
	});

	it("rings the extension first, in this engine's Stasis app, as an ordinary A-leg", async () => {
		const h = harness({ artifact: clickToCallArtifact() });

		const placement = await h.originatePath().place(originateRequest());

		expect(placement.kind).toBe("placed");
		const originated = h.media.originated()[0];
		expect(originated?.endpoint).toBe("PJSIP/1001");
		expect(originated?.application).toBe("optimiq-engine");
		// The caller's handle IS the channel id, which is what makes a retry idempotent.
		expect(originated?.channelId).toBe(ORIGINATE_ID);
		// No `OPTIMIQ_LEG`: this leg must be filed as an A-leg and routed, not signalled as a callee.
		expect(originated?.variables?.OPTIMIQ_LEG).toBeUndefined();
		expect(originated?.variables?.OPTIMIQ_ORG_ID).toBe(ORG);
		expect(originated?.variables?.OPTIMIQ_ROUTING_CONTEXT).toBe("internal");
		// The one new surface: an ARI origination has no dialplan, so the number travels as a variable.
		expect(originated?.variables?.OPTIMIQ_DIALED_NUMBER).toBe("1002");
	});

	it("answers with ids derived from the channel, before the phone has rung", async () => {
		const h = harness({ artifact: clickToCallArtifact() });

		const placement = await h.originatePath().place(originateRequest());

		expect(placement.kind === "placed" && placement.callId).toBe(callIdForAriChannel(ORIGINATE_ID));
		expect(placement.kind === "placed" && placement.legId).toBe(legIdForAriChannel(ORIGINATE_ID));
	});

	it("passes the ring timeout through when the caller set one", async () => {
		const h = harness({ artifact: clickToCallArtifact() });

		await h.originatePath().place(originateRequest({ ringTimeoutSeconds: 45 }));

		expect(h.media.originated()[0]?.timeoutSeconds).toBe(45);
	});

	it("refuses `extension_offline` when the media server has no contact to ring", async () => {
		const h = harness({ artifact: clickToCallArtifact(), originateFails: true });

		const placement = await h.originatePath().place(originateRequest());

		expect(placement.kind === "refused" && placement.reason).toBe("extension_offline");
	});

	it("refuses `unknown_extension` for a number this tenant does not have", async () => {
		const h = harness({ artifact: clickToCallArtifact() });

		const placement = await h.originatePath().place(originateRequest({ fromExtension: "9999" }));

		expect(placement.kind === "refused" && placement.reason).toBe("unknown_extension");
		expect(h.media.originated()).toHaveLength(0);
	});

	it("refuses `invalid_target` for a destination the tenant's plan does not reach", async () => {
		const h = harness({ artifact: clickToCallArtifact() });

		const placement = await h.originatePath().place(originateRequest({ to: "+15551230000" }));

		expect(placement.kind === "refused" && placement.reason).toBe("invalid_target");
		expect(h.media.originated()).toHaveLength(0);
	});

	it("refuses `internal` when the tenant has no compiled plan, rather than blaming the extension", async () => {
		const h = harness();

		const placement = await h.originatePath().place(originateRequest());

		expect(placement.kind === "refused" && placement.reason).toBe("internal");
	});

	it("refuses `not_supported` on a media driver that cannot originate", async () => {
		const h = harness({
			artifact: clickToCallArtifact(),
			env: { ENGINE_MEDIA_DRIVER: "mediad" },
		});

		const placement = await h.originatePath().place(originateRequest());

		expect(placement.kind === "refused" && placement.reason).toBe("not_supported");
		expect(h.media.originated()).toHaveLength(0);
	});

	it("is idempotent: a retry of a lost reply does not ring the desk twice", async () => {
		const h = harness({ artifact: clickToCallArtifact() });

		const first = await h.originatePath().place(originateRequest());
		// The channel now exists and has reached the application, exactly as a real one would.
		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", {
				channel: channel({ id: ORIGINATE_ID, dialplan: { context: "", exten: "", priority: 1 } }),
				args: [],
			}),
		);
		const second = await h.originatePath().place(originateRequest());

		expect(second.kind).toBe("placed");
		expect(second.kind === "placed" && second.callId).toBe(
			first.kind === "placed" ? first.callId : "",
		);
		expect(h.media.originated()).toHaveLength(1);
	});
});

/**
 * The two ports the walk gets from THIS class rather than from `RoutingModule` directly.
 *
 * Both are `@Optional()` and last on the constructor, so nothing but a wired deployment fails when
 * they are missing — which is exactly how they went missing for a release while `*65`/`*64` and the
 * shared-line node were finished on the walker side and announced "not available" on every call.
 * These two cases are the wire, asserted at the only place that can see it.
 */
describe("the walker ports the orchestrator owns", () => {
	it("hands `*65` the toggle port, so the code flips the flow instead of announcing", async () => {
		const toggled: unknown[] = [];
		const h = harness({
			artifact: artifactWith(
				[
					...TERMINALS,
					{
						id: "code:*65",
						kind: "feature-code",
						code: "*65",
						action: "call-flow-toggle",
						params: { callFlowId: "cf-1" },
					} as unknown as PlanNode,
				],
				"code:*65",
			),
			toggles: {
				toggle: async (change: unknown) => {
					toggled.push(change);
					return { applied: true, state: "night" };
				},
			} as unknown as ToggleFeatureRpcPort,
		});

		await arrive(h);

		expect(toggled).toHaveLength(1);
		expect(toggled[0]).toMatchObject({
			organizationId: ORG,
			target: "call-flow",
			callFlowId: "cf-1",
		});
	});

	it("hands a shared line the seizure registry, so the appearance that answered takes the line", async () => {
		const seizures: { extensionId: string; appearanceIndex: number }[] = [];
		const h = harness({
			artifact: artifactWith(
				[
					...TERMINALS,
					{
						id: "ext:a",
						kind: "extension",
						extensionId: "0195c0f0-1c2f-7000-8000-0000000000f1",
						number: "1001",
						tollClass: "internal",
						recordPolicy: "none",
						timeoutSeconds: 20,
						doNotDisturb: false,
					} as PlanNode,
					{
						id: "sl:1",
						kind: "shared-line",
						sharedLineId: "0195c0f0-1c2f-7000-8000-0000000000e1",
						strategy: "simultaneous",
						ringTimeoutSeconds: 20,
						holdRecallTimeoutSeconds: 60,
						bargeInEnabled: false,
						appearances: [
							{
								appearanceIndex: 1,
								extensionId: "0195c0f0-1c2f-7000-8000-0000000000f1",
								extensionNumber: "1001",
								targetNodeId: "ext:a",
							},
						],
						timeoutNodeId: "hangup:NORMAL_CLEARING",
					} as unknown as PlanNode,
				],
				"sl:1",
			),
			sharedLines: {
				held: () => undefined,
				seize: async (
					_orgId: string,
					_lineId: string,
					seizing: { extensionId: string; appearanceIndex: number },
				) => {
					seizures.push({
						extensionId: seizing.extensionId,
						appearanceIndex: seizing.appearanceIndex,
					});
					return { won: true, revision: 1 };
				},
				releaseOwn: async () => true,
			} as unknown as SharedLineRegistry,
		});

		await arrive(h);

		expect(seizures).toEqual([
			{ extensionId: "0195c0f0-1c2f-7000-8000-0000000000f1", appearanceIndex: 1 },
		]);
	});
});

/**
 * CLIR on the path every softphone and desk phone takes.
 *
 * `resolve.ts` sets `ResolvedRoute.callerIdPresentation` from the caller's extension, `plan-walker`
 * consumes `WalkInput.callerIdPresentation` and `trunkDialNode` puts it on the attempt — and the
 * `walk({…})` in `startRoutedProgram` did not pass it, so every layer of the feature was live and
 * invisible. Only the click-to-call path carried it.
 */
describe("caller-id presentation on the ordinary routing walk", () => {
	const CALLER = "0195c0f0-1c2f-7000-8000-0000000000f7";

	function clirArtifact(presentation?: "allowed" | "restricted"): RoutingArtifact {
		const base = artifactWith([...TERMINALS], "hangup:NORMAL_CLEARING");
		return {
			...base,
			outbound: {
				...base.outbound,
				rules: [
					{
						id: "0195c0f0-1c2f-7000-8000-0000000000b1",
						name: "everything",
						priority: 100,
						enabled: true,
						patterns: [{ kind: "regex", value: "^\\+?[0-9]{6,15}$" }],
						tollClass: "national",
						destinationNodeId: "trunk:pstn",
					},
				],
			},
			nodes: {
				...base.nodes,
				"trunk:pstn": {
					id: "trunk:pstn",
					kind: "trunk-dial",
					outboundRouteId: "0195c0f0-1c2f-7000-8000-0000000000b1",
					tollClass: "national",
					continueOnCauses: [],
					recordEnabled: false,
					attempts: [
						{
							trunkId: "0195c0f0-1c2f-7000-8000-0000000000e1",
							name: "carrier",
							kind: "register",
							sipDomain: "carrier.example",
							sipProxy: "carrier.example",
							transport: "udp",
							order: 1,
						},
					],
				},
			},
			extensionsByNumber: {
				"1001": {
					extensionId: CALLER,
					number: "1001",
					tollClass: "national",
					enabled: true,
					nodeId: "hangup:NORMAL_CLEARING",
					outboundCallerIdNumber: "+15005550999",
					...(presentation === undefined ? {} : { outboundCallerIdPresentation: presentation }),
				},
			},
		} as unknown as RoutingArtifact;
	}

	async function dialOut(presentation?: "allowed" | "restricted") {
		const h = harness({ artifact: clirArtifact(presentation) });
		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", {
				channel: channel({
					caller: { name: "Alice", number: "1001" },
					dialplan: { context: "optimiq-outbound", exten: "+15551230001", priority: 1 },
					channelvars: { OPTIMIQ_ROUTING_CONTEXT: "outbound", OPTIMIQ_ORG_ID: ORG },
				}),
				args: [],
			}),
		);
		await h.orchestrator.awaitWalks();
		return h;
	}

	it("carries a restricted extension's setting onto the trunk attempt", async () => {
		const h = await dialOut("restricted");
		expect(h.media.originated()[0]?.callerIdPresentation).toBe("restricted");
	});

	/**
	 * The same identity on the RE-ENTRANT dial — `*67<number>`, `*82<number>`, `*69`.
	 *
	 * Those arrive at `routeLeg` with no caller id on the request, and it passed none to the walk. So
	 * the trunk INVITE asserted the EDGE's own identity instead of the caller's `+15005550999` — and
	 * under `Privacy: id` that is the harmful direction, because the network is told to withhold an
	 * identity that was never asserted.
	 */
	it("carries the resolved identity onto a re-entrant dial that supplies none", async () => {
		const h = harness({ artifact: clirArtifact("restricted") });
		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", {
				channel: channel({
					caller: { name: "Alice", number: "1001" },
					dialplan: { context: "optimiq-internal", exten: "1001", priority: 1 },
					channelvars: { OPTIMIQ_ROUTING_CONTEXT: "internal", OPTIMIQ_ORG_ID: ORG },
				}),
				args: [],
			}),
		);
		await h.orchestrator.awaitWalks();
		h.media.originated().length = 0;

		const leg = (
			h.orchestrator as unknown as {
				controlledLegFor(mediaChannelId: string): unknown;
			}
		).controlledLegFor(ARI_CHANNEL);
		await (
			h.orchestrator as unknown as {
				routeLeg(leg: unknown, request: unknown): Promise<unknown>;
			}
		).routeLeg(leg, { destination: "+15551230001", context: "outbound" });

		const originated = h.media.originated()[0];
		expect(originated?.callerId).toContain("+15005550999");
		expect(originated?.callerIdPresentation).toBe("restricted");
	});

	it("carries nothing at all for an extension that presents its number", async () => {
		const h = await dialOut();
		expect(h.media.originated()[0]).not.toHaveProperty("callerIdPresentation");
	});
});

/**
 * Virtual hold's outbound leg, at the layer that actually creates a channel.
 *
 * `planQueueCallback` is specced against the artifact in `originate-plan.spec.ts`; what is under
 * test here is the half only this class can do — the variables the leg carries, which decide how it
 * is routed once the customer answers, how it is billed, and which wait it settles.
 */
describe("the queue-callback call path", () => {
	const CALLBACK_ID = "0195c0f0-1c2f-7000-8000-0000000000c9";
	const QUEUE_ID = "0195c0f0-1c2f-7000-8000-0000000000q1".replace("q", "a");
	const ORIGINAL_CALL_ID = "0195c0f0-1c2f-7000-8000-0000000000d9";

	function callbackArtifact(): RoutingArtifact {
		const base = artifactWith([...TERMINALS], "hangup:NORMAL_CLEARING");
		return {
			...base,
			outbound: {
				...base.outbound,
				rules: [
					{
						// `id` and `destinationNodeId` are the field names `resolveOutbound` reads. A rule
						// spelled `routeId`/`nodeId` still MATCHES and resolves to no plan, which is how the
						// callback path came to be handed a route with no trunk on it.
						id: "0195c0f0-1c2f-7000-8000-0000000000b1",
						name: "everything",
						priority: 100,
						enabled: true,
						patterns: [{ kind: "regex", value: "^\\+?[0-9]{6,15}$" }],
						tollClass: "national",
						destinationNodeId: "trunk:pstn",
					},
				],
			},
			nodes: {
				...base.nodes,
				"trunk:pstn": {
					id: "trunk:pstn",
					kind: "trunk-dial",
					outboundRouteId: "0195c0f0-1c2f-7000-8000-0000000000b1",
					tollClass: "national",
					continueOnCauses: [],
					recordEnabled: false,
					attempts: [
						{
							trunkId: "0195c0f0-1c2f-7000-8000-0000000000e1",
							name: "carrier",
							kind: "register",
							sipDomain: "carrier.example",
							sipProxy: "carrier.example",
							transport: "udp",
							order: 1,
						},
					],
				},
			},
			extensionsByNumber: {
				"4010": {
					extensionId: "0195c0f0-1c2f-7000-8000-0000000000f1",
					number: "4010",
					tollClass: "national",
					enabled: true,
					nodeId: "hangup:NORMAL_CLEARING",
				},
			},
		} as unknown as RoutingArtifact;
	}

	function callbackRequest(overrides: Record<string, unknown> = {}) {
		return {
			orgId: ORG,
			callbackId: CALLBACK_ID,
			queueId: QUEUE_ID,
			to: "+15551234567",
			queueNumber: "4010",
			relatedCallId: ORIGINAL_CALL_ID,
			...overrides,
		} as never;
	}

	it("dials the customer out and walks the answered leg back to the queue", async () => {
		const h = harness({ artifact: callbackArtifact() });

		const placement = await h.originatePath().placeQueueCallback?.(callbackRequest());

		expect(placement?.kind).toBe("placed");
		const originated = h.media.originated()[0];
		expect(originated?.endpoint).toContain("carrier");
		expect(originated?.endpoint).toContain("+15551234567");
		// `outbound`, not `internal`: this leg goes to a customer over a trunk and is billed as one.
		expect(originated?.variables?.OPTIMIQ_CALL_DIRECTION).toBe("outbound");
		// The QUEUE's number, so the ordinary walk takes the answered customer into the ordinary
		// queue node and the ordinary distribution loop reaches the ordinary agent.
		expect(originated?.variables?.OPTIMIQ_DIALED_NUMBER).toBe("4010");
		// A NEW call id, linked to the wait it settles rather than reusing it.
		expect(originated?.variables?.OPTIMIQ_CDR_RELATED_CALL_ID).toBe(ORIGINAL_CALL_ID);
	});

	/**
	 * The party who waited in a queue is as often an EXTENSION as a customer on a trunk. The
	 * outbound-only resolve matched nothing for `1002`, so the runner refused `invalid_target` every
	 * thirty seconds after the caller had been told their place was held.
	 */
	it("dials an internal caller back on net, and bills it as an internal call", async () => {
		const base = callbackArtifact();
		const artifact = {
			...base,
			settings: { ...base.settings, realm: "tenant.example" },
			internal: {
				...base.internal,
				numbers: { ...base.internal.numbers, "1002": "hangup:NORMAL_CLEARING" },
			},
		} as unknown as RoutingArtifact;
		const h = harness({ artifact });

		const placement = await h.originatePath().placeQueueCallback?.(callbackRequest({ to: "1002" }));

		expect(placement?.kind).toBe("placed");
		const originated = h.media.originated()[0];
		expect(originated?.endpoint).toContain("1002");
		expect(originated?.target).toEqual({ kind: "aor", aor: "sip:1002@tenant.example" });
		// `internal`, not `outbound`: billing an on-net callback as a carrier minute is a refund.
		expect(originated?.variables?.OPTIMIQ_CALL_DIRECTION).toBe("internal");
		expect(originated?.variables?.OPTIMIQ_DIALED_NUMBER).toBe("4010");
	});

	it("is idempotent: a retry of a lost reply does not ring the customer twice", async () => {
		const h = harness({ artifact: callbackArtifact() });

		const first = await h.originatePath().placeQueueCallback?.(callbackRequest());
		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", {
				channel: channel({ id: CALLBACK_ID, dialplan: { context: "", exten: "", priority: 1 } }),
				args: [],
			}),
		);
		const second = await h.originatePath().placeQueueCallback?.(callbackRequest());

		expect(second?.kind).toBe("placed");
		expect(second?.kind === "placed" && second.callId).toBe(
			first?.kind === "placed" ? first.callId : "",
		);
		expect(h.media.originated()).toHaveLength(1);
	});

	it("refuses a customer number the tenant's outbound plan does not match", async () => {
		const h = harness({ artifact: artifactWith([...TERMINALS], "hangup:NORMAL_CLEARING") });

		const placement = await h
			.originatePath()
			.placeQueueCallback?.(callbackRequest({ to: "+15551234567" }));

		expect(placement?.kind).toBe("refused");
		expect(placement?.kind === "refused" && placement.reason).toBe("invalid_target");
		expect(h.media.originated()).toHaveLength(0);
	});
});
