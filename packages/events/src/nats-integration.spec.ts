import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { AckPolicy, connect, DeliverPolicy, nanos, type NatsConnection } from "nats";
import { createEntityId } from "@optimiq-voice/identifiers";
import { makeCallEvent } from "./schemas/call-events";
import { makeCdrLegWriteEvent } from "./schemas/cdr-events";
import {
	CALLS_STREAM,
	ensureKvBuckets,
	ensureStreams,
	EVENT_STREAMS,
	KV_BUCKETS,
	kvKeyFor,
	millisToNanos,
	streamConfigFor,
	type KvBucketDefinition,
} from "./streams";
import { subjectFilterFor } from "./subjects";
import { validateEvent } from "./validate";

/**
 * Proves the declarative definitions in `streams.ts` against a REAL JetStream server, and that a
 * real publish/consume round trip satisfies the schemas.
 *
 * ```sh
 * RUN_NATS_INTEGRATION_TESTS=true pnpm --filter @optimiq-voice/events test:integration
 * ```
 *
 * By default it starts a throwaway `nats:2.11-alpine -js` container on 4223 and removes it
 * afterwards. Point `NATS_INTEGRATION_URL` at an existing server to skip Docker entirely.
 *
 * The consumer code here is deliberately RAW `nats` — this package ships contracts, not a client
 * wrapper, and the test is the worked example of how an application uses them.
 */

const ENABLED = process.env.RUN_NATS_INTEGRATION_TESTS === "true";
const EXTERNAL_URL = process.env.NATS_INTEGRATION_URL;
const CONTAINER_PORT = 4223;
const CONTAINER_NAME = `optimiq-events-it-${process.pid}`;
const IMAGE = "nats:2.11-alpine";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function docker(...args: readonly string[]): string {
	const result = spawnSync("docker", [...args], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`docker ${args.join(" ")} failed (${String(result.status)}): ${result.stderr || result.stdout}`,
		);
	}
	return result.stdout.trim();
}

function startBroker(): { readonly url: string; readonly containerId?: string } {
	if (EXTERNAL_URL !== undefined && EXTERNAL_URL !== "") {
		return { url: EXTERNAL_URL };
	}
	// `--rm` so an aborted run leaves nothing behind even if afterAll never executes.
	const containerId = docker(
		"run",
		"-d",
		"--rm",
		"--name",
		CONTAINER_NAME,
		"-p",
		`${CONTAINER_PORT}:4222`,
		IMAGE,
		"-js",
	);
	return { url: `nats://127.0.0.1:${CONTAINER_PORT}`, containerId };
}

async function connectWithRetry(url: string, deadlineMs: number): Promise<NatsConnection> {
	const deadline = Date.now() + deadlineMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			return await connect({ servers: url, maxReconnectAttempts: 3, timeout: 2_000 });
		} catch (error) {
			lastError = error;
			await Bun.sleep(250);
		}
	}
	throw new Error(`NATS at ${url} never became ready: ${String(lastError)}`);
}

describe.skipIf(!ENABLED)("nats backbone (integration)", () => {
	const orgId = createEntityId();
	const otherOrgId = createEntityId();
	let containerId: string | undefined;
	let connection: NatsConnection;

	beforeAll(async () => {
		const broker = startBroker();
		containerId = broker.containerId;
		connection = await connectWithRetry(broker.url, 90_000);
	}, 180_000);

	afterAll(async () => {
		await connection?.close();
		if (containerId !== undefined) {
			spawnSync("docker", ["rm", "-f", containerId], { encoding: "utf8" });
		}
	}, 60_000);

	it("creates every stream, then reports them unchanged on a second run", async () => {
		const manager = await connection.jetstreamManager();

		const first = await ensureStreams(manager);
		expect(first.map((outcome) => outcome.name)).toEqual(
			EVENT_STREAMS.map((stream) => stream.name),
		);
		expect(first.every((outcome) => outcome.action === "created")).toBe(true);

		const second = await ensureStreams(manager);
		expect(second.every((outcome) => outcome.action === "unchanged")).toBe(true);

		// The server accepted our definitions verbatim — this is what "unchanged" is asserting.
		const live = await manager.streams.info(CALLS_STREAM.name);
		const desired = streamConfigFor(CALLS_STREAM);
		expect(live.config.subjects).toEqual(desired.subjects);
		expect(live.config.max_age).toBe(desired.max_age);
		expect(live.config.duplicate_window).toBe(desired.duplicate_window);
		expect(String(live.config.discard)).toBe(desired.discard);
		expect(String(live.config.retention)).toBe(desired.retention);
	}, 60_000);

	it("reconciles a stream whose limits drifted", async () => {
		const manager = await connection.jetstreamManager();
		await ensureStreams(manager);

		const desired = streamConfigFor(CALLS_STREAM);
		await manager.streams.update(CALLS_STREAM.name, {
			max_bytes: 64 * 1024 * 1024,
		});
		expect((await manager.streams.info(CALLS_STREAM.name)).config.max_bytes).toBe(64 * 1024 * 1024);

		const outcomes = await ensureStreams(manager, [CALLS_STREAM]);
		expect(outcomes[0]?.action).toBe("updated");
		expect((await manager.streams.info(CALLS_STREAM.name)).config.max_bytes).toBe(
			desired.max_bytes,
		);
	}, 60_000);

	it("round-trips a published event through a durable consumer and its schema", async () => {
		const manager = await connection.jetstreamManager();
		await ensureStreams(manager);
		const jetstream = manager.jetstream();

		const callId = createEntityId();
		const legId = createEntityId();
		const answered = makeCallEvent("channel.answered", {
			orgId,
			callId,
			source: "engine",
			data: { legId },
		});
		const hangup = makeCallEvent("channel.hangup", {
			orgId,
			callId,
			source: "engine",
			data: { legId, cause: "NORMAL_CLEARING", causeCode: 16, side: "caller" },
		});
		// A different tenant's event on the same stream — the consumer's filter must exclude it.
		const foreign = makeCallEvent("channel.answered", {
			orgId: otherOrgId,
			callId: createEntityId(),
			source: "engine",
			data: { legId: createEntityId() },
		});

		for (const event of [answered, hangup, foreign]) {
			const ack = await jetstream.publish(event.subject, encoder.encode(JSON.stringify(event)), {
				msgID: event.id,
			});
			expect(ack.stream).toBe(CALLS_STREAM.name);
			expect(ack.duplicate).toBe(false);
		}

		const durableName = `it-calls-${Date.now()}`;
		await manager.consumers.add(CALLS_STREAM.name, {
			durable_name: durableName,
			ack_policy: AckPolicy.Explicit,
			deliver_policy: DeliverPolicy.All,
			filter_subject: subjectFilterFor.callsInOrg(orgId),
			ack_wait: nanos(5_000),
			max_deliver: 3,
			max_ack_pending: 16,
		});

		const consumer = await manager.jetstream().consumers.get(CALLS_STREAM.name, durableName);
		const messages = await consumer.fetch({ max_messages: 10, expires: 5_000 });

		const received: string[] = [];
		for await (const message of messages) {
			const event = validateEvent(message.subject, JSON.parse(decoder.decode(message.data)));
			expect(event.orgId).toBe(orgId);
			received.push(event.type);
			message.ack();
		}

		expect(received).toEqual(["channel.answered", "channel.hangup"]);
	}, 60_000);

	it("suppresses a duplicate publish inside the stream's Nats-Msg-Id window", async () => {
		const manager = await connection.jetstreamManager();
		await ensureStreams(manager);
		const jetstream = manager.jetstream();

		const event = makeCdrLegWriteEvent({
			orgId,
			source: "engine",
			data: {
				id: createEntityId(),
				callId: createEntityId(),
				leg: "a",
				direction: "inbound",
				fromNumber: "+15551230000",
				toNumber: "1001",
				destinationType: "extension",
				startedAt: new Date().toISOString(),
				durationMs: 12_000,
				billsecMs: 9_000,
				hangupCause: "NORMAL_CLEARING",
				hangupCauseCode: 16,
				disposition: "answered",
			},
		});
		const payload = encoder.encode(JSON.stringify(event));

		const first = await jetstream.publish(event.subject, payload, { msgID: event.id });
		const retry = await jetstream.publish(event.subject, payload, { msgID: event.id });

		expect(first.duplicate).toBe(false);
		expect(retry.duplicate).toBe(true);
		// The retry resolves to the ORIGINAL sequence, so a crash-retrying writer stores one row.
		expect(retry.seq).toBe(first.seq);
	}, 60_000);

	it("creates every KV bucket idempotently and stores a value", async () => {
		const manager = await connection.jetstreamManager();

		const first = await ensureKvBuckets(manager);
		expect(first.map((outcome) => outcome.name)).toEqual(KV_BUCKETS.map((bucket) => bucket.name));
		expect(first.every((outcome) => outcome.created)).toBe(true);

		const second = await ensureKvBuckets(manager);
		expect(second.every((outcome) => outcome.created)).toBe(false);

		const registrations = second.find((outcome) => outcome.name === "registrations");
		expect(registrations).toBeDefined();

		const bucket = await manager.jetstream().views.kv("registrations");
		const key = kvKeyFor.registration(orgId, "a".repeat(32));
		await bucket.put(key, encoder.encode(JSON.stringify({ contact: "sip:1001@10.0.0.5" })));

		const entry = await bucket.get(key);
		expect(entry).not.toBeNull();
		expect(JSON.parse(decoder.decode(entry?.value as Uint8Array))).toEqual({
			contact: "sip:1001@10.0.0.5",
		});

		await bucket.delete(key);
		const deleted = await bucket.get(key);
		expect(deleted?.operation).toBe("DEL");
	}, 60_000);

	it("expires a KV entry once the bucket TTL passes", async () => {
		const manager = await connection.jetstreamManager();
		// A dedicated short-TTL bucket: the production TTLs are hours, which no test can wait for.
		const shortLived: KvBucketDefinition = {
			name: `ttl-probe-${process.pid}`,
			description: "TTL probe for the integration spec.",
			ttlMs: 1_000,
			history: 1,
			storage: "memory",
			maxValueSizeBytes: 1024,
			maxBytes: 1024 * 1024,
			numReplicas: 1,
		};

		await ensureKvBuckets(manager, [shortLived]);
		const bucket = await manager.jetstream().views.kv(shortLived.name);
		await bucket.put("probe", encoder.encode("alive"));
		expect(decoder.decode((await bucket.get("probe"))?.value as Uint8Array)).toBe("alive");

		// The server enforces max_age on a timer, so poll rather than sleeping a fixed amount.
		const deadline = Date.now() + 20_000;
		let expired = false;
		while (Date.now() < deadline) {
			await Bun.sleep(250);
			const entry = await bucket.get("probe");
			if (entry === null || entry.operation !== "PUT") {
				expired = true;
				break;
			}
		}
		expect(expired).toBe(true);

		// The bucket's backing stream really did carry our declared TTL.
		const info = await manager.streams.info(`KV_${shortLived.name}`);
		expect(info.config.max_age).toBe(millisToNanos(shortLived.ttlMs));

		await manager.streams.delete(`KV_${shortLived.name}`);
	}, 60_000);
});
