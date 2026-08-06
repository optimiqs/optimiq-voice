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
import {
	CHANNELS_KV,
	DID_INDEX_KV,
	ensureKvBuckets,
	kvKeyFor,
	ROUTING_CACHE_KV,
	parseSubject,
	safeValidateEvent,
	subjectFilterFor,
	subjectFor,
} from "@optimiq-voice/events";
import { ROUTING_ARTIFACT_VERSION, routingCacheKey } from "@optimiq-voice/routing";
import { AppModule } from "../src/app.module";
import { AriConnectionService } from "../src/ari/ari-connection.service";
import { callIdForAriChannel, legIdForAriChannel } from "../src/calls/channel-identity";
import { ChannelOrchestrator } from "../src/calls/channel-orchestrator.service";
import type { AnyEventEnvelope } from "@optimiq-voice/events";
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
const NATS_PORT = 4225;
const ARI_PORT = 8189;
const ENGINE_PORT = 4019;

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
	const callEvents: Received[] = [];
	const cdrEvents: Received[] = [];
	const invalid: string[] = [];
	let startedNats = false;
	let startedAsterisk = false;
	let ariBaseUrl: string;
	let natsUrl: string;

	/** What the observer actually saw, for a timeout that would otherwise say nothing. */
	const describeObserved = (): string =>
		`observed calls=[${callEvents.map((event) => event.envelope.type).join(", ")}] ` +
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
		nats = await connect({ servers: natsUrl, name: "engine-integration-observer" });
		callSubscription = nats.subscribe(subjectFilterFor.allCalls());
		cdrSubscription = nats.subscribe(subjectFilterFor.allCdrLegs());

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
	}, 300_000);

	afterAll(async () => {
		callSubscription?.unsubscribe();
		cdrSubscription?.unsubscribe();
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
		const body = (await response.json()) as { status: string; ari: { connected: boolean } };
		expect(body.status).toBe("ok");
		expect(body.ari.connected).toBe(true);
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
		expect(bridged?.envelope.data).toMatchObject({ legId, mode: "full" });

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
 * Writes the demo tenant's artifact into the `routing-cache` bucket.
 *
 * The bucket has to exist first: the engine creates it at boot, but the seed runs BEFORE the
 * engine so that the very first call is a cache hit rather than an rpc timeout.
 */
async function seedRoutingArtifact(natsUrl: string): Promise<void> {
	const connection = await connect({ servers: natsUrl, name: "engine-integration-seed" });
	try {
		const manager = await connection.jetstreamManager();
		await ensureKvBuckets(manager, [ROUTING_CACHE_KV, DID_INDEX_KV]);
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

/** Reads the `channels` bucket over a short-lived connection, as an outside observer would. */
async function readKv(natsUrl: string, key: string): Promise<ChannelSnapshot | undefined> {
	const connection = await connect({ servers: natsUrl, name: "engine-integration-kv" });
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
