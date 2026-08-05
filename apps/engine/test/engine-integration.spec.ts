import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { connect, type NatsConnection, type Subscription } from "nats";
import {
	CHANNELS_KV,
	kvKeyFor,
	safeValidateEvent,
	subjectFilterFor,
	subjectFor,
} from "@optimiq-voice/events";
import { AppModule } from "../src/app.module";
import { AriConnectionService } from "../src/ari/ari-connection.service";
import { callIdForAriChannel, legIdForAriChannel } from "../src/calls/channel-identity";
import { ChannelOrchestrator } from "../src/calls/channel-orchestrator.service";
import type { AnyEventEnvelope } from "@optimiq-voice/events";
import type { ChannelSnapshot } from "@optimiq-voice/telephony";

/**
 * The P2 parity gate: a real inbound call through a real Asterisk 22 and a real NATS JetStream.
 *
 * ```sh
 * # from the repository root
 * pnpm --filter @optimiq-voice/engine test:integration
 * ```
 *
 * It starts `nats:2.11-alpine -js` and an `apps/asterisk` container, boots the engine against
 * both, originates a call into the Stasis application and asserts the whole chain:
 *
 * - `calls.evt.v1.<org>.<call>.*` arrives IN ORDER: created → ringing/answered → hangup → destroyed
 * - every envelope satisfies its own schema, cross-checked against the subject it was delivered on
 * - the `channels` KV entry appears while the call is live and is gone once it is destroyed
 * - one `cdr.leg.write` is published on `cdr.leg.v1.<org>` with a billable, answered disposition
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

const decoder = new TextDecoder();

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
	throw new Error(`${label} never became ready: ${String(lastError)}`);
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
				ASTERISK_IMAGE,
			);
			startedAsterisk = true;
			ariBaseUrl = `http://127.0.0.1:${String(ARI_PORT)}`;
		}

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

	it("drives an inbound call: ordered events, live KV, cleared KV, and one CDR", async () => {
		const ari = app.get(AriConnectionService);
		const orchestrator = app.get(ChannelOrchestrator);
		const ariChannelId = `engine-it-${String(Date.now())}`;
		const legId = legIdForAriChannel(ariChannelId);
		const callId = callIdForAriChannel(ariChannelId);

		callEvents.length = 0;
		cdrEvents.length = 0;

		await ari.client.channels.originate({
			endpoint: `Local/${ariChannelId}@local-ctx`,
			app: ARI_APP,
			channelId: ariChannelId,
			timeoutSeconds: 15,
			variables: { OPTIMIQ_ORG_ID: ORG_ID, OPTIMIQ_CALL_DIRECTION: "inbound" },
		});

		// --- the leg is live: the KV mirror must exist ----------------------------------------
		await waitFor(
			"channel.created",
			async () => callEvents.some((event) => event.envelope.type === "channel.created"),
			20_000,
		);

		const liveKv = await readKv(natsUrl, kvKeyFor.channel(ORG_ID, callId, legId));
		expect(liveKv).toBeDefined();
		expect(liveKv?.organizationId).toBe(ORG_ID);
		expect(liveKv?.channelId).toBe(legId);
		expect(orchestrator.activeChannelCount).toBeGreaterThan(0);

		// --- tear it down ---------------------------------------------------------------------
		await ari.client.channels.hangup(ariChannelId, { causeCode: 16 });

		await waitFor(
			"channel.destroyed",
			async () => callEvents.some((event) => event.envelope.type === "channel.destroyed"),
			20_000,
		);
		await waitFor("cdr.leg.write", async () => cdrEvents.length > 0, 20_000);

		// --- ordering -------------------------------------------------------------------------
		const order = callEvents.map((event) => event.envelope.type);
		expect(order[0]).toBe("channel.created");
		expect(order.at(-1)).toBe("channel.destroyed");
		expect(order.indexOf("channel.hangup")).toBeGreaterThan(order.indexOf("channel.created"));
		expect(order.indexOf("channel.hangup")).toBeLessThan(order.indexOf("channel.destroyed"));
		expect(order).toContain("channel.answered");

		// Every event landed on its own call's subject, and every one validated.
		for (const event of callEvents) {
			expect(event.subject).toBe(subjectFor.call(ORG_ID, callId, event.envelope.type));
			expect(event.envelope.orgId).toBe(ORG_ID);
		}
		expect(invalid).toEqual([]);

		// --- the CDR --------------------------------------------------------------------------
		expect(cdrEvents).toHaveLength(1);
		const cdr = cdrEvents[0];
		expect(cdr?.subject).toBe(subjectFor.cdrLeg(ORG_ID));
		expect(cdr?.envelope.type).toBe("cdr.leg.write");
		expect(cdr?.envelope.data).toMatchObject({
			callId,
			leg: "a",
			direction: "inbound",
			disposition: "answered",
			hangupCause: "NORMAL_CLEARING",
			hangupCauseCode: 16,
		});

		// --- the KV entry is gone --------------------------------------------------------------
		await waitFor(
			"KV entry cleared",
			async () => (await readKv(natsUrl, kvKeyFor.channel(ORG_ID, callId, legId))) === undefined,
			10_000,
		);
		expect(orchestrator.activeChannelCount).toBe(0);
	}, 120_000);

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
