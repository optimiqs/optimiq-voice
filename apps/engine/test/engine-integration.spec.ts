// Nest's DI reads design-time type metadata, which only exists once this shim is loaded.
// `main.ts` does it for the real process; a suite that builds the module graph itself has to do
// it too, and BEFORE `@nestjs/core` is imported — otherwise the container comes up with no
// constructor metadata and the failure is a silent exit rather than an exception.
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { connect, type NatsConnection, type Subscription } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import {
	AGENT_STATE_KV,
	CHANNELS_KV,
	DID_INDEX_KV,
	ensureKvBuckets,
	kvKeyFor,
	PARK_CLAIMS_KV,
	parkClaimSchema,
	QUEUE_MEMBERSHIP_KV,
	ROUTING_CACHE_KV,
	parseSubject,
	safeValidateEvent,
	sipTransferResponseSchema,
	subjectFilterFor,
	subjectFor,
} from "@optimiq-voice/events";
import { ROUTING_ARTIFACT_VERSION, routingCacheKey } from "@optimiq-voice/routing";
import { AppModule } from "../src/app.module";
import { CallControl } from "../src/calls/call-control";
import { callIdForAriChannel, legIdForAriChannel } from "../src/calls/channel-identity";
import { ChannelOrchestrator } from "../src/calls/channel-orchestrator.service";
import { ParkHandoffError } from "../src/calls/park-handoff";
import { AriConnectionService } from "../src/media/ari-connection.service";
import { makeFakeMediaPort } from "../src/media/media-port.fake";
import { KvClaimBucket } from "../src/nats/claim-store";
import { ParkHandoffService } from "../src/nats/park-handoff.service";
import { CallSignalBus } from "../src/routing/call-signals";
import { ParkRegistry } from "../src/routing/park-registry";
import type { CallControlHost, ControlledLeg, ParkLot } from "../src/calls/call-control";
import type { EngineEnv } from "../src/config/engine-env";
import type { JetStreamService } from "../src/nats/jetstream.service";
import type { AnyEventEnvelope, ParkClaim, SipTransferRequest } from "@optimiq-voice/events";
import type { PlanNode, RoutingArtifact } from "@optimiq-voice/routing";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

/**
 * The parity gate: real inbound calls through a real Asterisk 22 and a real NATS JetStream.
 *
 * ```sh
 * # from the repository root
 * pnpm --filter @optimiq-voice/engine test:integration
 * ```
 *
 * It starts `nats:2.11-alpine -js` and an `apps/asterisk` container, seeds a routing artifact
 * straight into the `routing-cache` KV bucket, boots the engine against both, and drives calls
 * into the `optimiq-inbound` dialplan context. It asserts:
 *
 * - the P2 substrate: `calls.evt.v1.<org>.<call>.*` in order, schema-valid, on the right subject;
 *   the `channels` KV entry appearing and clearing; exactly one `cdr.leg.write` per leg;
 * - the P3 routing chain: DID → inbound resolve → IVR → (timeout branch) → extension → an
 *   originated B-leg → `channel.bridged`, with the CDR carrying `destinationType: "extension"`.
 * - the ACD chain: DID → queue → the `queue-membership` roster → the `agent-state` bucket → an
 *   agent leg dialled from the roster's contact → `channel.bridged`, with
 *   `queue.evt.v1.<org>.<queue>.caller.{joined,answered}` observed in order on a subscription no
 *   engine code owns; and the abandonment case, where a roster whose agents are all logged out
 *   ejects the caller on `maxWaitNoAgentSeconds` with `reason: "no-agents"`.
 *
 * The artifact is seeded into KV DIRECTLY rather than through `apps/api`'s seed script: this suite
 * exists to prove the engine consumes the artifact contract, and standing up Postgres, RLS and the
 * control plane to obtain the same bytes would make an engine test fail for control-plane reasons.
 *
 * `extension` nodes resolve to `Local/{number}@optimiq-loopback` (a context that answers), because
 * a test that needed a registered softphone in CI is a test nobody runs.
 *
 * Only containers this file started are removed; an externally-supplied broker or Asterisk (via
 * `NATS_INTEGRATION_URL` / `ARI_INTEGRATION_URL`) is left alone.
 */

const ENABLED = process.env.RUN_ENGINE_INTEGRATION_TESTS === "true";

const NATS_EXTERNAL = process.env.NATS_INTEGRATION_URL;
const ARI_EXTERNAL = process.env.ARI_INTEGRATION_URL;

const PID = String(process.pid);
const NATS_CONTAINER = `optimiq-engine-it-nats-${PID}`;
const ASTERISK_CONTAINER = `optimiq-engine-it-asterisk-${PID}`;
const ASTERISK_IMAGE = `optimiq-voice/asterisk-it:${PID}`;

/**
 * A per-process slot, so two runs of this suite can be in flight at once.
 *
 * The container NAMES have always carried the pid; the host ports did not, which made that
 * precaution ineffective — a second run died in `beforeAll` on `Bind for 0.0.0.0:4225 failed: port
 * is already allocated`, and did so before a single test executed. That failure reads as "0 pass, 1
 * fail" and is worth recognising on sight, because it looks nothing like a test failing.
 *
 * Fifty slots rather than a free-port search: the search is three sockets and a race of its own,
 * and this suite is run by a developer and by CI, neither of which has fifty copies of it going.
 */
const PORT_SLOT = process.pid % 50;
const NATS_PORT = 4225 + PORT_SLOT;
const ARI_PORT = 8189 + PORT_SLOT;
const ENGINE_PORT = 4019 + PORT_SLOT;

const ARI_USERNAME = "ari";
const ARI_PASSWORD = "engine-integration-secret";
const ARI_APP = "optimiq-engine-it";
/** A valid UUID v7, so it passes the wire contract's `orgId` check. */
const ORG_ID = "0195c0f0-1c2f-7000-8000-0000000000aa";
const EXTENSION_ID = "0195c0f0-1c2f-7000-8000-0000000000e1";
const IVR_ID = "0195c0f0-1c2f-7000-8000-0000000000e2";
/** A DID the seeded artifact routes, and one it does not. */
const ROUTED_DID = "12125550100";
const UNROUTED_DID = "19998887777";

/**
 * A SECOND tenant, with its own DID and its own artifact.
 *
 * Its whole purpose is the multi-tenant case: a call for this number arrives on a context that
 * stamps no organization, and `ENGINE_DEFAULT_ORGANIZATION_ID` points at the FIRST tenant. If the
 * engine attributed by the fallback, this call would be filed under org A — which is precisely the
 * failure the `did-index` bucket exists to prevent, and precisely what a single assertion on the
 * CDR's `orgId` catches.
 */
const ORG_ID_B = "0195c0f0-1c2f-7000-8000-0000000000ab";
const EXTENSION_ID_B = "0195c0f0-1c2f-7000-8000-0000000000e3";
const ROUTED_DID_B = "12125550200";

/**
 * The ACD fixtures.
 *
 * `QUEUE_ID` is staffed by one agent whose contact dials the loopback context, so the agent leg
 * actually answers without a registered softphone — the same trick the extension nodes use.
 * `EMPTY_QUEUE_ID` has a roster with nobody logged in, which is what exercises the abandonment
 * path: `maxWaitNoAgentSeconds` ejects the caller in two seconds instead of ten minutes.
 */
const QUEUE_ID = "0195c0f0-1c2f-7000-8000-0000000000f1";
const EMPTY_QUEUE_ID = "0195c0f0-1c2f-7000-8000-0000000000f2";
const QUEUE_AGENT_ID = "0195c0f0-1c2f-7000-8000-0000000000f3";
const IDLE_AGENT_ID = "0195c0f0-1c2f-7000-8000-0000000000f4";
const QUEUE_DID = "12125550300";
const EMPTY_QUEUE_DID = "12125550400";

/**
 * A conference room, with no PIN.
 *
 * No PIN on purpose: the PIN gate is a pure decision over a digest and
 * `plan-walker-conference.spec.ts` proves every branch of it against a real scrypt verification.
 * What only a real Asterisk can prove is the other half — that `createBridge` + `addToBridge`
 * against a live ARI actually puts a leg into a mixing bridge, and that the join/leave pair is
 * published around it. Adding a PIN here would mean generating inbound DTMF into a Local channel,
 * which is the flakiest thing this harness can do and would prove nothing the unit suite does not.
 */
const CONFERENCE_ID = "0195c0f0-1c2f-7000-8000-0000000000f5";
const CONFERENCE_DID = "12125550500";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The demo tenant's routing, as the compiler would have produced it.
 *
 * `+DID → IVR "Main menu" → (no digit, no retries) → extension 1001`. The timeout branch rather
 * than a DTMF press is what makes the assertion deterministic: generating inbound DTMF into a
 * Local channel means locating its `;2` half and racing the greeting, which tests the harness
 * rather than the engine. The digit path is covered exhaustively by `plan-walker.spec.ts`.
 */
function seedArtifact(): RoutingArtifact {
	const nodes: PlanNode[] = [
		{ id: "hangup:UNALLOCATED_NUMBER", kind: "hangup", cause: "UNALLOCATED_NUMBER" },
		{ id: "hangup:NORMAL_CLEARING", kind: "hangup", cause: "NORMAL_CLEARING" },
		{ id: "hangup:OUTGOING_CALL_BARRED", kind: "hangup", cause: "OUTGOING_CALL_BARRED" },
		{
			id: `extension:${EXTENSION_ID}`,
			kind: "extension",
			extensionId: EXTENSION_ID,
			number: "1001",
			tollClass: "internal",
			recordPolicy: "none",
			timeoutSeconds: 20,
			doNotDisturb: false,
		} as PlanNode,
		{
			id: `ivr-menu:${IVR_ID}`,
			kind: "ivr-menu",
			ivrMenuId: IVR_ID,
			greetingPromptId: "unavailable",
			digitTimeoutMs: 1_500,
			interDigitTimeoutMs: 1_000,
			maxDigits: 1,
			maxFailures: 0,
			maxTimeouts: 0,
			directDialEnabled: false,
			options: [
				{
					ordinal: 0,
					pattern: { kind: "exact", value: "1" },
					matchValue: "1",
					targetNodeId: `extension:${EXTENSION_ID}`,
				},
			],
			timeoutNodeId: `extension:${EXTENSION_ID}`,
		} as PlanNode,
		{
			id: `queue:${QUEUE_ID}`,
			kind: "queue",
			queueId: QUEUE_ID,
			// One at a time: `ring-all` with a single agent proves nothing extra, and `top-down`
			// makes "which agent rang" an assertion rather than a race.
			strategy: "top-down",
			maxWaitSeconds: 60,
			maxWaitNoAgentSeconds: 0,
			announcePositionEnabled: false,
			announceFrequencySeconds: 60,
			recordEnabled: false,
			timeoutNodeId: "hangup:NORMAL_CLEARING",
		} as PlanNode,
		{
			id: `conference:${CONFERENCE_ID}`,
			kind: "conference",
			conferenceId: CONFERENCE_ID,
			roomNumber: "3001",
			requiresPin: false,
			maxMembers: 0,
			waitForModerator: false,
			recordEnabled: false,
		} as PlanNode,
		{
			id: `queue:${EMPTY_QUEUE_ID}`,
			kind: "queue",
			queueId: EMPTY_QUEUE_ID,
			strategy: "longest-idle",
			maxWaitSeconds: 600,
			// The whole point of this node: a roster with nobody logged in ejects fast.
			maxWaitNoAgentSeconds: 2,
			announcePositionEnabled: false,
			announceFrequencySeconds: 60,
			recordEnabled: false,
			timeoutNodeId: "hangup:NORMAL_CLEARING",
		} as PlanNode,
	];

	return {
		artifactVersion: ROUTING_ARTIFACT_VERSION,
		organizationId: ORG_ID,
		snapshotHash: "integration-seed-1",
		compiledAt: new Date().toISOString(),
		settings: {},
		nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
		timeConditions: {},
		inbound: {
			rules: [],
			didDefaults: {
				[ROUTED_DID]: {
					phoneNumberId: "0195c0f0-1c2f-7000-8000-0000000000d1",
					e164: ROUTED_DID,
					enabled: true,
					recordEnabled: false,
					destinationNodeId: `ivr-menu:${IVR_ID}`,
				},
				[QUEUE_DID]: {
					phoneNumberId: "0195c0f0-1c2f-7000-8000-0000000000d3",
					e164: QUEUE_DID,
					enabled: true,
					recordEnabled: false,
					destinationNodeId: `queue:${QUEUE_ID}`,
				},
				[EMPTY_QUEUE_DID]: {
					phoneNumberId: "0195c0f0-1c2f-7000-8000-0000000000d4",
					e164: EMPTY_QUEUE_DID,
					enabled: true,
					recordEnabled: false,
					destinationNodeId: `queue:${EMPTY_QUEUE_ID}`,
				},
				[CONFERENCE_DID]: {
					phoneNumberId: "0195c0f0-1c2f-7000-8000-0000000000d5",
					e164: CONFERENCE_DID,
					enabled: true,
					recordEnabled: false,
					destinationNodeId: `conference:${CONFERENCE_ID}`,
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
			enabled: false,
			rules: [],
			noMatchNodeId: "hangup:UNALLOCATED_NUMBER",
			deniedNodeId: "hangup:OUTGOING_CALL_BARRED",
		},
		callBlock: [],
		extensionsByNumber: {},
		diagnostics: [],
	} as unknown as RoutingArtifact;
}

function docker(...args: readonly string[]): string {
	const result = spawnSync("docker", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.status !== 0) {
		throw new Error(
			`docker ${args.join(" ")} failed (${String(result.status)}): ${result.stderr || result.stdout}`,
		);
	}
	return result.stdout.trim();
}

function tryDocker(...args: readonly string[]): void {
	spawnSync("docker", [...args], { encoding: "utf8" });
}

async function waitFor(
	label: string,
	probe: () => Promise<boolean>,
	timeoutMs: number,
	/** Extra context for the failure message. A timeout with no evidence costs an hour. */
	detail?: () => string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			if (await probe()) {
				return;
			}
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(
		`${label} never became ready${lastError === undefined ? "" : `: ${String(lastError)}`}` +
			`${detail === undefined ? "" : ` — ${detail()}`}`,
	);
}

interface Received {
	readonly subject: string;
	readonly envelope: AnyEventEnvelope;
}

const suite = ENABLED ? describe : describe.skip;

suite("engine end-to-end", () => {
	let app: NestFastifyApplication;
	let nats: NatsConnection;
	let callSubscription: Subscription;
	let cdrSubscription: Subscription;
	let queueSubscription: Subscription;
	const callEvents: Received[] = [];
	const cdrEvents: Received[] = [];
	const queueEvents: Received[] = [];
	const invalid: string[] = [];
	let startedNats = false;
	let startedAsterisk = false;
	let ariBaseUrl: string;
	let natsUrl: string;

	/** What the observer actually saw, for a timeout that would otherwise say nothing. */
	const describeObserved = (): string =>
		`observed calls=[${callEvents.map((event) => event.envelope.type).join(", ")}] ` +
		`queue=[${queueEvents.map((event) => event.envelope.type).join(", ")}] ` +
		`cdrs=${String(cdrEvents.length)} rejected=[${invalid.join(" | ")}]`;

	beforeAll(async () => {
		if (NATS_EXTERNAL !== undefined && NATS_EXTERNAL !== "") {
			natsUrl = NATS_EXTERNAL;
		} else {
			docker(
				"run",
				"-d",
				"--rm",
				"--name",
				NATS_CONTAINER,
				"-p",
				`${String(NATS_PORT)}:4222`,
				"nats:2.11-alpine",
				"-js",
			);
			startedNats = true;
			natsUrl = `nats://127.0.0.1:${String(NATS_PORT)}`;
		}

		if (ARI_EXTERNAL !== undefined && ARI_EXTERNAL !== "") {
			ariBaseUrl = ARI_EXTERNAL;
		} else {
			docker("build", "-t", ASTERISK_IMAGE, `${import.meta.dir}/../../asterisk`);
			docker(
				"run",
				"-d",
				"--rm",
				"--name",
				ASTERISK_CONTAINER,
				"-p",
				`${String(ARI_PORT)}:8088`,
				"-e",
				`ARI_USERNAME=${ARI_USERNAME}`,
				"-e",
				`ARI_SECRET=${ARI_PASSWORD}`,
				"-e",
				"ARI_PROXY_URL=http://127.0.0.1:8088",
				// `run.sh` refuses to start without ALL of these — its required-variable check is a
				// single `||` chain, so one unset value fails the lot. They are placeholders: this
				// suite never registers to a SIP proxy, and the RTP range is never used.
				"-e",
				"RTP_PORT_START=10000",
				"-e",
				"RTP_PORT_END=10010",
				"-e",
				"SIPPROXY_HOST=127.0.0.1",
				"-e",
				"SIPPROXY_USERNAME=integration",
				"-e",
				"SIPPROXY_SECRET=integration",
				// What the Optimiq contexts read with ${ENV(...)}.
				"-e",
				`OPTIMIQ_ARI_APP=${ARI_APP}`,
				"-e",
				`OPTIMIQ_DEV_ORG_ID=${ORG_ID}`,
				ASTERISK_IMAGE,
			);
			startedAsterisk = true;
			ariBaseUrl = `http://127.0.0.1:${String(ARI_PORT)}`;
		}

		// The artifact goes into KV BEFORE the engine boots, so the first call is a cache hit and
		// the suite is not asserting against the RPC path (which needs `apps/api`).
		await seedRoutingArtifact(natsUrl);

		// The engine reads its configuration through `@optimiq-voice/config`'s env view, so the
		// suite sets the variables before the module graph is built.
		Object.assign(process.env, {
			NODE_ENV: "test",
			ENGINE_PORT: String(ENGINE_PORT),
			ENGINE_HOST: "127.0.0.1",
			ARI_URL: ariBaseUrl,
			ARI_USERNAME,
			ARI_PASSWORD,
			ARI_APP,
			NATS_URL: natsUrl,
			ENGINE_ENSURE_STREAMS: "true",
			ENGINE_DEFAULT_ORGANIZATION_ID: ORG_ID,
			ENGINE_DRAIN_TIMEOUT_MS: "5000",
			ENGINE_ROUTING_ENABLED: "true",
			// A dial target that answers, so `extension` nodes resolve without a softphone.
			//
			// `/n` disables Local-channel OPTIMIZATION. Without it Asterisk masquerades the Local
			// pair out of the path once both ends are bridged, the channel ids the suite is holding
			// stop existing, and a hangup addressed to one of them is a tolerated 404 against a call
			// that stays up until the test times out.
			ENGINE_EXTENSION_DIAL_TEMPLATE: "Local/{number}@optimiq-loopback/n",
		});

		await waitFor(
			"asterisk ARI",
			async () => {
				const response = await fetch(`${ariBaseUrl}/ari/asterisk/info`, {
					headers: {
						authorization: `Basic ${Buffer.from(`${ARI_USERNAME}:${ARI_PASSWORD}`).toString("base64")}`,
					},
				});
				return response.ok;
			},
			180_000,
		);

		app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
			logger: false,
		});
		await app.listen({ port: ENGINE_PORT, host: "127.0.0.1" });

		const ari = app.get(AriConnectionService);
		const orchestrator = app.get(ChannelOrchestrator);
		ari.setEventHandler((event) => {
			void orchestrator.handleEvent(event);
		});
		await ari.start();

		// An INDEPENDENT connection, so the assertions observe what a real consumer would see
		// rather than the engine's own client.
		nats = await connect({
			servers: natsUrl,
			name: "engine-integration-observer",
			...harnessNatsOptions(),
		});
		callSubscription = nats.subscribe(subjectFilterFor.allCalls());
		cdrSubscription = nats.subscribe(subjectFilterFor.allCdrLegs());
		queueSubscription = nats.subscribe(subjectFilterFor.allQueues());

		void (async () => {
			for await (const message of callSubscription) {
				collect(message.subject, decoder.decode(message.data), callEvents, invalid);
			}
		})();
		void (async () => {
			for await (const message of cdrSubscription) {
				collect(message.subject, decoder.decode(message.data), cdrEvents, invalid);
			}
		})();
		void (async () => {
			for await (const message of queueSubscription) {
				collect(message.subject, decoder.decode(message.data), queueEvents, invalid);
			}
		})();
	}, 300_000);

	afterAll(async () => {
		callSubscription?.unsubscribe();
		cdrSubscription?.unsubscribe();
		queueSubscription?.unsubscribe();
		await nats?.close();
		await app?.close();
		if (startedAsterisk) {
			tryDocker("rm", "-f", ASTERISK_CONTAINER);
			tryDocker("rmi", "-f", ASTERISK_IMAGE);
		}
		if (startedNats) {
			tryDocker("rm", "-f", NATS_CONTAINER);
		}
	});

	it("reports healthy once ARI and NATS are both up", async () => {
		const response = await fetch(`http://127.0.0.1:${String(ENGINE_PORT)}/healthz`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			status: string;
			ari: { connected: boolean };
			park: { listening: boolean; subject: string; served: number };
		};
		expect(body.status).toBe("ok");
		expect(body.ari.connected).toBe(true);

		// The park section, against a REAL container graph. `health.controller.spec.ts` proves the
		// payload; only this proves the controller can obtain `ParkHandoffService` at all — it comes
		// from a different module than every other dependency the report reads, and a provider Nest
		// cannot resolve is a boot failure, not a wrong field.
		expect(body.park.subject).toBe(subjectFor.engineParkHandoffRpc("engine"));
		expect(body.park.served).toBe(0);
		// Listening, because this run has a `park-claims` bucket: `ENGINE_ENSURE_STREAMS` created it.
		expect(body.park.listening).toBe(true);
	});

	it("routes a DID through an IVR to an extension, bridges it, and files the CDR", async () => {
		const ari = app.get(AriConnectionService);
		const orchestrator = app.get(ChannelOrchestrator);
		const callerChannelId = `engine-it-caller-${String(Date.now())}`;

		callEvents.length = 0;
		cdrEvents.length = 0;

		// The A-leg is the Local channel's dialplan half, which enters `optimiq-inbound` and is
		// handed to Stasis with OPTIMIQ_ORG_ID already set. The originating half is parked in
		// `optimiq-loopback` so it answers and stays up while the routing walk runs.
		await ari.client.channels.originate({
			endpoint: `Local/${ROUTED_DID}@optimiq-inbound/n`,
			context: "optimiq-loopback",
			extension: "8000",
			priority: 1,
			channelId: callerChannelId,
			timeoutSeconds: 30,
		});

		// --- the leg is live: the KV mirror must exist ----------------------------------------
		await waitFor(
			"channel.created",
			async () => callEvents.some((event) => event.envelope.type === "channel.created"),
			30_000,
			describeObserved,
		);

		const created = callEvents.find((event) => event.envelope.type === "channel.created");
		const callId = subjectCallId(created?.subject ?? "");
		const legId = (created?.envelope.data as { legId: string }).legId;
		expect(created?.envelope.data).toMatchObject({ to: { number: ROUTED_DID } });

		const liveKv = await readKv(natsUrl, kvKeyFor.channel(ORG_ID, callId, legId));
		expect(liveKv).toBeDefined();
		expect(liveKv?.organizationId).toBe(ORG_ID);
		expect(liveKv?.channelId).toBe(legId);
		expect(orchestrator.activeChannelCount).toBeGreaterThan(0);

		// --- the routing walk: answer, IVR greeting, timeout branch, extension, bridge ---------
		await waitFor(
			"channel.bridged",
			async () => callEvents.some((event) => event.envelope.type === "channel.bridged"),
			40_000,
			describeObserved,
		);

		const bridged = callEvents.find((event) => event.envelope.type === "channel.bridged");
		expect(bridged?.envelope.data).toMatchObject({ legId, mode: "media" });

		// The B-leg the walker originated reached the loopback context and answered, so the
		// mirrored snapshot now names a bridge.
		const bridgedKv = await readKv(natsUrl, kvKeyFor.channel(ORG_ID, callId, legId));
		expect(bridgedKv?.bridgeId).toBeDefined();
		expect(bridgedKv?.variables.OPTIMIQ_DESTINATION_TYPE).toBe("extension");
		expect(bridgedKv?.variables.OPTIMIQ_DESTINATION_REF).toBe(EXTENSION_ID);

		// --- tear it down ---------------------------------------------------------------------
		await ari.client.channels.hangup(callerChannelId, { causeCode: 16 });

		await waitFor(
			"channel.destroyed",
			async () => callEvents.some((event) => event.envelope.type === "channel.destroyed"),
			30_000,
			describeObserved,
		);
		await waitFor("cdr.leg.write", async () => cdrEvents.length > 0, 30_000, describeObserved);

		// --- ordering -------------------------------------------------------------------------
		const order = callEvents.map((event) => event.envelope.type);
		expect(order[0]).toBe("channel.created");
		expect(order.at(-1)).toBe("channel.destroyed");
		expect(order.indexOf("channel.answered")).toBeGreaterThan(order.indexOf("channel.created"));
		expect(order.indexOf("channel.bridged")).toBeGreaterThan(order.indexOf("channel.answered"));
		expect(order.indexOf("channel.hangup")).toBeGreaterThan(order.indexOf("channel.bridged"));
		expect(order.indexOf("channel.hangup")).toBeLessThan(order.indexOf("channel.destroyed"));

		// Every event landed on its own call's subject, and every one validated. Reported as a
		// LIST rather than as a loop of assertions: "one of these seventeen is on another call's
		// subject" is only actionable if the failure names which.
		expect(
			callEvents
				.filter((event) => event.subject !== subjectFor.call(ORG_ID, callId, event.envelope.type))
				.map((event) => event.subject),
		).toEqual([]);
		expect(callEvents.map((event) => event.envelope.orgId)).toEqual(callEvents.map(() => ORG_ID));
		expect(invalid).toEqual([]);

		// --- the CDRs, enriched with where the call actually went ------------------------------
		//
		// TWO records, not one: the caller's leg and the leg the engine dialled. This assertion used
		// to read `toHaveLength(1)`, which was an accurate description of a gap — everything about
		// the callee's leg was unanswerable from the caller's row.
		await waitFor("both legs' CDRs", async () => cdrEvents.length >= 2, 30_000, describeObserved);
		expect(cdrEvents).toHaveLength(2);
		const cdr = cdrEvents.find((event) => (event.envelope.data as { leg: string }).leg === "a");
		const bLegCdr = cdrEvents.find((event) => (event.envelope.data as { leg: string }).leg === "b");
		expect(cdr?.subject).toBe(subjectFor.cdrLeg(ORG_ID));
		expect(bLegCdr?.subject).toBe(subjectFor.cdrLeg(ORG_ID));
		expect(bLegCdr?.envelope.data).toMatchObject({
			callId,
			leg: "b",
			toNumber: "1001",
			destinationType: "extension",
			destinationRef: EXTENSION_ID,
		});
		expect((bLegCdr?.envelope.data as { originatingLegId?: string }).originatingLegId).toBe(legId);
		expect(cdr?.envelope.type).toBe("cdr.leg.write");
		expect(cdr?.envelope.data).toMatchObject({
			callId,
			leg: "a",
			direction: "inbound",
			disposition: "answered",
			toNumber: ROUTED_DID,
			destinationType: "extension",
			destinationRef: EXTENSION_ID,
		});

		// --- the KV entry is gone --------------------------------------------------------------
		await waitFor(
			"KV entry cleared",
			async () => (await readKv(natsUrl, kvKeyFor.channel(ORG_ID, callId, legId))) === undefined,
			15_000,
			describeObserved,
		);
		expect(orchestrator.activeChannelCount).toBe(0);
	}, 180_000);

	/**
	 * The ACD path, end to end.
	 *
	 * A DID whose plan node is a `queue`, a roster in the `queue-membership` bucket, an agent marked
	 * `available` in `agent-state`, and a caller who ends up bridged to them. What is being proven is
	 * the whole chain the pure suites cannot reach: that the engine READS both buckets over real
	 * NATS, that the agent leg is a real Asterisk channel dialled from the roster's contact string,
	 * that the queue events land on `queue.evt.v1.<org>.<queue>.*` in order and pass their own
	 * schema, and that the agent's state machine moves in the bucket a wallboard would read.
	 */
	it("puts a queued caller on hold, rings the agent from the roster, and bridges them", async () => {
		const ari = app.get(AriConnectionService);
		const callerChannelId = `engine-it-queue-${String(Date.now())}`;

		callEvents.length = 0;
		cdrEvents.length = 0;
		queueEvents.length = 0;

		await ari.client.channels.originate({
			endpoint: `Local/${QUEUE_DID}@optimiq-inbound/n`,
			context: "optimiq-loopback",
			extension: "8000",
			priority: 1,
			channelId: callerChannelId,
			timeoutSeconds: 30,
		});

		// --- the caller joined -------------------------------------------------------------------
		await waitFor(
			"queue.caller.joined",
			async () => queueEvents.some((event) => event.envelope.type === "caller.joined"),
			40_000,
			describeObserved,
		);

		const joined = queueEvents.find((event) => event.envelope.type === "caller.joined");
		expect(joined?.subject).toBe(subjectFor.queue(ORG_ID, QUEUE_ID, "caller.joined"));
		expect(joined?.envelope.data).toMatchObject({ position: 1, priority: 0 });
		const callId = (joined?.envelope.data as { callId: string }).callId;

		// --- the agent was rung and the caller was bridged ---------------------------------------
		await waitFor(
			"queue.caller.answered",
			async () => queueEvents.some((event) => event.envelope.type === "caller.answered"),
			40_000,
			describeObserved,
		);

		const answered = queueEvents.find((event) => event.envelope.type === "caller.answered");
		expect(answered?.subject).toBe(subjectFor.queue(ORG_ID, QUEUE_ID, "caller.answered"));
		expect(answered?.envelope.data).toMatchObject({
			callId,
			agentId: QUEUE_AGENT_ID,
			strategy: "top-down",
		});
		// The wait the CALLER experienced, which is the SLA metric and must not be zero on a call
		// where a phone actually rang.
		expect((answered?.envelope.data as { waitMs: number }).waitMs).toBeGreaterThan(0);

		await waitFor(
			"channel.bridged",
			async () => callEvents.some((event) => event.envelope.type === "channel.bridged"),
			40_000,
			describeObserved,
		);

		// --- joined strictly before answered, and nothing else in between -------------------------
		const queueOrder = queueEvents
			.filter((event) => event.envelope.type.startsWith("caller."))
			.map((event) => event.envelope.type);
		expect(queueOrder).toEqual(["caller.joined", "caller.answered"]);

		// --- the agent's live state moved, and a wallboard could see it --------------------------
		const agentStatus = await readAgentState(natsUrl, ORG_ID, QUEUE_AGENT_ID);
		expect(agentStatus?.status).toBe("on-call");
		expect(agentStatus?.queueId).toBe(QUEUE_ID);
		expect(agentStatus?.source).toBe("engine");

		const agentStateEvents = queueEvents.filter((event) => event.envelope.type === "agent.state");
		expect(
			agentStateEvents.map((event) => (event.envelope.data as { status: string }).status),
		).toEqual(["ringing", "on-call"]);

		// --- the CDR names the queue as the destination, on both legs ---------------------------
		await ari.client.channels.hangup(callerChannelId, { causeCode: 16 });
		await waitFor("both legs' CDRs", async () => cdrEvents.length >= 2, 40_000, describeObserved);

		const aLeg = cdrEvents.find((event) => (event.envelope.data as { leg: string }).leg === "a");
		const bLeg = cdrEvents.find((event) => (event.envelope.data as { leg: string }).leg === "b");
		expect(aLeg?.envelope.data).toMatchObject({
			callId,
			disposition: "answered",
			destinationType: "queue",
			destinationRef: QUEUE_ID,
		});
		expect(bLeg?.envelope.data).toMatchObject({
			callId,
			leg: "b",
			destinationType: "queue",
			destinationRef: QUEUE_ID,
		});
		expect(invalid).toEqual([]);
	}, 180_000);

	/**
	 * The abandonment path.
	 *
	 * A queue with a roster whose only agent is logged out. `maxWaitNoAgentSeconds` is what has to
	 * fire — NOT `maxWaitSeconds`, which is ten minutes here precisely so that a test which passed
	 * for the wrong reason would take ten minutes to do it. The caller leaves through the queue's
	 * timeout branch, and the event says `no-agents` rather than `caller-hangup`, which is the
	 * distinction an SLA report is built on.
	 */
	it("ejects a caller from a queue nobody is staffing, and reports why", async () => {
		const ari = app.get(AriConnectionService);
		const callerChannelId = `engine-it-queue-empty-${String(Date.now())}`;

		callEvents.length = 0;
		cdrEvents.length = 0;
		queueEvents.length = 0;

		await ari.client.channels.originate({
			endpoint: `Local/${EMPTY_QUEUE_DID}@optimiq-inbound/n`,
			context: "optimiq-loopback",
			extension: "8000",
			priority: 1,
			channelId: callerChannelId,
			timeoutSeconds: 30,
		});

		await waitFor(
			"queue.caller.abandoned",
			async () => queueEvents.some((event) => event.envelope.type === "caller.abandoned"),
			40_000,
			describeObserved,
		);

		const abandoned = queueEvents.find((event) => event.envelope.type === "caller.abandoned");
		expect(abandoned?.subject).toBe(subjectFor.queue(ORG_ID, EMPTY_QUEUE_ID, "caller.abandoned"));
		expect(abandoned?.envelope.data).toMatchObject({ reason: "no-agents", position: 1 });
		// Ejected on the no-agent deadline (2 s), nowhere near the 600 s maximum wait.
		expect((abandoned?.envelope.data as { waitMs: number }).waitMs).toBeLessThan(60_000);

		// Nobody's phone rang: an agent who is logged out is not a candidate, so there is no B-leg.
		expect(
			callEvents.filter(
				(event) =>
					event.envelope.type === "channel.created" &&
					(event.envelope.data as { leg: string }).leg === "b",
			),
		).toEqual([]);

		await tryHangup(ari, callerChannelId);
		await waitFor("cdr.leg.write", async () => cdrEvents.length > 0, 40_000, describeObserved);
		const aLeg = cdrEvents.find((event) => (event.envelope.data as { leg: string }).leg === "a");
		expect(aLeg?.envelope.data).toMatchObject({
			destinationType: "queue",
			destinationRef: EMPTY_QUEUE_ID,
		});
		expect(invalid).toEqual([]);
	}, 180_000);

	/**
	 * A conference room, against a real ARI mixing bridge.
	 *
	 * The unit suite proves the PIN gate, the moderator distinction, `waitForModerator` and
	 * `maxMembers` against a fake port. What only this can prove is that the two media primitives
	 * the runtime is built on — `POST /bridges` with a client-assigned id, then
	 * `POST /bridges/{id}/addChannel` — actually work against a live Asterisk, and that the
	 * join/leave pair is published around them and validates against its own schema.
	 *
	 * One caller, not two: a second Local channel would double the flakiest part of this harness to
	 * prove a member count the registry's own spec already asserts.
	 */
	it("joins a caller to a real mixing bridge and publishes the conference pair", async () => {
		const ari = app.get(AriConnectionService);
		const callerChannelId = `engine-it-conference-${String(Date.now())}`;

		callEvents.length = 0;
		cdrEvents.length = 0;

		await ari.client.channels.originate({
			endpoint: `Local/${CONFERENCE_DID}@optimiq-inbound/n`,
			context: "optimiq-loopback",
			extension: "8000",
			priority: 1,
			channelId: callerChannelId,
			timeoutSeconds: 30,
		});

		await waitFor(
			"conference.joined",
			async () => callEvents.some((event) => event.envelope.type === "conference.joined"),
			40_000,
			describeObserved,
		);

		const joined = callEvents.find((event) => event.envelope.type === "conference.joined");
		const callId = subjectCallId(joined?.subject ?? "");
		expect(joined?.subject).toBe(subjectFor.call(ORG_ID, callId, "conference.joined"));
		expect(joined?.envelope.data).toMatchObject({
			conferenceId: CONFERENCE_ID,
			roomNumber: "3001",
			moderator: false,
			memberCount: 1,
		});

		// The bridge is a real one, and the mirrored channel snapshot names it — which is the
		// assertion that would fail if `addToBridge` had quietly not happened.
		const legId = (joined?.envelope.data as { legId: string }).legId;
		const joinedKv = await readKv(natsUrl, kvKeyFor.channel(ORG_ID, callId, legId));
		expect(joinedKv?.bridgeId).toBe((joined?.envelope.data as { bridgeId: string }).bridgeId);

		await tryHangup(ari, callerChannelId);

		await waitFor(
			"conference.left",
			async () => callEvents.some((event) => event.envelope.type === "conference.left"),
			40_000,
			describeObserved,
		);
		const left = callEvents.find((event) => event.envelope.type === "conference.left");
		// Zero remaining is what tells the walker to destroy the bridge.
		expect(left?.envelope.data).toMatchObject({ conferenceId: CONFERENCE_ID, memberCount: 0 });

		await waitFor("cdr.leg.write", async () => cdrEvents.length > 0, 40_000, describeObserved);
		const aLeg = cdrEvents.find((event) => (event.envelope.data as { leg: string }).leg === "a");
		expect(aLeg?.envelope.data).toMatchObject({
			destinationType: "conference",
			destinationRef: CONFERENCE_ID,
		});
		expect(invalid).toEqual([]);
	}, 180_000);

	it("rejects a DID the artifact does not route, and files an unrouted CDR", async () => {
		const ari = app.get(AriConnectionService);
		const callerChannelId = `engine-it-unrouted-${String(Date.now())}`;

		callEvents.length = 0;
		cdrEvents.length = 0;

		await ari.client.channels.originate({
			endpoint: `Local/${UNROUTED_DID}@optimiq-inbound/n`,
			context: "optimiq-loopback",
			extension: "8000",
			priority: 1,
			channelId: callerChannelId,
			timeoutSeconds: 30,
		});

		await waitFor("cdr.leg.write", async () => cdrEvents.length > 0, 40_000, describeObserved);

		const types = callEvents.map((event) => event.envelope.type);
		// Never answered: an unallocated number must not start billing a caller.
		expect(types).not.toContain("channel.answered");
		expect(types).toContain("channel.hangup");

		expect(cdrEvents[0]?.envelope.data).toMatchObject({
			toNumber: UNROUTED_DID,
			// The walk reached only a terminal, so there is no destination to report.
			destinationType: "unknown",
			destinationRef: null,
			billsecMs: 0,
		});

		await tryHangup(ari, callerChannelId);
	}, 120_000);

	/**
	 * The multi-tenant case, and the blocker it closes.
	 *
	 * Both calls arrive on `optimiq-inbound-untrusted`, which stamps NO organization — a carrier
	 * trunk, not a dialplan that already knows the tenant. `ENGINE_DEFAULT_ORGANIZATION_ID` is set to
	 * org A throughout this suite, so if the engine fell back to it, org B's call would be filed
	 * under org A: its events on org A's subjects, its CDR in org A's ledger, its recording in org
	 * A's bucket. Every assertion below is that it does not.
	 */
	it("attributes two tenants' DIDs to two tenants, with no organization on the channel", async () => {
		const ari = app.get(AriConnectionService);
		const orchestrator = app.get(ChannelOrchestrator);

		callEvents.length = 0;
		cdrEvents.length = 0;

		const callerA = `engine-it-tenant-a-${String(Date.now())}`;
		await ari.client.channels.originate({
			endpoint: `Local/${ROUTED_DID}@optimiq-inbound-untrusted/n`,
			context: "optimiq-loopback",
			extension: "8000",
			priority: 1,
			channelId: callerA,
			timeoutSeconds: 30,
		});
		await waitFor(
			"org A's call was created",
			async () =>
				callEvents.some(
					(event) => event.envelope.orgId === ORG_ID && event.envelope.type === "channel.created",
				),
			40_000,
			describeObserved,
		);

		const callerB = `engine-it-tenant-b-${String(Date.now())}`;
		await ari.client.channels.originate({
			endpoint: `Local/${ROUTED_DID_B}@optimiq-inbound-untrusted/n`,
			context: "optimiq-loopback",
			extension: "8000",
			priority: 1,
			channelId: callerB,
			timeoutSeconds: 30,
		});
		await waitFor(
			"org B's call was created",
			async () =>
				callEvents.some(
					(event) => event.envelope.orgId === ORG_ID_B && event.envelope.type === "channel.created",
				),
			40_000,
			describeObserved,
		);

		// Each call's events are on ITS OWN tenant's subjects, and the DID each carries is the one
		// that tenant owns. A misattribution shows up here as a `to.number` under the wrong org.
		const aCreated = callEvents.find(
			(event) => event.envelope.orgId === ORG_ID && event.envelope.type === "channel.created",
		);
		const bCreated = callEvents.find(
			(event) => event.envelope.orgId === ORG_ID_B && event.envelope.type === "channel.created",
		);
		expect(aCreated?.envelope.data).toMatchObject({ to: { number: ROUTED_DID } });
		expect(bCreated?.envelope.data).toMatchObject({ to: { number: ROUTED_DID_B } });
		expect(bCreated?.subject).toBe(
			subjectFor.call(ORG_ID_B, subjectCallId(bCreated?.subject ?? ""), "channel.created"),
		);

		// Org B's artifact dials extension 2001; org A's walks an IVR first and dials 1001. Reading
		// the DIALLED number back is what proves each call was routed by its own tenant's artifact
		// rather than by whichever one happened to be cached.
		await orchestrator.awaitWalks();
		const bDialled = callEvents.filter(
			(event) => event.envelope.orgId === ORG_ID_B && event.envelope.type === "channel.created",
		);
		expect(
			bDialled.some(
				(event) => (event.envelope.data as { to?: { number?: string } }).to?.number === "2001",
			),
		).toBe(true);

		await tryHangup(ari, callerA);
		await tryHangup(ari, callerB);

		await waitFor(
			"both tenants' CDRs",
			async () =>
				cdrEvents.some((event) => event.envelope.orgId === ORG_ID) &&
				cdrEvents.some((event) => event.envelope.orgId === ORG_ID_B),
			40_000,
			describeObserved,
		);

		// The CDR is the record that gets billed. Org B's DID must never appear in org A's ledger.
		const aLedger = cdrEvents.filter((event) => event.envelope.orgId === ORG_ID);
		const bLedger = cdrEvents.filter((event) => event.envelope.orgId === ORG_ID_B);
		expect(
			aLedger.every(
				(event) => (event.envelope.data as { toNumber: string }).toNumber !== ROUTED_DID_B,
			),
		).toBe(true);
		expect(
			bLedger.some(
				(event) => (event.envelope.data as { toNumber: string }).toNumber === ROUTED_DID_B,
			),
		).toBe(true);
		expect(bLedger[0]?.subject).toBe(subjectFor.cdrLeg(ORG_ID_B));
	}, 180_000);

	/**
	 * B-leg CDRs.
	 *
	 * Until this wave a ring-group call produced one record — the caller's — and everything about
	 * the legs the switch dialled was unanswerable from it. `call_legs` has always had the columns;
	 * this asserts they are now filled, and that the two rows of one call correlate.
	 */
	it("files a CDR for the leg it dialled, linked to the caller's", async () => {
		const ari = app.get(AriConnectionService);
		const callerChannelId = `engine-it-bleg-${String(Date.now())}`;

		callEvents.length = 0;
		cdrEvents.length = 0;

		await ari.client.channels.originate({
			endpoint: `Local/${ROUTED_DID}@optimiq-inbound/n`,
			context: "optimiq-loopback",
			extension: "8000",
			priority: 1,
			channelId: callerChannelId,
			timeoutSeconds: 30,
		});

		await waitFor(
			"the call is bridged",
			async () => callEvents.some((event) => event.envelope.type === "channel.bridged"),
			60_000,
			describeObserved,
		);

		// A `channel.created` for each side, and the B side names the extension it reached.
		const created = callEvents.filter((event) => event.envelope.type === "channel.created");
		expect(created.map((event) => (event.envelope.data as { leg: string }).leg).sort()).toEqual([
			"a",
			"b",
		]);

		await tryHangup(ari, callerChannelId);

		// Both rows OF THIS CALL. Filtering by `callId` rather than taking the first two matters:
		// the suite's earlier calls are still tearing down, and a pair assembled across two calls
		// would assert exactly the correlation bug this test exists to catch — in reverse.
		const legsOfOneCall = (): readonly Record<string, unknown>[] => {
			const rows = cdrEvents.map((event) => event.envelope.data as Record<string, unknown>);
			const byCall = new Map<string, Record<string, unknown>[]>();
			for (const row of rows) {
				const key = String(row.callId);
				byCall.set(key, [...(byCall.get(key) ?? []), row]);
			}
			for (const group of byCall.values()) {
				if (group.some((row) => row.leg === "a") && group.some((row) => row.leg === "b")) {
					return group;
				}
			}
			return [];
		};

		await waitFor(
			"both legs' CDRs, on one call",
			async () => legsOfOneCall().length >= 2,
			60_000,
			describeObserved,
		);

		const rows = legsOfOneCall();
		const aLeg = rows.find((row) => row.leg === "a");
		const bLeg = rows.find((row) => row.leg === "b");
		expect(aLeg).toBeDefined();
		expect(bLeg).toBeDefined();
		// One call, two rows — the correlation a report assembles a call from.
		expect(bLeg?.callId).toBe(aLeg?.callId);
		expect(bLeg?.originatingLegId).toBeTruthy();
		expect(aLeg?.originatingLegId).toBeNull();
		expect(bLeg?.toNumber).toBe("1001");
		expect(bLeg?.destinationType).toBe("extension");
		expect(bLeg?.destinationRef).toBe(EXTENSION_ID);
	}, 180_000);

	it("hands a call parked on one engine instance to a retriever on another", async () => {
		// Two simulated engines against the LIVE broker: two connections, two `park-claims` views,
		// two registries, two handoff responders. What the unit specs cannot prove is exactly what
		// is proved here — that the claim one process writes is the claim the other reads, and that
		// the request reaches the OWNER's subject rather than whichever instance answers first.
		const owner = await parkInstance(natsUrl, "engine-it-owner");
		const collector = await parkInstance(natsUrl, "engine-it-collector");

		try {
			const caller = itLeg("park-it-caller");
			const retriever = itLeg("park-it-retriever");
			owner.legs.set(caller.mediaChannelId, caller);
			collector.legs.set(retriever.mediaChannelId, retriever);
			const parked = await owner.control.park(caller);
			expect(parked.result.ok).toBe(true);
			expect(parked.slot).toBe(PARK_IT_LOT.slotStart);

			// The collector has no leg, no channel and no local entry for that orbit. All it has is
			// the claim, and the claim names the owner.
			const seen = await collector.parks.claim(
				PARK_IT_LOT.parkLotId,
				PARK_IT_LOT.slotStart,
				ORG_ID,
			);
			expect(seen).toMatchObject({ kind: "elsewhere", instanceId: "engine-it-owner" });

			const result = await collector.control.unpark(retriever, {
				orbit: String(PARK_IT_LOT.slotStart),
			});

			expect(result).toEqual({
				ok: true,
				detail: `retrieved orbit ${String(PARK_IT_LOT.slotStart)} from engine-it-owner`,
			});
			// The owner moved the media; the collector moved nothing but its own leg's state.
			expect(owner.media.methods()).toEqual([
				"startMusicOnHold",
				"stopMusicOnHold",
				"createBridge",
				"addToBridge",
			]);
			expect(collector.media.methods()).toEqual([]);
			expect(retriever.bridgeId).toBe(caller.bridgeId);
			// And the orbit is free again in the shared bucket, not merely in one process's map.
			expect(owner.parks.at(PARK_IT_LOT.parkLotId, PARK_IT_LOT.slotStart)).toBeUndefined();
			expect(
				(await collector.parks.claim(PARK_IT_LOT.parkLotId, PARK_IT_LOT.slotStart, ORG_ID)).kind,
			).toBe("absent");
		} finally {
			await owner.close();
			await collector.close();
		}
	}, 60_000);

	it("times out rather than being answered by the wrong instance", async () => {
		// The negative half of the addressing decision. A queue group on a flat subject would have
		// this request answered by whichever engine was picked; an instance-scoped subject leaves it
		// unanswered, which is the honest outcome when the instance named is not running.
		const collector = await parkInstance(natsUrl, "engine-it-lonely");
		try {
			await expect(
				collector.handoffs.handoff("engine-it-nobody-is-home", {
					orgId: ORG_ID,
					parkLotId: PARK_IT_LOT.parkLotId,
					slot: PARK_IT_LOT.slotStart,
					mediaChannelId: "nothing",
					retrieverInstanceId: "engine-it-lonely",
					retrieverMediaChannelId: "nothing-either",
					retrieverLegId: "leg-nothing",
					bridgeId: "bridge-nothing",
				}),
			).rejects.toThrow(ParkHandoffError);
		} finally {
			await collector.close();
		}
	}, 60_000);

	/**
	 * `rpc.sip.v1.transfer`, end to end, without a desk phone.
	 *
	 * What only this can prove: that a Go-shaped request — raw JSON on a flat subject, no NestJS
	 * `{pattern, data}` frame — is answered by a real engine inside the contract's deadline, and that
	 * the answer is `unknown_dialog` rather than `correlation_unavailable`. The difference between
	 * those two IS the wiring: the second means the orchestrator never attached a call path, which is
	 * a Nest graph failure no unit spec can see, because every unit spec attaches one by hand.
	 */
	it("answers a REFER relayed from the sip edge, with the dialog index really attached", async () => {
		const connection = await connect({
			servers: natsUrl,
			name: "engine-integration-sip-transfer",
			...harnessNatsOptions(),
		});
		try {
			const request: SipTransferRequest = {
				orgId: ORG_ID,
				// A dialog no call on this instance carries, because there is no PJSIP call in this
				// suite at all: every leg here is a Local channel, which has no SIP dialog to index.
				sipCallId: `no-such-dialog-${String(Date.now())}@1.2.3.4`,
				referredBy: { aor: "sip:1001@acme.example.com", username: "1001" },
				target: { user: "1002" },
				kind: "blind",
			};
			const reply = await connection.request(
				subjectFor.sipTransferRpc(),
				new TextEncoder().encode(JSON.stringify(request)),
				{ timeout: 5_000 },
			);
			const response = sipTransferResponseSchema.parse(
				JSON.parse(new TextDecoder().decode(reply.data)) as unknown,
			);

			expect(response.ok).toBe(false);
			expect(response.reason).toBe("unknown_dialog");
			expect(response.sipCallId).toBe(request.sipCallId);
			expect(response.instanceId).toBeTruthy();
		} finally {
			await connection.close();
		}
	}, 30_000);

	it("stops admitting calls once a drain begins", async () => {
		const orchestrator = app.get(ChannelOrchestrator);
		await orchestrator.drain(0);

		const response = await fetch(`http://127.0.0.1:${String(ENGINE_PORT)}/healthz`);
		expect(response.status).toBe(503);
		const body = (await response.json()) as { status: string; draining: boolean };
		expect(body.draining).toBe(true);
		expect(body.status).toBe("degraded");
	}, 30_000);
});

// ---------------------------------------------------------------------------------------------
// Cross-instance park retrieval
// ---------------------------------------------------------------------------------------------

/**
 * The lot the park-handoff scenario uses, kept away from anything the routed calls touch.
 *
 * Its own lot id, so the claim key it produces cannot collide with a run of this suite against a
 * broker that has other state in the `park-claims` bucket.
 */
const PARK_IT_LOT: ParkLot = {
	parkLotId: "0195c0f0-1c2f-7000-8000-0000000000f9",
	slotStart: 901,
	slotEnd: 902,
	timeoutSeconds: 0,
};

/** A leg with just enough behaviour for the park paths, recording what was done to it. */
function itLeg(id: string): ControlledLeg & { bridgeId: string | undefined } {
	const leg = {
		mediaChannelId: id,
		legId: `leg-${id}`,
		callId: `call-${id}`,
		organizationId: ORG_ID,
		isTearingDown: false,
		isAnswered: true,
		bridgeId: undefined as string | undefined,
		peerMediaChannelId: undefined,
		callerIdNumber: `n-${id}`,
		moveTo: () => true,
		moveCallStateTo: () => true,
		setBridge: (bridgeId: string | undefined) => {
			leg.bridgeId = bridgeId;
		},
		setBridgePeer: () => undefined,
		addFlag: () => undefined,
		removeFlag: () => undefined,
		markHangup: () => undefined,
		detach: () => undefined,
	};
	return leg;
}

/**
 * One simulated engine instance: its own connection, its own `park-claims` view, its own registry,
 * its own call control and its own handoff responder.
 *
 * Everything except the media server and the leg registry is the REAL production object, on the
 * real broker. That is the point: a unit spec can prove the two halves of a handoff agree with each
 * other, and only this can prove they agree through JetStream KV and a NATS subject.
 */
async function parkInstance(natsUrl: string, instanceId: string) {
	const connection = await connect({
		servers: natsUrl,
		name: `engine-integration-${instanceId}`,
		...harnessNatsOptions(),
	});
	const manager = await connection.jetstreamManager();
	await ensureKvBuckets(manager, [PARK_CLAIMS_KV]);

	const parks = new ParkRegistry();
	parks.bindClaims(
		new KvClaimBucket<ParkClaim>(
			await connection.jetstream().views.kv(PARK_CLAIMS_KV.name),
			parkClaimSchema as never,
			PARK_CLAIMS_KV.name,
		),
		instanceId,
	);

	const jetstream = {
		rawConnection: connection,
		parkClaims: { isConfigured: true },
	} as unknown as JetStreamService;
	const handoffs = new ParkHandoffService(
		{ ENGINE_INSTANCE_ID: instanceId } as EngineEnv,
		jetstream,
	);

	const legs = new Map<string, ControlledLeg>();
	const media = makeFakeMediaPort();
	const host: CallControlHost = {
		legFor: (mediaChannelId) => legs.get(mediaChannelId),
		ringingFor: async () => [],
		publish: async () => undefined,
		route: async () => ({ status: "aborted", notes: [] }),
		parkLotFor: async () => PARK_IT_LOT,
		parkLotForSlot: async () => PARK_IT_LOT,
	};
	const control = new CallControl({
		media,
		signals: new CallSignalBus(),
		parks,
		host,
		parkHandoff: handoffs,
		// No real timers: a park in this scenario is collected within milliseconds, and a pending
		// `setTimeout` would outlive the test.
		setTimer: () => ({ cancel: () => undefined }),
	});

	handoffs.setHandler(async (request) => await control.acceptParkHandoff(request));
	handoffs.onApplicationBootstrap();

	return {
		parks,
		control,
		handoffs,
		media,
		legs,
		close: async (): Promise<void> => {
			handoffs.onApplicationShutdown();
			await connection.close();
		},
	};
}

/** The `callId` token of a `calls.evt.v1.<org>.<call>.<event>` subject. */
function subjectCallId(subject: string): string {
	const parsed = parseSubject(subject);
	return parsed?.kind === "call" ? parsed.callId : "";
}

/** Hangs a channel up without letting an already-gone channel fail the cleanup. */
async function tryHangup(ari: AriConnectionService, channelId: string): Promise<void> {
	try {
		await ari.client.channels.hangup(channelId, { causeCode: 16 });
	} catch {
		// Already gone. The point of the call is that it is gone.
	}
}

/**
 * How the HARNESS itself connects — which is not how the engine under test connects.
 *
 * The suite plays the CONTROL PLANE: it seeds `routing-cache`, `did-index` and `queue-membership`,
 * and it observes every event family. `config/nats.conf` grants none of that to the `engine` user —
 * writing the dial plan is apps/api's, and the engine subscribes to no call event — so the harness
 * uses the unprefixed operator identity (`natsCredentials` with no service tag) while the engine
 * boots on `NATS_ENGINE_USER`/`PASS`. Two identities, matching the two roles, which is exactly the
 * arrangement production has.
 *
 * Empty when nothing is configured, which is the default path: `beforeAll` starts a throwaway
 * `nats` container with no authentication at all. It is only non-empty when a run is pointed at an
 * authenticated broker with `NATS_INTEGRATION_URL`.
 */
function harnessNatsOptions(): ReturnType<typeof natsConnectionOptions> {
	return natsConnectionOptions(process.env);
}

/**
 * Writes the demo tenant's artifact into the `routing-cache` bucket.
 *
 * The bucket has to exist first: the engine creates it at boot, but the seed runs BEFORE the
 * engine so that the very first call is a cache hit rather than an rpc timeout.
 */
async function seedRoutingArtifact(natsUrl: string): Promise<void> {
	const connection = await connect({
		servers: natsUrl,
		name: "engine-integration-seed",
		...harnessNatsOptions(),
	});
	try {
		const manager = await connection.jetstreamManager();
		await ensureKvBuckets(manager, [
			ROUTING_CACHE_KV,
			DID_INDEX_KV,
			QUEUE_MEMBERSHIP_KV,
			AGENT_STATE_KV,
		]);
		const kv = await connection.jetstream().views.kv(ROUTING_CACHE_KV.name);
		await kv.put(routingCacheKey(ORG_ID), encoder.encode(JSON.stringify(seedArtifact())));
		await kv.put(routingCacheKey(ORG_ID_B), encoder.encode(JSON.stringify(seedArtifactB())));

		// What `apps/api`'s `DidIndexPublisher` writes when a number is provisioned. Seeded here for
		// the same reason the artifacts are: this suite tests the ENGINE's half of the contract, and
		// standing the control plane up to write two rows would test the control plane.
		const did = await connection.jetstream().views.kv(DID_INDEX_KV.name);
		await did.put(
			kvKeyFor.didIndex(ROUTED_DID),
			encoder.encode(
				JSON.stringify({
					organizationId: ORG_ID,
					phoneNumberId: "0195c0f0-1c2f-7000-8000-0000000000d1",
					e164: ROUTED_DID,
					enabled: true,
				}),
			),
		);
		await did.put(
			kvKeyFor.didIndex(ROUTED_DID_B),
			encoder.encode(
				JSON.stringify({
					organizationId: ORG_ID_B,
					phoneNumberId: "0195c0f0-1c2f-7000-8000-0000000000d2",
					e164: ROUTED_DID_B,
					enabled: true,
				}),
			),
		);
		const NUMBER_IDS: Readonly<Record<string, string>> = {
			[QUEUE_DID]: "0195c0f0-1c2f-7000-8000-0000000000d3",
			[EMPTY_QUEUE_DID]: "0195c0f0-1c2f-7000-8000-0000000000d4",
			[CONFERENCE_DID]: "0195c0f0-1c2f-7000-8000-0000000000d5",
		};
		for (const number of [QUEUE_DID, EMPTY_QUEUE_DID, CONFERENCE_DID]) {
			await did.put(
				kvKeyFor.didIndex(number),
				encoder.encode(
					JSON.stringify({
						organizationId: ORG_ID,
						phoneNumberId: NUMBER_IDS[number],
						e164: number,
						enabled: true,
					}),
				),
			);
		}

		// --- the ACD read models ---------------------------------------------------------------
		//
		// Seeded DIRECTLY, exactly as the routing artifact and the DID index are, and for the same
		// reason: this suite proves the ENGINE consumes the contract. The writers now exist —
		// `apps/api`'s `QueueMembershipPublisher` and the agent-session endpoints — but this
		// harness boots only the engine, so hand-writing the buckets stands in for the api
		// process, not for a missing component. `verify:live` proves the api-side writers.
		const membership = await connection.jetstream().views.kv(QUEUE_MEMBERSHIP_KV.name);
		await membership.put(
			kvKeyFor.queueMembership(ORG_ID, QUEUE_ID),
			encoder.encode(
				JSON.stringify({
					orgId: ORG_ID,
					queueId: QUEUE_ID,
					name: "Support",
					wrapUpSeconds: 1,
					tierRulesApply: false,
					tierRuleWaitSeconds: 0,
					tierRuleNoAgentNoWait: false,
					agents: [
						{
							agentId: QUEUE_AGENT_ID,
							name: "Loopback agent",
							contactKind: "extension",
							// Dials the context that answers, so the agent leg is real without a phone.
							// `/n` for the same Local-optimisation reason the extension template has it.
							contact: "Local/1001@optimiq-loopback/n",
							extensionId: EXTENSION_ID,
							level: 1,
							position: 1,
							wrapUpSeconds: 1,
							maxNoAnswer: 3,
							noAnswerDelaySeconds: 1,
							busyDelaySeconds: 1,
							rejectDelaySeconds: 1,
							enabled: true,
						},
					],
					updatedAt: new Date().toISOString(),
					revision: 1,
				}),
			),
		);
		await membership.put(
			kvKeyFor.queueMembership(ORG_ID, EMPTY_QUEUE_ID),
			encoder.encode(
				JSON.stringify({
					orgId: ORG_ID,
					queueId: EMPTY_QUEUE_ID,
					name: "Nights",
					wrapUpSeconds: 1,
					tierRulesApply: false,
					tierRuleWaitSeconds: 0,
					tierRuleNoAgentNoWait: false,
					// A roster with a seat in it and nobody sitting there: the entry EXISTS, so a
					// failure here cannot be confused with a missing bucket.
					agents: [
						{
							agentId: IDLE_AGENT_ID,
							name: "Off shift",
							contactKind: "extension",
							contact: "Local/1001@optimiq-loopback/n",
							level: 1,
							position: 1,
							wrapUpSeconds: 1,
							maxNoAnswer: 3,
							noAnswerDelaySeconds: 1,
							busyDelaySeconds: 1,
							rejectDelaySeconds: 1,
							enabled: true,
						},
					],
					updatedAt: new Date().toISOString(),
					revision: 1,
				}),
			),
		);

		const agentState = await connection.jetstream().views.kv(AGENT_STATE_KV.name);
		await agentState.put(
			kvKeyFor.agentState(ORG_ID, QUEUE_AGENT_ID),
			encoder.encode(
				JSON.stringify({
					orgId: ORG_ID,
					agentId: QUEUE_AGENT_ID,
					status: "available",
					since: new Date().toISOString(),
					source: "api",
				}),
			),
		);
		await agentState.put(
			kvKeyFor.agentState(ORG_ID, IDLE_AGENT_ID),
			encoder.encode(
				JSON.stringify({
					orgId: ORG_ID,
					agentId: IDLE_AGENT_ID,
					status: "logged-out",
					since: new Date().toISOString(),
					source: "api",
				}),
			),
		);
	} finally {
		await connection.close();
	}
}

/**
 * The second tenant's routing: its DID straight to its own extension, no IVR.
 *
 * Deliberately a DIFFERENT shape from org A's, so "the call was routed by the right tenant's
 * artifact" is observable in the events rather than inferred from the subject alone.
 */
function seedArtifactB(): RoutingArtifact {
	const nodes: PlanNode[] = [
		{ id: "hangup:UNALLOCATED_NUMBER", kind: "hangup", cause: "UNALLOCATED_NUMBER" },
		{ id: "hangup:NORMAL_CLEARING", kind: "hangup", cause: "NORMAL_CLEARING" },
		{ id: "hangup:OUTGOING_CALL_BARRED", kind: "hangup", cause: "OUTGOING_CALL_BARRED" },
		{
			id: `extension:${EXTENSION_ID_B}`,
			kind: "extension",
			extensionId: EXTENSION_ID_B,
			number: "2001",
			tollClass: "internal",
			recordPolicy: "none",
			timeoutSeconds: 20,
			doNotDisturb: false,
		} as PlanNode,
	];

	return {
		...seedArtifact(),
		organizationId: ORG_ID_B,
		snapshotHash: "integration-seed-b-1",
		nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
		inbound: {
			rules: [],
			didDefaults: {
				[ROUTED_DID_B]: {
					phoneNumberId: "0195c0f0-1c2f-7000-8000-0000000000d2",
					e164: ROUTED_DID_B,
					enabled: true,
					recordEnabled: false,
					destinationNodeId: `extension:${EXTENSION_ID_B}`,
				},
			},
			noMatchNodeId: "hangup:UNALLOCATED_NUMBER",
		},
	} as unknown as RoutingArtifact;
}

/** Validates and records one delivered message; a rejection is remembered, never thrown. */
function collect(subject: string, payload: string, into: Received[], invalid: string[]): void {
	let decoded: unknown;
	try {
		decoded = JSON.parse(payload);
	} catch {
		invalid.push(`${subject}: not JSON`);
		return;
	}
	const result = safeValidateEvent(subject, decoded);
	if (!result.success) {
		invalid.push(`${subject}: ${result.error.message}`);
		return;
	}
	into.push({ subject, envelope: result.data });
}

/** Reads one agent's live state, as a wallboard would. */
async function readAgentState(
	natsUrl: string,
	orgId: string,
	agentId: string,
): Promise<{ status: string; queueId?: string; source?: string } | undefined> {
	const connection = await connect({
		servers: natsUrl,
		name: "engine-integration-agent-state",
		...harnessNatsOptions(),
	});
	try {
		const kv = await connection.jetstream().views.kv(AGENT_STATE_KV.name);
		const entry = await kv.get(kvKeyFor.agentState(orgId, agentId));
		if (entry === null || entry.value.length === 0) {
			return undefined;
		}
		return JSON.parse(decoder.decode(entry.value)) as {
			status: string;
			queueId?: string;
			source?: string;
		};
	} finally {
		await connection.close();
	}
}

/** Reads the `channels` bucket over a short-lived connection, as an outside observer would. */
async function readKv(natsUrl: string, key: string): Promise<ChannelSnapshot | undefined> {
	const connection = await connect({
		servers: natsUrl,
		name: "engine-integration-kv",
		...harnessNatsOptions(),
	});
	try {
		const kv = await connection.jetstream().views.kv(CHANNELS_KV.name);
		const entry = await kv.get(key);
		if (entry === null || entry.value.length === 0) {
			return undefined;
		}
		return JSON.parse(decoder.decode(entry.value)) as ChannelSnapshot;
	} finally {
		await connection.close();
	}
}
