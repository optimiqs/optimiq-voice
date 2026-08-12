import { beforeEach, describe, expect, it } from "bun:test";
import { parseAriEvent } from "@optimiq-voice/media-ari";
import { makeFakeMediaPort } from "../media/media-port.fake";
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
		ENGINE_PROMPT_MEDIA_PREFIX: "sound:",
		ENGINE_UNAVAILABLE_ANNOUNCEMENT: "sound:unavailable",
		ENGINE_VOICEMAIL_GREETING: "sound:unavailable",
		ENGINE_RECORDING_FORMAT: "wav",
		...overrides,
	} as EngineEnv;
}

interface HarnessOptions {
	readonly snapshots?: readonly ChannelSnapshot[];
	readonly cdrFailures?: number;
	readonly persistFailures?: number;
	readonly channelKv?: Map<string, ChannelSnapshot>;
	readonly claimResult?: "claimed" | "owned" | "unavailable";
	readonly renewResult?: "renewed" | "lost" | "unavailable";
	readonly beforeEventPublish?: (type: string) => Promise<void>;
	/** A did-index that answers, for the one path where attribution is not stamped on the leg. */
	readonly didIndex?: DidIndexSource;
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
		media,
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
		media,
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
		expect(h.cdrs[0]?.id).toBe(stableId);
		expect(h.cdrs[0]?.data.id).toBe(stableId);
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
