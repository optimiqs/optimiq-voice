import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { connect, type NatsConnection } from "nats";
import { of } from "rxjs";
import { ROUTING_ARTIFACT_VERSION, routingCacheKey } from "@optimiq-voice/routing";
import { startBroker, type Broker } from "../../bench/broker";
import { RoutingArtifactSource } from "./routing-artifact.source";
import type { EngineEnv } from "../config/engine-env";
import type { JetStreamService } from "../nats/jetstream.service";
import type { ClientProxy } from "@nestjs/microservices";
import type { RoutingArtifact } from "@optimiq-voice/routing";

/**
 * The stalled `routing-cache` watch, against a REAL broker.
 *
 * The production incident this pins: `kv.watch()` is an ordered push consumer with
 * `flow_control: true`, so every few seconds the broker asks the client to reopen the window by
 * publishing to `$JS.FC.<stream>.<consumer>.<nonce>`. When that publish is refused the broker stops
 * pushing — and refuses SILENTLY as far as the watcher is concerned: the subscription stays open,
 * `sub.closed` never resolves, the iterator never ends, and no error reaches any callback. The
 * engine's watch went quiet for over half an hour with `watching: true` and nothing in its log.
 *
 * A fake bucket cannot prove any of that, because a fake has no consumer and no flow control. The
 * broker is therefore started with a user whose publish grant DENIES `$JS.FC.>`, which is the
 * shipped `config/nats.conf` grant as it stood, and the spec asserts both halves: the watch really
 * does stall, and the stale guard really does get it back.
 *
 * ```sh
 * NATS_SERVER_BIN=$(which nats-server) bun test apps/engine/src/routing/routing-watch-stall.spec.ts
 * ```
 */
const ENABLED = (process.env.NATS_SERVER_BIN ?? "") !== "";

const ORG = "0195c0f0-1c2f-7000-8000-0000000000f1";
/** Big enough that a few dozen writes exhaust the consumer's flow-control window. */
const PADDING = "x".repeat(40_000);
const WRITES = 400;
const PROBE_MS = 500;

function artifact(snapshotHash: string): RoutingArtifact {
	return {
		artifactVersion: ROUTING_ARTIFACT_VERSION,
		organizationId: ORG,
		snapshotHash,
		compiledAt: "2026-09-09T12:00:00.000Z",
		settings: { padding: PADDING },
		nodes: {},
		timeConditions: {},
		inbound: { rules: [], didDefaults: {}, noMatchNodeId: "hangup:UNALLOCATED_NUMBER" },
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

describe.skipIf(!ENABLED)("a routing-cache watch whose flow-control reply is refused", () => {
	let broker: Broker;
	let connection: NatsConnection;
	let source: RoutingArtifactSource;

	beforeAll(async () => {
		// `deny: ["$JS.FC.>"]` IS the bug: the engine's shipped grant enumerated its subjects and
		// never listed the flow-control family, so the broker refused every window reply the KV
		// watch made. Everything else this user may do, so the only difference from a healthy
		// deployment is the one publish that matters.
		broker = await startBroker({
			extraConfig: `authorization {
				users = [
					{ user: admin, password: pw }
					{ user: nofc, password: pw, permissions: {
						publish: { allow: [">"], deny: ["$JS.FC.>"] }
						subscribe: { allow: [">"] }
					}}
				]
			}`,
			probe: { user: "admin", pass: "pw" },
		});
		connection = await connect({
			servers: broker.url,
			name: "watch-stall-spec",
			user: "nofc",
			pass: "pw",
		});
		const manager = await connection.jetstreamManager();
		await manager.streams.add({
			name: "KV_routing-cache",
			subjects: ["$KV.routing-cache.>"],
			max_msgs_per_subject: 1,
			allow_direct: true,
		});
	});

	afterAll(async () => {
		await source.onApplicationShutdown();
		await connection.close();
		broker.stop();
	});

	it("stalls without ending, and the stale guard puts it back", async () => {
		const bucket = await connection.jetstream().views.kv("routing-cache");
		const jetstream = {
			get routingCache() {
				return bucket;
			},
		} as unknown as JetStreamService;
		const client = {
			send: () => of({ matched: false }),
		} as unknown as ClientProxy;
		const env = {
			ENGINE_ROUTING_RPC_TIMEOUT_MS: 500,
			ENGINE_ROUTING_WATCH_PROBE_MS: PROBE_MS,
		} as EngineEnv;

		source = new RoutingArtifactSource(env, client, jetstream);
		await source.onModuleInit();
		await waitFor(() => source.stats.watching);

		for (let index = 0; index < WRITES; index += 1) {
			await bucket.put(
				routingCacheKey(ORG),
				new TextEncoder().encode(JSON.stringify(artifact(`hash-${String(index)}`))),
			);
		}

		// Half of the assertion: the watch is stalled and says nothing about it. `watching` is
		// still true and the iterator has not ended, which is precisely why silence alone could
		// never have caught this.
		const stalledAt = source.stats.watchRevision;
		await new Promise((resolve) => setTimeout(resolve, PROBE_MS));
		expect(source.stats.watching).toBe(true);
		expect(stalledAt).toBeLessThan(WRITES);

		// The other half: the guard notices the bucket is ahead and re-establishes. A fresh
		// consumer gets a fresh flow-control window, so the newest value is delivered again — the
		// grant is still wrong, and the engine routes on current configuration anyway.
		await waitFor(() => source.stats.staleRecoveries > 0, 20_000);
		await waitFor(() => source.stats.watchRevision > stalledAt, 20_000);

		const recovered = await source.get(ORG);
		expect(recovered?.snapshotHash).toBe(`hash-${String(WRITES - 1)}`);
	}, 60_000);
});

async function waitFor(predicate: () => boolean, budgetMs = 10_000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("condition was not met before the deadline");
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
