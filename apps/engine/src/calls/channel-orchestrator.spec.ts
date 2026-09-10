import { beforeEach, describe, expect, it } from "bun:test";
import { RPC_SUBJECTS } from "@optimiq-voice/events";
import { parseAriEvent } from "@optimiq-voice/media-ari";
import { makeFakeMediaPort } from "../media/media-port.fake";
import { MediadMediaPort } from "../media/mediad-media.port";
import { FakeMediadTransport } from "../media/mediad-transport.fake";
import { SplitPlaneMediaPort } from "../media/split-plane.port";
import {
	CHANNEL_OWNER_EXPIRES_AT_VARIABLE,
	CHANNEL_OWNERSHIP_LEASE_MS,
	channelOwnershipOf,
	withChannelOwnership,
} from "../nats/channel-ownership";
import { fakeQueueOrchestratorArgs } from "../queue/queue-services.fake";
import { CallSignalBus, legSignalKey } from "../routing/call-signals";
import { ConferenceRegistry } from "../routing/conference-registry";
import { ParkRegistry } from "../routing/park-registry";
import { DtmfRegistry } from "../verbs/dtmf-registry";
import { makeVerbExecutorRuntime } from "../verbs/verb-executor";
import { toMediaEvent } from "./ari-mapping";
import { CallControlRegistry } from "./call-control-registry";
import { ChannelAggregate } from "./channel-aggregate";
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
import type { SupervisorAuthzRpcPort } from "../routing/supervisor-authz.source";
import type { VoicemailGreetingRpcPort } from "../routing/voicemail-greeting.source";
import type { VoicemailMailboxRpcSource } from "../routing/voicemail-mailbox.source";
import type {
	CallEventOf,
	CdrLegWriteEnvelope,
	SipInviteRequest,
	SipTransferRequest,
} from "@optimiq-voice/events";
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
	readonly id?: string;
	readonly data: Record<string, unknown>;
}

function fakeEnv(overrides: Partial<EngineEnv> = {}): EngineEnv {
	return {
		NODE_ENV: "test",
		ENGINE_PORT: 4010,
		ENGINE_HOST: "127.0.0.1",
		ENGINE_INSTANCE_ID: "engine-test",
		ENGINE_MEDIA_DRIVER: "ari",
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
		ENGINE_PROGRESS_TIMEOUT_SECONDS: 0,
		// Off unless a case arms it: every other spec in this file would otherwise leave a live
		// timer behind for four hours of test-runner wall clock.
		ENGINE_MAX_CALL_DURATION_SECONDS: 0,
		// Off unless a case arms it, for the same reason as the ceiling above.
		ENGINE_SETUP_TIMEOUT_SECONDS: 0,
		ENGINE_PROMPT_MEDIA_PREFIX: "sound:",
		ENGINE_UNAVAILABLE_ANNOUNCEMENT: "sound:unavailable",
		ENGINE_VOICEMAIL_GREETING: "sound:unavailable",
		ENGINE_RECORDING_FORMAT: "wav",
		...overrides,
	} as EngineEnv;
}

interface HarnessOptions {
	readonly nativeMedia?: SplitPlaneMediaPort;
	readonly snapshots?: readonly ChannelSnapshot[];
	readonly cdrFailures?: number;
	readonly persistFailures?: number;
	readonly channelKv?: Map<string, ChannelSnapshot>;
	readonly claimResult?: "claimed" | "owned" | "unavailable";
	readonly renewResult?: "renewed" | "lost" | "unavailable";
	readonly beforeEventPublish?: (type: string) => Promise<void>;
	/** A did-index that answers, for the one path where attribution is not stamped on the leg. */
	readonly didIndex?: DidIndexSource;
	/**
	 * The leg ids the SIP edge still has a dialog for. Absent means the edge cannot be asked at all,
	 * which is what every spec that is not about reconciliation wants.
	 */
	readonly sipDialogs?: ReadonlySet<string>;
}

function harness(env: EngineEnv = fakeEnv(), options: HarnessOptions = {}) {
	const media = makeFakeMediaPort({ variables: { OPTIMIQ_ORG_ID: ORG } });
	const mediaCalls = media.calls;
	const variables = media.variables;

	const published: PublishedEvent[] = [];
	const events = {
		publish: async (
			type: string,
			input: { orgId: string; callId: string; id?: string; data: Record<string, unknown> },
		) => {
			await options.beforeEventPublish?.(type);
			published.push({
				type,
				orgId: input.orgId,
				callId: input.callId,
				id: input.id,
				data: input.data,
			});
			return {} as CallEventOf<"channel.created">;
		},
	} as unknown as CallEventPublisher;

	const kv = options.channelKv ?? new Map<string, ChannelSnapshot>();
	for (const snapshot of options.snapshots ?? []) {
		kv.set(`${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`, snapshot);
	}
	const cdrs: CdrLegWriteEnvelope[] = [];
	const cdrAttempts: CdrLegWriteEnvelope[] = [];
	const persistAttempts: ChannelSnapshot[] = [];
	let cdrFailures = options.cdrFailures ?? 0;
	let persistFailures = options.persistFailures ?? 0;
	const jetstream = {
		putChannel: async (snapshot: ChannelSnapshot, now = Date.now()) => {
			kv.set(
				`${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`,
				withChannelOwnership(snapshot, env.ENGINE_INSTANCE_ID, now + CHANNEL_OWNERSHIP_LEASE_MS),
			);
		},
		persistChannel: async (snapshot: ChannelSnapshot, now = Date.now()) => {
			persistAttempts.push(snapshot);
			if (persistFailures > 0) {
				persistFailures -= 1;
				return false;
			}
			kv.set(
				`${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`,
				withChannelOwnership(snapshot, env.ENGINE_INSTANCE_ID, now + CHANNEL_OWNERSHIP_LEASE_MS),
			);
			return true;
		},
		deleteChannel: async (snapshot: ChannelSnapshot) => {
			kv.delete(`${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`);
		},
		claimChannel: async (snapshot: ChannelSnapshot, now = Date.now()) => {
			if (options.claimResult !== undefined) {
				return options.claimResult;
			}
			const key = `${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`;
			if (kv.has(key)) {
				return "owned";
			}
			kv.set(
				key,
				withChannelOwnership(snapshot, env.ENGINE_INSTANCE_ID, now + CHANNEL_OWNERSHIP_LEASE_MS),
			);
			return "claimed";
		},
		adoptChannel: async (snapshot: ChannelSnapshot, now = Date.now()) => {
			const key = `${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`;
			const current = kv.get(key);
			if (current === undefined) {
				return "owned";
			}
			const ownership = channelOwnershipOf(current);
			if (
				ownership !== undefined &&
				ownership.instanceId !== env.ENGINE_INSTANCE_ID &&
				ownership.expiresAt > now
			) {
				return "owned";
			}
			kv.set(
				key,
				withChannelOwnership(current, env.ENGINE_INSTANCE_ID, now + CHANNEL_OWNERSHIP_LEASE_MS),
			);
			return "claimed";
		},
		adoptChannelFromInstance: async (
			snapshot: ChannelSnapshot,
			deadInstanceId: string,
			now = Date.now(),
		) => {
			const key = `${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`;
			const current = kv.get(key);
			if (current === undefined) {
				return "vanished";
			}
			// The whole point of this path: the channel lease is IGNORED, and the only fence is that
			// the snapshot still names the instance the caller proved dead.
			if (channelOwnershipOf(current)?.instanceId !== deadInstanceId) {
				return "owned";
			}
			kv.set(
				key,
				withChannelOwnership(current, env.ENGINE_INSTANCE_ID, now + CHANNEL_OWNERSHIP_LEASE_MS),
			);
			return "claimed";
		},
		renewChannel: async (snapshot: ChannelSnapshot, now = Date.now()) => {
			if (options.renewResult !== undefined) {
				if (options.renewResult === "lost") {
					const key = `${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`;
					kv.set(
						key,
						withChannelOwnership(snapshot, "engine-other", now + CHANNEL_OWNERSHIP_LEASE_MS),
					);
				}
				return options.renewResult;
			}
			const key = `${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`;
			kv.set(
				key,
				withChannelOwnership(snapshot, env.ENGINE_INSTANCE_ID, now + CHANNEL_OWNERSHIP_LEASE_MS),
			);
			return "renewed";
		},
		readChannel: async (organizationId: string, callId: string, channelId: string) =>
			kv.get(`${organizationId}.${callId}.${channelId}`),
		ownedChannelLeaseExpiresAt: (snapshot: ChannelSnapshot) =>
			channelOwnershipOf(
				kv.get(`${snapshot.organizationId}.${snapshot.callId}.${snapshot.channelId}`) ?? snapshot,
			)?.expiresAt,
		releaseChannelOwnership: async () => undefined,
		// The SIP edge's own dialog record. `undefined` — the "could not ask" answer — unless a case
		// sets `sipDialogs`, so no existing spec's adopted leg is reconciled out from under it.
		sipDialogExists: async (legId: string) =>
			options.sipDialogs === undefined ? undefined : options.sipDialogs.has(legId),
		channelSnapshots: async function* () {
			for (const snapshot of kv.values()) {
				yield snapshot;
			}
		},
		publishCdrLeg: async (envelope: CdrLegWriteEnvelope) => {
			cdrAttempts.push(envelope);
			if (cdrFailures > 0) {
				cdrFailures -= 1;
				throw new Error("CDR stream unavailable");
			}
			cdrs.push(envelope);
		},
	} as unknown as JetStreamService;

	const dtmf = new DtmfRegistry();
	const runtime = makeVerbExecutorRuntime({
		media: options.nativeMedia ?? media,
		collectDtmf: (context, verb) => dtmf.forChannel(context.channelId).collect(verb),
	});

	const signals = new CallSignalBus();
	const routing = {
		get: async () => undefined,
	} as unknown as RoutingArtifactSource;

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
		NO_MAILBOX,
		NO_FEATURES,
		NO_LAST_CALLER,
		NO_GREETINGS,
		NO_SUPERVISION,
		options.didIndex ?? NO_DID_INDEX,
		signals,
		new ConferenceRegistry(),
		...(fakeQueueOrchestratorArgs() as [never, never, never, never, never]),
		new ParkRegistry(),
		new CallControlRegistry(),
		NO_PARK_HANDOFF,
		sipTransfer.service,
		originate.service,
		sipInvite.service,
	);

	return {
		orchestrator,
		mediaCalls,
		published,
		kv,
		cdrs,
		cdrAttempts,
		persistAttempts,
		variables,
		dtmf,
		mediaPort: media,
		jetstream,
		signals,
		routing,
		sipCallPath: sipTransfer.attached,
		sipInviteCallPath: sipInvite.attached,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (!predicate()) {
		throw new Error(`condition was not met within ${String(timeoutMs)}ms`);
	}
}

/**
 * Files a walker-dialled B-leg in the orchestrator's registry, exactly as `legHooksFor` does.
 *
 * Reaches for the private registry rather than driving a whole routing walk, because what is under
 * test is one variable's round trip and a walk would put a plan compiler between the assertion and
 * the thing asserted.
 */
function registerBLeg(
	orchestrator: ChannelOrchestrator,
	mediaChannelId: string,
	originatingLegId: string,
): void {
	const aggregate = ChannelAggregate.create({
		ariChannelId: mediaChannelId,
		channelId: legIdForAriChannel(mediaChannelId),
		callId: callIdForAriChannel(SIPD_LEG),
		organizationId: ORG,
		direction: "internal",
		leg: "b",
		profile: { context: "internal", destinationNumber: "1002" },
		variables: { OPTIMIQ_LEG: "b", OPTIMIQ_ORIGINATING_LEG_ID: originatingLegId },
		createdAt: Date.now(),
	});
	(orchestrator as unknown as { registry: { add(entry: ChannelAggregate): void } }).registry.add(
		aggregate,
	);
}

function pendingCdrRetryCount(orchestrator: ChannelOrchestrator): number {
	return (
		orchestrator as unknown as {
			cdrRetryTimers: ReadonlyMap<string, unknown>;
		}
	).cdrRetryTimers.size;
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
		expect([...h.kv.values()][0]?.variables).toMatchObject({
			OPTIMIQ_ENGINE_INSTANCE_ID: "engine-test",
		});
		expect(
			Number([...h.kv.values()][0]?.variables[CHANNEL_OWNER_EXPIRES_AT_VARIABLE]),
		).toBeGreaterThan(Date.now());
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

	it("admits a mediad leg on exactly one replica and keeps its later events on that owner", async () => {
		const channelKv = new Map<string, ChannelSnapshot>();
		const first = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-a" }),
			{ channelKv },
		);
		const second = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-b" }),
			{ channelKv },
		);
		const replicas = [first, second] as const;
		const arrival: MediaEvent = {
			type: "leg-arrived",
			channel: {
				id: ARI_CHANNEL,
				name: "PJSIP/trunk-00000001",
				callerName: "Ada",
				callerNumber: "+15551234567",
				dialedNumber: "+15559876543",
				context: "local-ctx",
				variables: { OPTIMIQ_ORG_ID: ORG },
			},
		};

		// Both replicas receive the same arrival. KV create is the admission point that can lose.
		await Promise.all(
			replicas.map(async (replica) => await replica.orchestrator.handleEvent(arrival)),
		);

		expect(
			replicas.reduce((sum, replica) => sum + replica.orchestrator.activeChannelCount, 0),
		).toBe(1);
		expect(replicas.flatMap((replica) => replica.published)).toHaveLength(1);
		const owner = replicas.find((replica) => replica.orchestrator.activeChannelCount === 1);
		const nonOwner = replicas.find((replica) => replica !== owner);
		if (owner === undefined || nonOwner === undefined) {
			throw new Error("the mediad admission race did not produce one owner and one loser");
		}
		expect(nonOwner.mediaCalls).toEqual([]);
		expect([...channelKv.values()][0]?.variables.OPTIMIQ_ENGINE_INSTANCE_ID).toBe(
			owner === first ? "engine-a" : "engine-b",
		);

		owner.published.length = 0;
		nonOwner.published.length = 0;
		// The feed remains broadcast, not queue-grouped. Both receive each event; only the owner has
		// registry and signal state capable of acting on this channel's lifecycle.
		const digit: MediaEvent = {
			type: "dtmf-received",
			channelId: ARI_CHANNEL,
			digit: "7",
			durationMs: 120,
		};
		await Promise.all(
			replicas.map(async (replica) => await replica.orchestrator.handleEvent(digit)),
		);
		expect(replicas.flatMap((replica) => replica.published).map((event) => event.type)).toEqual([
			"channel.dtmf",
		]);

		const ended: MediaEvent = {
			type: "leg-ended",
			channelId: ARI_CHANNEL,
			cause: "NORMAL_CLEARING",
			causeCode: 16,
		};
		await Promise.all(
			replicas.map(async (replica) => await replica.orchestrator.handleEvent(ended)),
		);
		expect(replicas.flatMap((replica) => replica.cdrs)).toHaveLength(1);
		expect(channelKv.size).toBe(0);
		expect(owner.orchestrator.activeChannelCount).toBe(0);
	});

	it("admits an ARI leg on exactly one replica", async () => {
		const channelKv = new Map<string, ChannelSnapshot>();
		const replicas = [
			harness(fakeEnv({ ENGINE_INSTANCE_ID: "engine-a" }), { channelKv }),
			harness(fakeEnv({ ENGINE_INSTANCE_ID: "engine-b" }), { channelKv }),
		] as const;
		const arrival = mediaEvent("StasisStart", { channel: channel(), args: [] });

		await Promise.all(
			replicas.map(async (replica) => await replica.orchestrator.handleEvent(arrival)),
		);

		expect(
			replicas.reduce((sum, replica) => sum + replica.orchestrator.activeChannelCount, 0),
		).toBe(1);
		expect(replicas.flatMap((replica) => replica.published)).toHaveLength(1);
		expect([...channelKv.values()][0]?.variables.OPTIMIQ_ENGINE_INSTANCE_ID).toMatch(
			/^engine-[ab]$/,
		);
	});

	it("fails mediad admission closed when ownership cannot be established", async () => {
		const h = harness(fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad" }), {
			claimResult: "unavailable",
		});

		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));

		expect(h.orchestrator.activeChannelCount).toBe(0);
		expect(h.published).toEqual([]);
		// It must not hang up a leg another replica may already own.
		expect(h.mediaCalls).toEqual([]);
	});

	it("adopts and hydrates a mediad snapshot after its previous owner's lease expires", async () => {
		const channelKv = new Map<string, ChannelSnapshot>();
		const original = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-a" }),
			{ channelKv },
		);
		await original.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(), args: [] }),
		);
		const [stored] = channelKv.values();
		if (stored === undefined) {
			throw new Error("the original owner did not mirror its channel");
		}
		channelKv.set(`${stored.organizationId}.${stored.callId}.${stored.channelId}`, {
			...stored,
			variables: {
				...stored.variables,
				[CHANNEL_OWNER_EXPIRES_AT_VARIABLE]: "1000",
			},
		});

		const replacement = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-b" }),
			{ channelKv },
		);
		expect(await replacement.orchestrator.hydrateChannels(1_000)).toBe(1);
		expect(replacement.orchestrator.activeChannelCount).toBe(1);
		expect([...channelKv.values()][0]?.variables.OPTIMIQ_ENGINE_INSTANCE_ID).toBe("engine-b");

		const internals = replacement.orchestrator as unknown as {
			ownershipMaintenanceTimer?: ReturnType<typeof setInterval>;
		};
		expect(internals.ownershipMaintenanceTimer).toBeDefined();
		await replacement.orchestrator.onApplicationShutdown();
		expect(internals.ownershipMaintenanceTimer).toBeUndefined();
	});

	/**
	 * The finding this whole path exists for, as a test.
	 *
	 * A second engine was SIGKILLed mid-call on the live stack. The call survived — `mediad` relays
	 * and `sipd` holds the dialog — but the survivor adopted NOTHING for the forty seconds observed,
	 * because the dead instance's channel lease was still unexpired: it is ninety seconds wide, since
	 * a heartbeat renews every live channel on the replica. No CDR was ever written for that call.
	 *
	 * Here the lease is deliberately left VALID and adoption is driven by the instance lease instead.
	 * Reverting `adoptChannelsOfInstance` to the expiry-fenced `adoptChannel` makes this fail with
	 * `adopted 0`, which is the live behaviour exactly.
	 */
	/**
	 * The residue the adoption work left behind, as a test.
	 *
	 * Two WSS legs were admitted five seconds AFTER a SIGKILL and rejected by `sipd` at admission.
	 * The survivor adopted them correctly — and then held them in `activeChannels` for the four-hour
	 * ceiling, because nothing distinguishes a call still ringing from a call the edge already threw
	 * away. `sip-dialogs` is the party that knows.
	 */
	it("ends an adopted leg the sip edge has no dialog for", async () => {
		const channelKv = new Map<string, ChannelSnapshot>();
		const dead = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-dead" }),
			{ channelKv },
		);
		await dead.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(), args: [] }),
		);

		// The edge has no dialog for this leg at all: nothing on the platform would ever end it.
		const survivor = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-live" }),
			{ channelKv, sipDialogs: new Set<string>() },
		);
		expect(await survivor.orchestrator.adoptChannelsOfInstance("engine-dead")).toBe(1);

		await survivor.orchestrator.maintainChannelOwnership();

		expect(survivor.mediaPort.hungUp()).toEqual([
			{ channelId: ARI_CHANNEL, cause: "NO_USER_RESPONSE" },
		]);
		// And the leg is actually GONE, not merely told to go: the edge has no dialog, so no
		// `dialog.terminated` will ever arrive to finish the teardown. See `endStalledLeg`.
		expect(survivor.orchestrator.activeChannelCount).toBe(0);
		expect(survivor.cdrs[0]?.data).toMatchObject({ hangupCause: "NO_USER_RESPONSE" });
	});

	it("leaves an adopted leg alone while the sip edge still holds its dialog", async () => {
		const channelKv = new Map<string, ChannelSnapshot>();
		const dead = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-dead" }),
			{ channelKv },
		);
		await dead.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(), args: [] }),
		);

		const survivor = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-live" }),
			{ channelKv, sipDialogs: new Set([ARI_CHANNEL]) },
		);
		expect(await survivor.orchestrator.adoptChannelsOfInstance("engine-dead")).toBe(1);

		await survivor.orchestrator.maintainChannelOwnership();

		expect(survivor.mediaPort.hungUp()).toEqual([]);
		expect(survivor.orchestrator.activeChannelCount).toBe(1);
	});

	/**
	 * A read that FAILED is not evidence the dialog is gone. Treating it as one would hang up every
	 * live pre-answer call on the platform the moment the broker hiccuped — which is why the fake's
	 * default (`sipDialogs` absent) answers `undefined` and why every other spec here is unaffected.
	 */
	it("leaves an adopted leg alone when the edge cannot be asked at all", async () => {
		const channelKv = new Map<string, ChannelSnapshot>();
		const dead = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-dead" }),
			{ channelKv },
		);
		await dead.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(), args: [] }),
		);

		const survivor = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-live" }),
			{ channelKv },
		);
		expect(await survivor.orchestrator.adoptChannelsOfInstance("engine-dead")).toBe(1);

		await survivor.orchestrator.maintainChannelOwnership();

		expect(survivor.mediaPort.hungUp()).toEqual([]);
		expect(survivor.orchestrator.activeChannelCount).toBe(1);
	});

	it("adopts a dead replica's channel while its ownership lease is still valid", async () => {
		const channelKv = new Map<string, ChannelSnapshot>();
		const dead = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-dead" }),
			{ channelKv },
		);
		await dead.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(), args: [] }),
		);
		const [stored] = channelKv.values();
		if (stored === undefined) {
			throw new Error("the dead replica did not mirror its channel");
		}
		const ownership = channelOwnershipOf(stored);
		expect(ownership?.instanceId).toBe("engine-dead");
		expect(ownership?.expiresAt).toBeGreaterThan(Date.now());

		const survivor = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-live" }),
			{ channelKv },
		);
		// The expiry-fenced pass, which is what ran before: it correctly refuses a live lease.
		expect(await survivor.orchestrator.hydrateChannels()).toBe(0);

		expect(await survivor.orchestrator.adoptChannelsOfInstance("engine-dead")).toBe(1);
		expect(survivor.orchestrator.activeChannelCount).toBe(1);
		expect(survivor.orchestrator.adoptedChannelCount).toBe(1);
		expect([...channelKv.values()][0]?.variables.OPTIMIQ_ENGINE_INSTANCE_ID).toBe("engine-live");

		await dead.orchestrator.onApplicationShutdown();
		await survivor.orchestrator.onApplicationShutdown();
	});

	/**
	 * Exactly one survivor wins each channel. The fake's `adoptChannelFromInstance` refuses any
	 * snapshot that no longer names the dead instance, which is the revision-CAS's outcome: the loser
	 * re-reads a key the winner has already rewritten.
	 */
	it("gives a dead replica's channel to exactly one survivor", async () => {
		const channelKv = new Map<string, ChannelSnapshot>();
		const dead = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-dead" }),
			{ channelKv },
		);
		await dead.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(), args: [] }),
		);

		const survivors = [
			harness(fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-a" }), {
				channelKv,
			}),
			harness(fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-b" }), {
				channelKv,
			}),
		] as const;
		const adopted = await Promise.all(
			survivors.map(async (s) => await s.orchestrator.adoptChannelsOfInstance("engine-dead")),
		);

		expect(adopted[0] + adopted[1]).toBe(1);
		expect(survivors.reduce((sum, s) => sum + s.orchestrator.activeChannelCount, 0)).toBe(1);
		await dead.orchestrator.onApplicationShutdown();
		await Promise.all(survivors.map(async (s) => await s.orchestrator.onApplicationShutdown()));
	});

	/**
	 * A peer's death is not a licence to take a THIRD party's calls. The contest names one instance,
	 * and every snapshot owned by anybody else — including a replacement that has already adopted it
	 * — is left alone.
	 */
	it("leaves a third replica's channels alone while contesting a dead one's", async () => {
		const channelKv = new Map<string, ChannelSnapshot>();
		const other = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-other" }),
			{ channelKv },
		);
		await other.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(), args: [] }),
		);

		const survivor = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-live" }),
			{ channelKv },
		);
		expect(await survivor.orchestrator.adoptChannelsOfInstance("engine-dead")).toBe(0);
		expect(survivor.orchestrator.activeChannelCount).toBe(0);
		expect([...channelKv.values()][0]?.variables.OPTIMIQ_ENGINE_INSTANCE_ID).toBe("engine-other");

		await other.orchestrator.onApplicationShutdown();
		await survivor.orchestrator.onApplicationShutdown();
	});

	/**
	 * Our own id, reported lost, is a renewal this process failed to WRITE — not a death. Every
	 * channel named there is one this instance is actively serving, and contesting them would mean an
	 * engine tearing down and re-installing its own live calls off a broker hiccup.
	 */
	it("refuses to contest its own instance id", async () => {
		const h = harness(fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-a" }));
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));

		expect(await h.orchestrator.adoptChannelsOfInstance("engine-a")).toBe(0);
		expect(h.orchestrator.activeChannelCount).toBe(1);
		await h.orchestrator.onApplicationShutdown();
	});

	/**
	 * A draining instance is leaving. Anything it adopted now would go straight to the drain's
	 * straggler teardown, which ends a live call the next survivor could have kept.
	 */
	it("does not contest a dead replica's channels while draining", async () => {
		const channelKv = new Map<string, ChannelSnapshot>();
		const dead = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-dead" }),
			{ channelKv },
		);
		await dead.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(), args: [] }),
		);

		const survivor = harness(
			fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "engine-live" }),
			{ channelKv },
		);
		await survivor.orchestrator.drain(0);
		expect(await survivor.orchestrator.adoptChannelsOfInstance("engine-dead")).toBe(0);
		expect(await survivor.orchestrator.adoptOrphanedChannel([...channelKv.values()][0]!)).toBe(
			false,
		);
		await dead.orchestrator.onApplicationShutdown();
		await survivor.orchestrator.onApplicationShutdown();
	});

	it("hydrates an ownerless ARI snapshot on exactly one replica", async () => {
		const channelKv = new Map<string, ChannelSnapshot>();
		const seed = harness(fakeEnv({ ENGINE_INSTANCE_ID: "engine-seed" }), { channelKv });
		await seed.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(), args: [] }),
		);
		const [stored] = channelKv.values();
		if (stored === undefined) {
			throw new Error("the seed replica did not mirror its channel");
		}
		const variables = { ...stored.variables };
		delete variables.OPTIMIQ_ENGINE_INSTANCE_ID;
		delete variables[CHANNEL_OWNER_EXPIRES_AT_VARIABLE];
		channelKv.set(`${stored.organizationId}.${stored.callId}.${stored.channelId}`, {
			...stored,
			variables,
		});
		const replicas = [
			harness(fakeEnv({ ENGINE_INSTANCE_ID: "engine-a" }), { channelKv }),
			harness(fakeEnv({ ENGINE_INSTANCE_ID: "engine-b" }), { channelKv }),
		] as const;

		const hydrated = await Promise.all(
			replicas.map(async (replica) => await replica.orchestrator.hydrateChannels(1_000)),
		);

		expect(hydrated[0] + hydrated[1]).toBe(1);
		expect(
			replicas.reduce((sum, replica) => sum + replica.orchestrator.activeChannelCount, 0),
		).toBe(1);
		expect([...channelKv.values()][0]?.variables.OPTIMIQ_ENGINE_INSTANCE_ID).toMatch(
			/^engine-[ab]$/,
		);
		await Promise.all(
			replicas.map(async (replica) => await replica.orchestrator.onApplicationShutdown()),
		);
	});

	it("stops handling a mediad channel when its lease renewal loses", async () => {
		const h = harness(fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad" }), {
			renewResult: "lost",
		});
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		expect(h.orchestrator.activeChannelCount).toBe(1);

		await h.orchestrator.maintainChannelOwnership(2_000);

		expect(h.orchestrator.activeChannelCount).toBe(0);
		expect(h.kv.size).toBe(1);
		expect(h.mediaPort.hungUp()).toEqual([]);
	});

	it("self-fences after unavailable renewals outlive the last acknowledged lease", async () => {
		const h = harness(fakeEnv(), { renewResult: "unavailable" });
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		const [stored] = h.kv.values();
		if (stored === undefined) {
			throw new Error("the channel was not mirrored");
		}
		h.kv.set(`${stored.organizationId}.${stored.callId}.${stored.channelId}`, {
			...stored,
			variables: {
				...stored.variables,
				[CHANNEL_OWNER_EXPIRES_AT_VARIABLE]: "1000",
			},
		});

		await h.orchestrator.maintainChannelOwnership(999);
		expect(h.orchestrator.activeChannelCount).toBe(1);
		await h.orchestrator.maintainChannelOwnership(1_000);

		expect(h.orchestrator.activeChannelCount).toBe(0);
		expect(h.mediaPort.hungUp()).toEqual([]);
	});

	it("coalesces overlapping mediad ownership sweeps", async () => {
		const h = harness(fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad" }));
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		let renewals = 0;
		let finishRenewal: (() => void) | undefined;
		const renewal = new Promise<void>((resolve) => {
			finishRenewal = resolve;
		});
		Object.assign(h.jetstream, {
			renewChannel: async () => {
				renewals += 1;
				await renewal;
				return "renewed" as const;
			},
		});

		const first = h.orchestrator.maintainChannelOwnership(2_000);
		const second = h.orchestrator.maintainChannelOwnership(3_000);
		await Promise.resolve();
		expect(renewals).toBe(1);
		finishRenewal?.();
		await Promise.all([first, second]);
		expect(renewals).toBe(1);
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

	/**
	 * A leg that has COMMITTED an offer/answer exchange on a `183` is not un-committed by a later
	 * `180`. The machine allows `early → ringing` because a leg can genuinely fall back to ringback,
	 * but on this path the 180 is a retransmission or a chatty carrier, and letting it win reported a
	 * leg carrying audio as one that is merely alerting — on the `channels` mirror a softphone and a
	 * wallboard both read.
	 */
	it("does not let a later 180 take a leg back out of early media", async () => {
		const h = await arrived();
		await h.orchestrator.handleEvent({
			type: "call-state-changed",
			channelId: ARI_CHANNEL,
			callState: "early",
		});
		expect([...h.kv.values()][0]?.callState).toBe("early");

		await h.orchestrator.handleEvent({
			type: "call-state-changed",
			channelId: ARI_CHANNEL,
			callState: "ringing",
		});

		expect([...h.kv.values()][0]?.callState).toBe("early");
		expect(typesOf(h.published)).not.toContain("channel.ringing");
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

/**
 * The maximum-call-duration ceiling.
 *
 * These cases use the real clock, at the shortest budget the environment schema permits (one
 * second). Faking it would mean injecting a timer seam into the orchestrator for one guardrail,
 * and the thing worth proving here — that the timer is armed at ANSWER and disarmed at the leg's
 * end — is exactly the part a fake timer would stop testing.
 */
describe("maximum call duration", () => {
	const settle = (ms: number): Promise<void> =>
		new Promise((resolve) => {
			setTimeout(resolve, ms);
		});

	async function answeredWithCeiling(seconds: number) {
		const h = harness(fakeEnv({ ENGINE_MAX_CALL_DURATION_SECONDS: seconds }));
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelStateChange", { channel: channel({ state: "Up" }) }),
		);
		return h;
	}

	it("ends a call that outlives the ceiling, and says ALLOTTED_TIMEOUT in the CDR", async () => {
		const h = await answeredWithCeiling(1);

		await settle(1_200);

		expect(h.mediaPort.hungUp()).toEqual([{ channelId: ARI_CHANNEL, cause: "ALLOTTED_TIMEOUT" }]);

		// The cause is fixed BEFORE the media server reports its own generic code, which is the
		// whole point: a CDR that said NORMAL_CLEARING could not tell a cut call from a hangup.
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", {
				channel: channel({ state: "Down" }),
				cause: 16,
				cause_txt: "Normal Clearing",
			}),
		);
		expect(h.cdrs[0]?.data).toMatchObject({ hangupCause: "ALLOTTED_TIMEOUT" });
	});

	it("disarms the ceiling when the call ends on its own first", async () => {
		const h = await answeredWithCeiling(1);
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", {
				channel: channel({ state: "Down" }),
				cause: 16,
				cause_txt: "Normal Clearing",
			}),
		);

		await settle(1_200);

		expect(h.mediaPort.hungUp()).toEqual([]);
		expect(h.cdrs[0]?.data).toMatchObject({ hangupCause: "NORMAL_CLEARING" });
	});

	it("arms nothing at all when the deployment has switched the ceiling off", async () => {
		const h = await answeredWithCeiling(0);
		await settle(1_200);
		expect(h.mediaPort.hungUp()).toEqual([]);
	});
});

/**
 * The other half of the ceiling above, and the half that was missing.
 *
 * `armCallDurationCeiling` is armed on ANSWER, so a leg admitted into a routing walk that hangs had
 * no timer of any kind: no final response, no CDR, and a channel held until a four-hour ceiling
 * nobody had armed. Measured under load at 2 walks in 200. Real timers here, for the reason the
 * ceiling's own suite states.
 */
describe("the setup deadline", () => {
	const settle = (ms: number): Promise<void> =>
		new Promise((resolve) => {
			setTimeout(resolve, ms);
		});

	/** A leg that is admitted and then produces nothing — the hung walk, as the engine sees it. */
	async function admittedAndSilent(seconds: number) {
		const h = harness(
			fakeEnv({ ENGINE_SETUP_TIMEOUT_SECONDS: seconds, ENGINE_ROUTING_ENABLED: false }),
		);
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		return h;
	}

	it("ends an admitted leg that never produced a response, and says NO_USER_RESPONSE", async () => {
		const h = await admittedAndSilent(1);

		await settle(1_200);

		expect(h.mediaPort.hungUp()).toEqual([{ channelId: ARI_CHANNEL, cause: "NO_USER_RESPONSE" }]);
		// Ended LOCALLY too. A leg nobody has a dialog for provokes no terminal event, so waiting for
		// one is what left it in `activeChannels` for the four-hour ceiling. See `endStalledLeg`.
		expect(h.orchestrator.activeChannelCount).toBe(0);

		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", {
				channel: channel({ state: "Down" }),
				cause: 16,
				cause_txt: "Normal Clearing",
			}),
		);
		// The cause is fixed before the media server's generic code lands, so the CDR can answer
		// "did the platform lose this call" rather than claiming the caller hung up.
		expect(h.cdrs[0]?.data).toMatchObject({ hangupCause: "NO_USER_RESPONSE" });
	});

	it("disarms on the first sign of life, so a queue caller is never cut", async () => {
		const h = await admittedAndSilent(1);
		// A `180` — which every queue, IVR and ring group produces in milliseconds — and then a wait
		// far longer than the deadline.
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelStateChange", { channel: channel({ state: "Ringing" }) }),
		);

		await settle(1_200);

		expect(h.mediaPort.hungUp()).toEqual([]);
	});

	it("disarms when the leg is answered", async () => {
		const h = await admittedAndSilent(1);
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelStateChange", { channel: channel({ state: "Up" }) }),
		);

		await settle(1_200);

		expect(h.mediaPort.hungUp()).toEqual([]);
	});

	it("arms nothing at all when the deployment has switched it off", async () => {
		const h = await admittedAndSilent(0);
		await settle(1_200);
		expect(h.mediaPort.hungUp()).toEqual([]);
	});
});

describe("teardown", () => {
	async function answered(options: HarnessOptions = {}) {
		const h = harness(fakeEnv(), options);
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

	/**
	 * A payload its own contract rejects is PERMANENT, and the retry loop could only spin on it.
	 *
	 * The compiler mints a synthetic `feature-code:<kind>:<uuid>` for the `*65`/`*64` toggles, and
	 * `cdrLegWriteDataSchema.destinationRef` is a `z.uuid()`. Two such legs held `activeChannels: 2`
	 * across a process restart and wrote 483 identical error lines. `plan-destination.ts` stops
	 * minting the ref; this is the belt on the writer, for any producer that still can.
	 */
	it("drops a CDR its own contract rejects rather than retrying it forever", async () => {
		const h = await answered();
		(
			h.orchestrator as unknown as {
				registry: {
					byAriChannelId(id: string): { setVariable(name: string, value: string): void };
				};
			}
		).registry
			.byAriChannelId(ARI_CHANNEL)
			?.setVariable(
				"OPTIMIQ_DESTINATION_REF",
				"feature-code:call-flow:01a087c7-3aba-7000-8000-00000000fa",
			);

		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", {
				channel: channel({ state: "Down" }),
				cause: 16,
				cause_txt: "Normal Clearing",
			}),
		);

		// Nothing was filed — the row could not be built — but the leg IS released. A reporting hole
		// is a worse report; a leg nothing can free is a call the platform believes is still up.
		expect(h.cdrs).toHaveLength(0);
		expect(pendingCdrRetryCount(h.orchestrator)).toBe(0);
		expect(h.orchestrator.activeChannelCount).toBe(0);
		expect(h.kv.size).toBe(0);
	});

	it("autonomously retries a failed CDR with the same ids", async () => {
		const h = await answered({ cdrFailures: 1 });
		const ended = mediaEvent("ChannelDestroyed", {
			channel: channel({ state: "Down" }),
			cause: 16,
			cause_txt: "Normal Clearing",
		});

		await h.orchestrator.handleEvent(ended);

		expect(h.cdrs).toHaveLength(0);
		expect(h.cdrAttempts).toHaveLength(1);
		expect(h.kv.size).toBe(1);
		expect([...h.kv.values()][0]?.state).toBe("reporting");
		expect(h.orchestrator.activeChannelCount).toBe(1);
		expect(pendingCdrRetryCount(h.orchestrator)).toBe(1);

		await waitFor(() => h.cdrs.length === 1);

		expect(h.cdrs).toHaveLength(1);
		expect(h.cdrAttempts).toHaveLength(2);
		expect(h.cdrAttempts[1]?.id).toBe(h.cdrAttempts[0]?.id);
		expect(h.cdrAttempts[1]?.data.id).toBe(h.cdrAttempts[0]?.data.id);
		expect(typesOf(h.published)).toEqual(["channel.hangup", "channel.destroyed"]);
		expect(h.kv.size).toBe(0);
		expect(h.orchestrator.activeChannelCount).toBe(0);
		expect(pendingCdrRetryCount(h.orchestrator)).toBe(0);
	});

	it("strictly persists retry-stable terminal state before publishing terminal events", async () => {
		let publicationStarted: (() => void) | undefined;
		let releasePublication: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			publicationStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			releasePublication = resolve;
		});
		const h = await answered({
			beforeEventPublish: async (type) => {
				if (type === "channel.hangup") {
					publicationStarted?.();
					await blocked;
				}
			},
		});

		const ending = h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", {
				channel: channel({ state: "Down" }),
				cause: 16,
				cause_txt: "Normal Clearing",
			}),
		);
		await started;

		const recovery = [...h.kv.values()][0];
		const publishedWhileBlocked = [...h.published];
		const cdrAttemptsWhileBlocked = h.cdrAttempts.length;
		releasePublication?.();
		await ending;

		expect(recovery?.state).toBe("reporting");
		expect(recovery?.variables).toMatchObject({
			OPTIMIQ_CDR_HANGUP_CAUSE_CODE: "16",
		});
		expect(recovery?.variables.OPTIMIQ_CDR_ID).toBeDefined();
		expect(recovery?.variables.OPTIMIQ_TERMINAL_HANGUP_EVENT_ID).toBeDefined();
		expect(recovery?.variables.OPTIMIQ_TERMINAL_DESTROYED_EVENT_ID).toBeDefined();
		expect(recovery?.variables.OPTIMIQ_TERMINAL_EVENTS_PUBLISHED).toBeUndefined();
		expect(publishedWhileBlocked).toEqual([]);
		expect(cdrAttemptsWhileBlocked).toBe(0);
		expect(h.published.map((event) => event.id)).toEqual([
			recovery?.variables.OPTIMIQ_TERMINAL_HANGUP_EVENT_ID,
			recovery?.variables.OPTIMIQ_TERMINAL_DESTROYED_EVENT_ID,
		]);
		expect(h.persistAttempts[1]?.variables.OPTIMIQ_TERMINAL_EVENTS_PUBLISHED).toBe("true");

		const replacement = harness(fakeEnv(), {
			snapshots: [JSON.parse(JSON.stringify(recovery)) as ChannelSnapshot],
		});
		expect(await replacement.orchestrator.hydrateChannels()).toBe(1);
		expect(replacement.published.map((event) => event.id)).toEqual(
			h.published.map((event) => event.id),
		);
		expect(typesOf(replacement.published)).toEqual(["channel.hangup", "channel.destroyed"]);
		expect(replacement.cdrs).toHaveLength(1);
	});

	it("resumes a hydrated reporting snapshot without another media event", async () => {
		const original = await answered({ cdrFailures: 100 });
		const ended = mediaEvent("ChannelDestroyed", {
			channel: channel({ state: "Down" }),
			cause: 16,
			cause_txt: "Normal Clearing",
		});
		await original.orchestrator.handleEvent(ended);
		const recovery = [...original.kv.values()][0];
		if (recovery === undefined) {
			throw new Error("terminal recovery snapshot was not retained");
		}
		await original.orchestrator.onApplicationShutdown();
		expect(pendingCdrRetryCount(original.orchestrator)).toBe(0);

		const replacement = harness(fakeEnv(), {
			snapshots: [JSON.parse(JSON.stringify(recovery)) as ChannelSnapshot],
		});
		expect(await replacement.orchestrator.hydrateChannels()).toBe(1);
		expect(replacement.orchestrator.activeChannelCount).toBe(0);
		expect(replacement.mediaCalls).toContainEqual({
			method: "watchChannel",
			args: [ARI_CHANNEL],
		});
		expect(replacement.cdrs).toHaveLength(1);
		expect(replacement.cdrs[0]?.id).toBe(original.cdrAttempts[0]?.id);
		expect(replacement.cdrs[0]?.data.id).toBe(original.cdrAttempts[0]?.data.id);
		expect(replacement.published).toEqual([]);
		expect(replacement.kv.size).toBe(0);
		expect(replacement.orchestrator.activeChannelCount).toBe(0);
	});

	it("does not publish until the reporting snapshot persistence barrier succeeds", async () => {
		const h = await answered({ persistFailures: 1 });
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", {
				channel: channel({ state: "Down" }),
				cause: 16,
				cause_txt: "Normal Clearing",
			}),
		);

		expect(h.persistAttempts).toHaveLength(1);
		expect(h.published).toEqual([]);
		expect(h.cdrAttempts).toHaveLength(0);
		expect(h.orchestrator.activeChannelCount).toBe(1);
		expect(pendingCdrRetryCount(h.orchestrator)).toBe(1);
		const stableId = h.persistAttempts[0]?.variables.OPTIMIQ_CDR_ID;

		await waitFor(() => h.cdrs.length === 1);

		expect(h.persistAttempts).toHaveLength(3);
		expect(typesOf(h.published)).toEqual(["channel.hangup", "channel.destroyed"]);
		expect(h.cdrs[0]?.id).toBe(h.persistAttempts[0]?.variables.OPTIMIQ_CDR_EVENT_ID);
		expect(h.cdrs[0]?.data.id).toBe(stableId);
		expect(stableId).toBe(legIdForAriChannel(ARI_CHANNEL));
		expect(h.kv.size).toBe(0);
		expect(pendingCdrRetryCount(h.orchestrator)).toBe(0);
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

	it("releases mid-call state by media channel id throughout teardown", async () => {
		const h = await answered();
		const midCall = (
			h.orchestrator as unknown as {
				midCall: { release(mediaChannelId: string): void };
			}
		).midCall;
		const originalRelease = midCall.release.bind(midCall);
		const released: string[] = [];
		midCall.release = (mediaChannelId) => {
			released.push(mediaChannelId);
			originalRelease(mediaChannelId);
		};

		await h.orchestrator.handleEvent({ type: "leg-left", channelId: ARI_CHANNEL });
		await h.orchestrator.handleEvent({
			type: "leg-ended",
			channelId: ARI_CHANNEL,
			cause: "NORMAL_CLEARING",
			causeCode: 16,
		});

		expect(released).toEqual([ARI_CHANNEL, ARI_CHANNEL]);
	});
});

describe("drain", () => {
	let harnessInstance: ReturnType<typeof harness>;

	async function reportingWithFailures() {
		const h = harness(fakeEnv({ ENGINE_DRAIN_TIMEOUT_MS: 0 }), { cdrFailures: 100 });
		await h.orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] }));
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelStateChange", { channel: channel({ state: "Up" }) }),
		);
		await h.orchestrator.handleEvent(
			mediaEvent("ChannelDestroyed", { channel: channel({ state: "Down" }), cause: 16 }),
		);
		return h;
	}

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

	it("clears all mid-call runtime state before waiting", async () => {
		const midCall = (
			harnessInstance.orchestrator as unknown as {
				midCall: { clear(): void };
			}
		).midCall;
		const originalClear = midCall.clear.bind(midCall);
		let clears = 0;
		midCall.clear = () => {
			clears += 1;
			originalClear();
		};

		await harnessInstance.orchestrator.drain(0);

		expect(clears).toBe(1);
	});

	it("stops retry timers on drain while retaining the durable reporting record", async () => {
		const h = await reportingWithFailures();
		expect(pendingCdrRetryCount(h.orchestrator)).toBe(1);

		await h.orchestrator.drain(0);

		expect(pendingCdrRetryCount(h.orchestrator)).toBe(0);
		expect([...h.kv.values()][0]?.state).toBe("reporting");
		const attempts = h.cdrAttempts.length;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(h.cdrAttempts).toHaveLength(attempts);
	});

	it("stops retry timers on application shutdown without deleting the reporting record", async () => {
		const h = await reportingWithFailures();
		expect(pendingCdrRetryCount(h.orchestrator)).toBe(1);

		await h.orchestrator.onApplicationShutdown();

		expect(pendingCdrRetryCount(h.orchestrator)).toBe(0);
		expect([...h.kv.values()][0]?.state).toBe("reporting");
	});
});

/**
 * Plane loss. Under the split plane each half of a call is independently mortal, and exactly one of
 * the two deaths was silent: a `mediad` crash left both parties in a live, mute call the engine
 * could not end because its own hangup path went through `mediad`, and a `sipd` crash left media
 * flowing perfectly through a call whose BYE was answered 481 by the process that replaced it.
 */
describe("plane loss", () => {
	async function withOneLiveLeg(sipdInstanceId?: string) {
		const h = harness();
		const variables =
			sipdInstanceId === undefined
				? {}
				: { channelvars: { OPTIMIQ_ORG_ID: ORG, OPTIMIQ_SIPD_INSTANCE_ID: sipdInstanceId } };
		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", { channel: channel(variables), args: [] }),
		);
		expect(h.orchestrator.activeChannelCount).toBe(1);
		h.mediaCalls.length = 0;
		h.published.length = 0;
		return h;
	}

	it("BYEs, bills and forgets every leg when the media plane is lost", async () => {
		const h = await withOneLiveLeg();

		const ended = await h.orchestrator.endLegsOnPlaneLoss({
			plane: "media",
			reason: "MEDIA_OWNER_LOST",
		});

		expect(ended).toBe(1);
		// The BYE goes to the signalling plane, which is still there — the half that was impossible
		// while the hangup path needed `mediad`.
		expect(h.mediaCalls).toContainEqual({
			method: "hangup",
			args: [ARI_CHANNEL, "NORMAL_TEMPORARY_FAILURE"],
		});
		// Q.850 41 and not 16: a crash filed as a normal hang-up is an availability incident that
		// cannot be seen in the CDR afterwards.
		expect(h.cdrs[0]?.data).toMatchObject({ hangupCause: "NORMAL_TEMPORARY_FAILURE" });
		// And the aggregate is gone, so `/healthz.activeChannels` tells the truth.
		expect(h.orchestrator.activeChannelCount).toBe(0);
	});

	it("bills and forgets the legs of a sip instance that died, without a BYE nobody can receive", async () => {
		const h = await withOneLiveLeg("sipd-gone");

		const ended = await h.orchestrator.endLegsOnPlaneLoss({
			plane: "signalling",
			instanceId: "sipd-gone",
			reason: "SIP_OWNER_LOST",
		});

		expect(ended).toBe(1);
		// No hangup command: the edge that would carry it is the thing that died, and addressing one
		// at it would cost a full RPC timeout per leg to reach a process that never had the call.
		expect(h.mediaCalls.filter((call) => call.method === "hangup")).toEqual([]);
		expect(h.cdrs[0]?.data).toMatchObject({ hangupCause: "NORMAL_TEMPORARY_FAILURE" });
		expect(h.orchestrator.activeChannelCount).toBe(0);
	});

	it("leaves the legs of a sip instance that is still alive alone", async () => {
		const h = await withOneLiveLeg("sipd-live");

		const ended = await h.orchestrator.endLegsOnPlaneLoss({
			plane: "signalling",
			instanceId: "sipd-gone",
			reason: "SIP_OWNER_LOST",
		});

		expect(ended).toBe(0);
		expect(h.orchestrator.activeChannelCount).toBe(1);
	});

	/**
	 * The ordering that decides what a crashed call's CDR says, found live rather than reasoned about:
	 * the B-leg's row came back `NORMAL_CLEARING` against a cause code of 41.
	 *
	 * `markHangup` is first-wins, and ending the A-leg runs `endBridgePeer`, which hangs its bridged
	 * partner up with `NORMAL_CLEARING`. Marking each leg inside the teardown loop therefore reached
	 * the B-leg too late and filed half of a crashed call as a normal hang-up — which is the exact
	 * thing the cause choice exists to prevent.
	 */
	it("fixes every leg's cause before the first teardown, so a bridged pair agrees", async () => {
		const h = await withOneLiveLeg();
		const peerAri = "peer-ari-channel";
		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", {
				channel: channel({ id: peerAri, channelvars: { OPTIMIQ_ORG_ID: ORG } }),
				args: [],
			}),
		);
		const registry = (
			h.orchestrator as unknown as {
				registry: {
					byAriChannelId(id: string): {
						channelId: string;
						setVariable(n: string, v: string): void;
					};
				};
			}
		).registry;
		const a = registry.byAriChannelId(ARI_CHANNEL);
		const b = registry.byAriChannelId(peerAri);
		a.setVariable("OPTIMIQ_BRIDGE_PEER_LEG_ID", b.channelId);
		b.setVariable("OPTIMIQ_BRIDGE_PEER_LEG_ID", a.channelId);
		h.cdrs.length = 0;

		await h.orchestrator.endLegsOnPlaneLoss({ plane: "media", reason: "MEDIA_OWNER_LOST" });

		expect(h.cdrs).toHaveLength(2);
		for (const cdr of h.cdrs) {
			expect(cdr.data).toMatchObject({
				hangupCause: "NORMAL_TEMPORARY_FAILURE",
				hangupCauseCode: 41,
			});
		}
		// And the WIRE agrees with the ledger. `endBridgePeer` used to send a fixed
		// `NORMAL_CLEARING`, which told the far end's carrier that a crashed call was a normal
		// hang-up while the CDR beside it said 41.
		for (const call of h.mediaCalls.filter((entry) => entry.method === "hangup")) {
			expect(call.args[1]).toBe("NORMAL_TEMPORARY_FAILURE");
		}
	});

	/** The same guarantee on the signalling side, where there is no BYE to carry the cause. */
	it("files a bridged pair with one agreed cause when the sip edge dies", async () => {
		const h = await withOneLiveLeg("sipd-gone");
		const peerAri = "peer-ari-channel";
		await h.orchestrator.handleEvent(
			mediaEvent("StasisStart", {
				channel: channel({
					id: peerAri,
					channelvars: { OPTIMIQ_ORG_ID: ORG, OPTIMIQ_SIPD_INSTANCE_ID: "sipd-gone" },
				}),
				args: [],
			}),
		);
		const registry = (
			h.orchestrator as unknown as {
				registry: {
					byAriChannelId(id: string): {
						channelId: string;
						setVariable(n: string, v: string): void;
					};
				};
			}
		).registry;
		const a = registry.byAriChannelId(ARI_CHANNEL);
		const b = registry.byAriChannelId(peerAri);
		a.setVariable("OPTIMIQ_BRIDGE_PEER_LEG_ID", b.channelId);
		b.setVariable("OPTIMIQ_BRIDGE_PEER_LEG_ID", a.channelId);
		// A code an earlier dial or bridge already stamped. `finishReporting` keeps one once written,
		// so without the overwrite this leg is filed `NORMAL_TEMPORARY_FAILURE` with a cause code of
		// 16 — a billing row that contradicts itself. Seen live before it was a test.
		b.setVariable("OPTIMIQ_CDR_HANGUP_CAUSE_CODE", "16");
		h.cdrs.length = 0;

		await h.orchestrator.endLegsOnPlaneLoss({
			plane: "signalling",
			instanceId: "sipd-gone",
			reason: "SIP_OWNER_LOST",
		});

		expect(h.cdrs).toHaveLength(2);
		for (const cdr of h.cdrs) {
			expect(cdr.data).toMatchObject({
				hangupCause: "NORMAL_TEMPORARY_FAILURE",
				hangupCauseCode: 41,
			});
		}
	});

	/**
	 * A drain is already hanging these legs up with a cause of its own. Both paths reaching
	 * `onLegEnded` for one leg would race over which cause the CDR keeps.
	 */
	it("defers to a drain that is already under way", async () => {
		const h = await withOneLiveLeg();
		await h.orchestrator.drain(0);
		h.mediaCalls.length = 0;

		const ended = await h.orchestrator.endLegsOnPlaneLoss({
			plane: "media",
			reason: "MEDIA_OWNER_LOST",
		});

		expect(ended).toBe(0);
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
			NO_FEATURES,
			NO_LAST_CALLER,
			NO_GREETINGS,
			NO_SUPERVISION,
			NO_DID_INDEX,
			h.signals,
			new ConferenceRegistry(),
			...(fakeQueueOrchestratorArgs() as [never, never, never, never, never]),
			new ParkRegistry(),
			new CallControlRegistry(),
			NO_PARK_HANDOFF,
			fakeSipTransfer().service,
			fakeOriginate().service,
			fakeSipInvite().service,
		);

		await expect(
			orchestrator.handleEvent(mediaEvent("StasisStart", { channel: channel(), args: [] })),
		).resolves.toBeUndefined();
		expect(orchestrator.activeChannelCount).toBe(1);
	});
});

/**
 * The SIP edge's admission path, from the orchestrator's side of the seam.
 *
 * The broker half — framing, the toll-fraud refusal, the `Replaces` gate — is proven in
 * `nats/sip-invite.service.spec.ts` with a fake call path. What is proven HERE is the claim the
 * design rests on: a call admitted from `apps/sipd` is filed by the SAME arrival path an Asterisk
 * call takes, with the same derived ids, the same KV claim and the same `channel.created`. If that
 * stops being true, every feature above it becomes a thing that works on one plane.
 */
const SIPD_LEG = "0195c0f0-1c2f-7000-8000-0000000000aa";
const DEVICE = "0195c0f0-1c2f-7000-8000-0000000000d1";

function inviteRequest(overrides: Record<string, unknown> = {}): SipInviteRequest {
	return {
		legId: SIPD_LEG,
		sipdInstanceId: "sipd-7c9f",
		orgId: ORG,
		authentication: "digest",
		routingContext: "internal",
		from: { number: "1001", name: "Ada Lovelace", aor: "sip:1001@acme.example.com" },
		to: { number: "1002" },
		sipCallId: "a84b4c76e66710@pc33",
		hasOffer: true,
		sdpOffer: "v=0\r\n",
		...overrides,
	} as SipInviteRequest;
}

/**
 * A carrier's INVITE: no credential organization, and the untrusted inbound context.
 *
 * The tenant is the ENGINE's to resolve for this one — the edge authenticated a source ADDRESS, not
 * a subscriber — which is exactly why the `did-index` bucket is not organization-scoped.
 */
function trunkInviteRequest(overrides: Record<string, unknown> = {}): SipInviteRequest {
	const request = inviteRequest({
		authentication: "trunk-acl",
		routingContext: "inbound-untrusted",
		from: { number: "+15551230000" },
		...overrides,
	}) as SipInviteRequest & { orgId?: string };
	delete request.orgId;
	return request;
}

/** The only legal media plane for a call signalled by `apps/sipd`. See `plans/sipd-invite-design.md` §3.5. */
function sipdEnv(overrides: Partial<EngineEnv> = {}): EngineEnv {
	return fakeEnv({ ENGINE_MEDIA_DRIVER: "mediad", ...overrides });
}

describe("admitting a call from the sip edge", () => {
	it("registers the native leg before ringing and preserves its SIP identity", async () => {
		const transport = new FakeMediadTransport();
		const commands: string[] = [];
		const signalling = {
			ring: async (_instance: string, request: { legId: string }) => {
				commands.push(request.legId);
				return { ok: true, legId: request.legId };
			},
			answer: async (_instance: string, request: { legId: string }) => {
				commands.push(request.legId);
				return { ok: true, legId: request.legId };
			},
		} as unknown as SipdCommandPort;
		const nativeMedia = new SplitPlaneMediaPort(new MediadMediaPort(transport, 500), signalling);
		const h = harness(sipdEnv(), { nativeMedia });
		const admission = await h.sipInviteCallPath().admit(inviteRequest());
		expect(admission).toMatchObject({ kind: "admitted", legId: SIPD_LEG });
		expect(commands).toEqual([SIPD_LEG, SIPD_LEG]);
	});

	it("settles an outbound answer even when the leg already has a call aggregate", async () => {
		const transport = new FakeMediadTransport();
		const signalling = {
			ring: async () => ({ ok: true, legId: SIPD_LEG }),
			answer: async () => ({ ok: true, legId: SIPD_LEG }),
		} as unknown as SipdCommandPort;
		const nativeMedia = new SplitPlaneMediaPort(new MediadMediaPort(transport, 500), signalling);
		const h = harness(sipdEnv(), { nativeMedia });
		await h.sipInviteCallPath().admit(inviteRequest());
		await h.orchestrator.handleEvent({
			type: "call-state-changed",
			channelId: SIPD_LEG,
			callState: "active",
			sdpAnswer: "v=0\r\n",
		});
		expect(transport.requests.some((request) => request.subject.includes("accept-answer"))).toBe(
			true,
		);
	});

	/**
	 * Early media, and the one assertion that matters most about it: a `183` gives the caller AUDIO and
	 * gives the tenant no bill. A CDR whose `billsec` started at the carrier's announcement is a refund
	 * queue, so `channel.answered` must stay on the `200` and nothing on this path may reach it.
	 */
	it("relays a callee's early media to the caller without starting the billing clock", async () => {
		const B_LEG = "0195c0f0-1c2f-7000-8000-0000000000bb";
		const transport = new FakeMediadTransport();
		const rings: { status: number; sdpAnswer?: string }[] = [];
		const signalling = {
			ring: async (
				_instance: string,
				request: { legId: string; status: number; sdpAnswer?: string },
			) => {
				rings.push({ status: request.status, sdpAnswer: request.sdpAnswer });
				return { ok: true, legId: request.legId };
			},
			answer: async (_instance: string, request: { legId: string }) => ({
				ok: true,
				legId: request.legId,
			}),
			originate: async (request: { legId: string }) => ({
				ok: true,
				legId: request.legId,
				instanceId: "sipd-7c9f",
			}),
		} as unknown as SipdCommandPort;
		const nativeMedia = new SplitPlaneMediaPort(new MediadMediaPort(transport, 500), signalling);
		const h = harness(sipdEnv(), { nativeMedia });
		await h.sipInviteCallPath().admit(inviteRequest());

		transport.reply(RPC_SUBJECTS.mediaCreateOffer, {
			ok: true,
			sessionId: B_LEG,
			sdpOffer: "v=0\r\n",
		});
		transport.reply(RPC_SUBJECTS.mediaAcceptAnswer, {
			ok: true,
			sessionId: B_LEG,
			accepted: true,
			instanceId: "mediad-fake",
		});
		nativeMedia.registerOutboundLeg(B_LEG, { orgId: ORG, callId: callIdForAriChannel(SIPD_LEG) });
		await nativeMedia.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: B_LEG,
			originatorChannelId: SIPD_LEG,
			target: { kind: "uri", uri: "sip:1002@carrier" },
		});
		const ringsBefore = rings.length;

		await h.orchestrator.handleEvent({
			type: "call-state-changed",
			channelId: B_LEG,
			callState: "early",
			sdpAnswer: "v=0\r\n",
		});

		// The carrier's answer was settled on the B-leg, and the caller got a 183 carrying mediad's
		// answer to their own offer — without which the announcement plays to a leg with no media path.
		expect(transport.requests.some((request) => request.subject.includes("accept-answer"))).toBe(
			true,
		);
		const relayed = rings.slice(ringsBefore);
		expect(relayed).toHaveLength(1);
		expect(relayed[0]?.status).toBe(183);
		expect(relayed[0]?.sdpAnswer).toContain("v=0");

		// A second 18x from a chatty carrier renegotiates nobody.
		await h.orchestrator.handleEvent({
			type: "call-state-changed",
			channelId: B_LEG,
			callState: "early",
			sdpAnswer: "v=0\r\n",
		});
		expect(rings.slice(ringsBefore)).toHaveLength(1);

		// The whole point: no billing moved.
		expect(h.published.some((event) => event.type === "channel.answered")).toBe(false);

		await h.orchestrator.handleEvent({
			type: "call-state-changed",
			channelId: SIPD_LEG,
			callState: "active",
		});
		expect(h.published.some((event) => event.type === "channel.answered")).toBe(true);
	});

	/**
	 * Regression, and the one that cost three features at once.
	 *
	 * `invitedChannelSnapshot` stamped eleven variables and `readEngineVariables` allow-listed seven,
	 * so the device id and all three STIR/SHAKEN names were dropped between the INVITE and the
	 * aggregate — emptying the CDR's attestation columns, making hot-desk's `deviceId` precondition
	 * unsatisfiable by any endpoint, and taking the Ray Baum device off the emergency event. Both
	 * halves are now derived from `ARRIVAL_VARIABLES`, and this pins the round trip end to end.
	 */
	it("reads back every variable the arriving INVITE stamped", async () => {
		const h = harness(sipdEnv());

		await h.sipInviteCallPath().admit(
			inviteRequest({
				deviceId: DEVICE,
				attestation: {
					level: "A",
					verstat: "tn-validation-passed",
					origId: "final2-origid-0001",
					signed: true,
				},
			}),
		);

		const snapshot = [...h.kv.values()][0];
		expect(snapshot?.variables).toMatchObject({
			OPTIMIQ_ORG_ID: ORG,
			OPTIMIQ_CALL_DIRECTION: "internal",
			OPTIMIQ_ROUTING_CONTEXT: "internal",
			OPTIMIQ_LEG: "a",
			OPTIMIQ_SIP_CALL_ID: "a84b4c76e66710@pc33",
			OPTIMIQ_SIPD_INSTANCE_ID: "sipd-7c9f",
			OPTIMIQ_DEVICE_ID: DEVICE,
			OPTIMIQ_SIP_ATTESTATION: "A",
			OPTIMIQ_SIP_VERSTAT: "tn-validation-passed",
			OPTIMIQ_SIP_ORIGID: "final2-origid-0001",
		});
		// `OPTIMIQ_DEVICE_ID` is what `ControlledLeg.deviceId` returns, which is what the walker's
		// hot-desk precondition and the Ray Baum dispatchable location on `call.emergency.dialed`
		// both read. It was `undefined` for every endpoint there has ever been.
	});

	/** The other end of the same round trip: the columns a traceback is answered from. */
	it("puts the carrier's attestation and the dialog's Call-ID on the CDR", async () => {
		const h = harness(sipdEnv());

		await h.sipInviteCallPath().admit(
			inviteRequest({
				deviceId: DEVICE,
				attestation: { level: "B", verstat: "tn-validation-failed", origId: "og-99", signed: true },
			}),
		);
		await h.orchestrator.handleEvent({
			type: "leg-ended",
			channelId: SIPD_LEG,
			cause: "NORMAL_CLEARING",
			causeCode: 16,
		});

		expect(h.cdrs[0]?.data).toMatchObject({
			sipAttestation: "B",
			sipVerstat: "tn-validation-failed",
			sipOrigId: "og-99",
			sipCallId: "a84b4c76e66710@pc33",
		});
	});

	/**
	 * Regression: on the wire this failed with NO log line at all.
	 *
	 * `relayEarlyMedia` read the originator only from the composite's own leg record and returned
	 * silently when it was empty, so a carrier's `183` with 8 s of announcement reached a caller who
	 * got zero packets until the `200`. The B-leg's `OPTIMIQ_ORIGINATING_LEG_ID` — the same fact the
	 * CDR assembles a fan-out with — answers the same question, and now does.
	 */
	it("relays early media using the B-leg's originating-leg variable when the port has no record", async () => {
		const B_LEG = "0195c0f0-1c2f-7000-8000-0000000000bc";
		const transport = new FakeMediadTransport();
		const rings: { status: number; sdpAnswer?: string }[] = [];
		const signalling = {
			ring: async (
				_instance: string,
				request: { legId: string; status: number; sdpAnswer?: string },
			) => {
				rings.push({ status: request.status, sdpAnswer: request.sdpAnswer });
				return { ok: true, legId: request.legId };
			},
			answer: async (_instance: string, request: { legId: string }) => ({
				ok: true,
				legId: request.legId,
			}),
			originate: async (request: { legId: string }) => ({
				ok: true,
				legId: request.legId,
				instanceId: "sipd-7c9f",
			}),
		} as unknown as SipdCommandPort;
		const nativeMedia = new SplitPlaneMediaPort(new MediadMediaPort(transport, 500), signalling);
		const h = harness(sipdEnv(), { nativeMedia });
		const admitted = await h.sipInviteCallPath().admit(inviteRequest());
		const aLegId = (admitted as { legId: string }).legId;

		transport.reply(RPC_SUBJECTS.mediaCreateOffer, {
			ok: true,
			sessionId: B_LEG,
			sdpOffer: "v=0\r\n",
		});
		transport.reply(RPC_SUBJECTS.mediaAcceptAnswer, {
			ok: true,
			sessionId: B_LEG,
			accepted: true,
			instanceId: "mediad-fake",
		});
		nativeMedia.registerOutboundLeg(B_LEG, { orgId: ORG, callId: callIdForAriChannel(SIPD_LEG) });
		// The originate that DOES name the caller is the one that worked. This is the shape that did
		// not: a plane record with no `originatorChannelId` on it.
		await nativeMedia.originate({
			endpoint: "PJSIP/1002",
			application: "engine",
			channelId: B_LEG,
			target: { kind: "uri", uri: "sip:1002@carrier" },
		});
		expect(nativeMedia.originatorOf(B_LEG)).toBeUndefined();

		// The B-leg as the walker files it: an aggregate naming the leg that dialled it.
		registerBLeg(h.orchestrator, B_LEG, aLegId);
		const ringsBefore = rings.length;

		await h.orchestrator.handleEvent({
			type: "call-state-changed",
			channelId: B_LEG,
			callState: "early",
			sdpAnswer: "v=0\r\n",
		});

		const relayed = rings.slice(ringsBefore);
		expect(relayed).toHaveLength(1);
		expect(relayed[0]?.status).toBe(183);
		expect(relayed[0]?.sdpAnswer).toContain("v=0");
	});

	it("files it as an ordinary A-leg, with the ids every other path derives", async () => {
		const h = harness(sipdEnv());

		const admission = await h.sipInviteCallPath().admit(inviteRequest());

		expect(admission).toEqual({
			kind: "admitted",
			orgId: ORG,
			// Derived from the edge's leg id, not invented: that derivation is what makes a leg id
			// survive a restart and a failover onto another replica.
			callId: callIdForAriChannel(SIPD_LEG),
			legId: legIdForAriChannel(SIPD_LEG),
			routingContext: "internal",
			direction: "internal",
		});
		expect(h.orchestrator.activeChannelCount).toBe(1);
	});

	it("publishes the same channel.created an Asterisk arrival does, with a real SIP Call-ID", async () => {
		const h = harness(sipdEnv());

		await h.sipInviteCallPath().admit(inviteRequest());

		const created = h.published.find((event) => event.type === "channel.created");
		expect(created?.data).toMatchObject({
			legId: legIdForAriChannel(SIPD_LEG),
			leg: "a",
			direction: "internal",
			from: { number: "1001", name: "Ada Lovelace" },
			to: { number: "1002" },
			// The field the ARI plane has to read off a channel function. Here it arrives natively.
			sipCallId: "a84b4c76e66710@pc33",
		});
	});

	it("stamps the edge instance on the leg, so a later command knows who to address", async () => {
		const h = harness(sipdEnv());

		await h.sipInviteCallPath().admit(inviteRequest());

		const snapshot = h.kv.get(
			`${ORG}.${callIdForAriChannel(SIPD_LEG)}.${legIdForAriChannel(SIPD_LEG)}`,
		);
		expect(snapshot?.variables).toMatchObject({
			OPTIMIQ_SIPD_INSTANCE_ID: "sipd-7c9f",
			OPTIMIQ_LEG: "a",
			OPTIMIQ_ROUTING_CONTEXT: "internal",
		});
	});

	it("answers a retry with the call it already admitted, rather than admitting it twice", async () => {
		const h = harness(sipdEnv());

		const first = await h.sipInviteCallPath().admit(inviteRequest());
		const second = await h.sipInviteCallPath().admit(inviteRequest());

		expect(second).toEqual(first);
		// Without idempotency a one-second deadline against a busy engine files one INVITE as two
		// calls, with two CDR rows and two walks racing to dial the same extension.
		expect(h.orchestrator.activeChannelCount).toBe(1);
	});

	it("resolves a trunk call's tenant through the did-index, exactly as an inbound call does", async () => {
		const h = harness(sipdEnv(), {
			didIndex: {
				organizationFor: async () => ({
					organizationId: ORG,
					phoneNumberId: "pn-1",
					enabled: true,
				}),
			} as unknown as DidIndexSource,
		});

		const admission = await h
			.sipInviteCallPath()
			.admit(trunkInviteRequest({ to: { number: "+441632960111" } }));

		expect(admission).toMatchObject({ kind: "admitted", orgId: ORG, direction: "inbound" });
	});
});

describe("refusing a call from the sip edge", () => {
	it("refuses when this deployment signals on sipd and serves media on Asterisk", async () => {
		// The one illegal combination. `apps/sipd` holds no ARI credential and there is no Asterisk
		// channel this leg could name, so the call would ring and never get audio — which is the
		// defect class the whole design spends its budget avoiding.
		const h = harness(fakeEnv({ ENGINE_MEDIA_DRIVER: "ari" }));

		const admission = await h.sipInviteCallPath().admit(inviteRequest());

		expect(admission).toMatchObject({ kind: "refused", reason: "internal" });
		expect(h.orchestrator.activeChannelCount).toBe(0);
	});

	it("refuses a call nothing on this platform owns", async () => {
		const h = harness(sipdEnv());

		const admission = await h.sipInviteCallPath().admit(trunkInviteRequest());

		// `404` on the wire, and the honest answer: no credential organization and no did-index entry.
		expect(admission).toMatchObject({ kind: "refused", reason: "unattributed" });
	});

	it("refuses with shutting_down while draining, so the carrier fails over", async () => {
		const h = harness(sipdEnv());
		await h.orchestrator.drain();

		const admission = await h.sipInviteCallPath().admit(inviteRequest());

		expect(admission).toMatchObject({ kind: "refused", reason: "shutting_down" });
	});
});

describe("authorising a Replaces", () => {
	const replaces = { callId: "aa11@1.2.3.4", toTag: "b2", fromTag: "c3", earlyOnly: false };

	it("refuses a Replaces from a carrier, whatever dialog it named", async () => {
		const h = harness(sipdEnv());
		await h.sipInviteCallPath().admit(inviteRequest());

		const verdict = await h.sipInviteCallPath().authorizeReplaces?.(
			inviteRequest({
				legId: "0195c0f0-1c2f-7000-8000-0000000000ab",
				authentication: "trunk-acl",
				replaces,
				replacesLegId: SIPD_LEG,
			}),
		);

		// A carrier has no legitimate reason to insert itself into a conversation on this platform.
		expect(verdict).toMatchObject({ kind: "refused" });
	});

	it("refuses when no live leg on this engine holds the dialog", async () => {
		const h = harness(sipdEnv());

		const verdict = await h
			.sipInviteCallPath()
			.authorizeReplaces?.(inviteRequest({ replaces, replacesLegId: "leg-nobody-holds" }));

		expect(verdict).toMatchObject({ kind: "refused" });
	});

	it("refuses a dialog in another organization, even with the triple right", async () => {
		const h = harness(sipdEnv());
		await h.sipInviteCallPath().admit(inviteRequest());

		const verdict = await h.sipInviteCallPath().authorizeReplaces?.(
			inviteRequest({
				legId: "0195c0f0-1c2f-7000-8000-0000000000ab",
				orgId: "0195c0f0-1c2f-7000-8000-000000000002",
				replaces,
				replacesLegId: SIPD_LEG,
			}),
		);

		expect(verdict).toMatchObject({ kind: "refused" });
	});

	it("authorises a digest-authenticated party of the same tenant against a leg it holds", async () => {
		const h = harness(sipdEnv());
		await h.sipInviteCallPath().admit(inviteRequest());

		const verdict = await h.sipInviteCallPath().authorizeReplaces?.(
			inviteRequest({
				legId: "0195c0f0-1c2f-7000-8000-0000000000ab",
				replaces,
				replacesLegId: SIPD_LEG,
			}),
		);

		// The triple was matched at the edge — the only process holding the tags — and everything the
		// engine can add on top of it holds. Note that the sender is deliberately NOT required to be a
		// party to the replaced call: RFC 5589's attended transfer has the TRANSFER TARGET send this.
		expect(verdict).toMatchObject({ kind: "authorized", replacedLegId: SIPD_LEG });
	});
});

/**
 * The PBX recording control — `rpc.engine.v1.call-control`, the surface a call NOBODY was handed
 * can be paused from.
 *
 * The handler is reached directly rather than through the NATS responder for the reason
 * `registerBLeg` states about the registry: what is under test is the authorisation and the leg
 * resolution, and a broker between the assertion and the thing asserted proves neither.
 */
describe("recording control for a call under nobody's session", () => {
	interface ControlHandle {
		controlCallRecording(request: {
			orgId: string;
			callId: string;
			legId?: string;
			verb: "pauseRecord" | "resumeRecord" | "stopRecord";
		}): Promise<{
			ok: boolean;
			legId?: string;
			recording?: boolean;
			paused?: boolean;
			reason?: string;
		}>;
		control: {
			startRecording(leg: unknown): Promise<{ result: { ok: boolean } }>;
			recordingFor(mediaChannelId: string): { paused: boolean } | undefined;
		};
		controlledLegFor(mediaChannelId: string): unknown;
	}

	function recordingHarness(instanceId = "engine-test") {
		const h = harness(fakeEnv({ ENGINE_INSTANCE_ID: instanceId }));
		// A conversation recorder, the split-plane shape, so `startRecording` writes the leg directly
		// rather than waiting for a snoop channel to enter the application. The snoop path is
		// `call-control.spec.ts`'s to prove; what is under test here is the RPC above it.
		(h.mediaPort as unknown as { recordConversation: unknown }).recordConversation = (
			h.mediaPort as unknown as { record: (id: string, request: unknown) => Promise<unknown> }
		).record.bind(h.mediaPort);
		registerBLeg(h.orchestrator, "media-1", "leg-a");
		// Answered, because a recorder needs a media path — the same guard `verbRequiresMediaPath`
		// applies to `record`.
		const aggregate = (
			h.orchestrator as unknown as {
				registry: {
					byAriChannelId(id: string): {
						markAnswered(at: number): void;
						addFlag(flag: string): void;
					};
				};
			}
		).registry.byAriChannelId("media-1");
		aggregate?.markAnswered(Date.now());
		aggregate?.addFlag("answered");
		const inner = h.orchestrator as unknown as ControlHandle;
		return {
			...h,
			inner,
			callId: callIdForAriChannel(SIPD_LEG),
			legId: legIdForAriChannel("media-1"),
			async record() {
				const leg = inner.controlledLegFor("media-1");
				return await inner.control.startRecording(leg);
			},
		};
	}

	it("pauses and resumes the recorded leg of a call named only by its call id", async () => {
		const h = recordingHarness();
		expect((await h.record()).result).toMatchObject({ ok: true });

		const paused = await h.inner.controlCallRecording({
			orgId: ORG,
			callId: h.callId,
			verb: "pauseRecord",
		});

		// The caller gave no `legId` — it has the CALL, which is what the channels bucket and the CDR
		// are keyed by — and the engine resolved the one leg the recorder is attached to.
		expect(paused).toMatchObject({ ok: true, legId: h.legId, recording: true, paused: true });
		expect(h.inner.control.recordingFor("media-1")?.paused).toBe(true);

		const resumed = await h.inner.controlCallRecording({
			orgId: ORG,
			callId: h.callId,
			verb: "resumeRecord",
		});
		expect(resumed).toMatchObject({ ok: true, recording: true, paused: false });
	});

	it("mirrors the recorder's state onto the channels bucket so a live surface can see it", async () => {
		const h = recordingHarness();
		await h.record();
		await h.inner.controlCallRecording({ orgId: ORG, callId: h.callId, verb: "pauseRecord" });

		const key = `${ORG}.${h.callId}.${h.legId}`;
		expect(h.kv.get(key)?.flags).toContain("recording");
		expect(h.kv.get(key)?.flags).toContain("recording-paused");

		await h.inner.controlCallRecording({ orgId: ORG, callId: h.callId, verb: "resumeRecord" });
		expect(h.kv.get(key)?.flags).toContain("recording");
		expect(h.kv.get(key)?.flags).not.toContain("recording-paused");
	});

	/**
	 * BOTH legs of the call, not only the one the recorder is attached to.
	 *
	 * A conversation recording covers the two parties, and the surface that has to draw the indicator
	 * is the softphone of whoever is ON the call — which reads its OWN `channels` row. Stamping the
	 * recorded leg alone left the agent's row saying `flags: ["answered"]` while a recorder was
	 * demonstrably running, so the control was never drawn however well the pause worked.
	 */
	it("stamps the recording flags on the bridged peer too, which is the row the softphone reads", async () => {
		const h = recordingHarness();
		registerBLeg(h.orchestrator, "media-2", "leg-a");
		const peerLegId = legIdForAriChannel("media-2");
		const registry = (
			h.orchestrator as unknown as {
				registry: {
					byAriChannelId(id: string): { setVariable(name: string, value: string): void };
				};
			}
		).registry;
		registry.byAriChannelId("media-1")?.setVariable("OPTIMIQ_BRIDGE_PEER_LEG_ID", peerLegId);

		await h.record();

		const peerKey = `${ORG}.${h.callId}.${peerLegId}`;
		expect(h.kv.get(peerKey)?.flags).toContain("recording");

		await h.inner.controlCallRecording({ orgId: ORG, callId: h.callId, verb: "pauseRecord" });
		expect(h.kv.get(peerKey)?.flags).toContain("recording-paused");

		await h.inner.controlCallRecording({ orgId: ORG, callId: h.callId, verb: "resumeRecord" });
		expect(h.kv.get(peerKey)?.flags).toContain("recording");
		expect(h.kv.get(peerKey)?.flags).not.toContain("recording-paused");
	});

	it("answers another tenant's call id exactly as one that never existed", async () => {
		const h = recordingHarness();
		await h.record();

		const foreign = await h.inner.controlCallRecording({
			orgId: "0195c0f0-1c2f-7000-8000-0000000000ff",
			callId: h.callId,
			verb: "pauseRecord",
		});
		const absent = await h.inner.controlCallRecording({
			orgId: ORG,
			callId: "0195c0f0-1c2f-7000-8000-0000000000fe",
			verb: "pauseRecord",
		});

		// Byte for byte the same refusal. A caller who could tell them apart could enumerate another
		// tenant's live calls one guess at a time.
		expect(foreign).toEqual(absent);
		expect(foreign.reason).toBe("unknown-call");
	});

	it("refuses a call that is here and is not being recorded", async () => {
		const h = recordingHarness();

		const refused = await h.inner.controlCallRecording({
			orgId: ORG,
			callId: h.callId,
			verb: "pauseRecord",
		});

		expect(refused).toMatchObject({ ok: false, reason: "not-recording", recording: false });
	});

	it("tells a caller working from a stale channels entry to re-read it", async () => {
		const h = recordingHarness();
		await h.record();
		// The window between a failover and an adoption: the leg is still in this instance's registry
		// and the snapshot names its new owner.
		const aggregate = (
			h.orchestrator as unknown as {
				registry: { byAriChannelId(id: string): { setVariable(n: string, v: string): void } };
			}
		).registry.byAriChannelId("media-1");
		aggregate?.setVariable("OPTIMIQ_ENGINE_INSTANCE_ID", "engine-other");

		const refused = await h.inner.controlCallRecording({
			orgId: ORG,
			callId: h.callId,
			verb: "pauseRecord",
		});

		expect(refused).toMatchObject({ ok: false, reason: "wrong_instance" });
	});
});
