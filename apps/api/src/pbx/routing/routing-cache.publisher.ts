import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type JetStreamManager, type KV, type NatsConnection } from "nats";
// Subpath imports rather than the package root: `apps/api`'s tooling tsconfig still relaxes
// `strictNullChecks` for its ~180 legacy files, and `packages/events`'s `validate.ts` needs it to
// narrow a discriminated union. `./streams` and `./subjects` reach only `subjects.ts`, which
// compiles cleanly either way. Recorded as a follow-up: the fix is to bring `apps/api` up to
// strict, not to weaken the contracts package.
import { natsCredentials } from "@optimiq-voice/config/nats-credentials";
import { ensureKvBuckets, ROUTING_CACHE_KV } from "@optimiq-voice/events/streams";
import { getLogger } from "@optimiq-voice/logging";
import { ROUTING_CACHE_BUCKET } from "@optimiq-voice/routing";
import { PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";
import type { RoutingArtifact } from "@optimiq-voice/routing";

const logger = getLogger("api.pbx");

/**
 * The `routing-cache` KV half of the NATS backbone.
 *
 * ## Why raw JetStream rather than the Nest transport
 *
 * Plan §3.5 is explicit: no custom NATS framework — NestJS's built-in NATS transport for core
 * pub/sub and request-reply, and the raw `nats` API only where JetStream durability or KV is
 * genuinely needed. KV is that case, exactly as it is in `apps/engine/src/nats/jetstream.service.ts`
 * (there for the `channels` bucket): there is no Nest abstraction over KV at all.
 *
 * ## Why the publish is after the commit, and why a failure is not fatal
 *
 * The artifact is the *derived* view of rows that are already durable in Postgres. Publishing it
 * from inside the write transaction would put an artifact for a state that might roll back into a
 * bucket the engine resolves live calls against — a correctness bug in the direction that matters.
 * Publishing after the commit can instead leave the cache momentarily stale, which the system is
 * already designed to survive: the engine's miss path is `rpc.routing.v1.resolve`, which compiles
 * from the database, and the bucket carries a 1 h TTL as a backstop.
 *
 * So a publish failure is logged and swallowed. The alternative — failing the HTTP request after
 * the row is committed — would report "your change was not saved" about a change that was, which
 * is the worse lie.
 *
 * Swallowed is not the same as forgotten. The write records what it owes in
 * `pbx_projection_outbox` INSIDE its own transaction (`shared/projection-outbox.ts`); this publish
 * is the fast path that discharges the obligation in milliseconds, and a sweeper republishes
 * whatever it failed to mark — including the case no in-process retry can cover, the process dying
 * between the commit and this call.
 *
 * ## Absent broker
 *
 * `NATS_URL` is optional. Without it this service never connects, `publish` is a no-op that
 * returns `false`, and a warning is logged once at boot. Every REST feature still works: a
 * developer without a broker must still be able to run CRUD, and the control plane must not need
 * the backbone to accept a configuration change.
 */
@Injectable()
export class RoutingCachePublisher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private bucket: KV | undefined;
	private published = 0;
	private failed = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	/** Whether an artifact published now would actually reach the broker. */
	get isReady(): boolean {
		return this.bucket !== undefined && this.connection?.isClosed() === false;
	}

	get publishedCount(): number {
		return this.published;
	}

	get failedCount(): number {
		return this.failed;
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — compiled routing artifacts will not be published to the " +
					"routing-cache KV bucket and rpc.routing.v1.resolve is not served. PBX CRUD is " +
					"unaffected; the engine falls back to compiling on a cache miss.",
			);
			return;
		}

		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsCredentials(this.env),
				name: "optimiq-api-routing-cache",
				// The control plane must not die because the broker restarted.
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			const manager: JetStreamManager = await this.connection.jetstreamManager();
			if (this.env.PBX_ENSURE_KV_BUCKETS) {
				await ensureKvBuckets(manager, [ROUTING_CACHE_KV]);
			}
			this.bucket = await manager.jetstream().views.kv(ROUTING_CACHE_BUCKET);
			logger.info({ bucket: ROUTING_CACHE_BUCKET }, "routing-cache KV bucket ready");
		} catch (error) {
			// Same reasoning as a publish failure: a broker that is down must not stop the control
			// plane from serving configuration changes.
			this.failed += 1;
			logger.error({ err: error }, "could not open the routing-cache KV bucket");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.bucket = undefined;
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/**
	 * Writes one organization's artifact under `<orgId>.artifact`.
	 *
	 * The key comes from `routingCacheKey` in `packages/routing`, which is the same string
	 * `kvKeyFor.routingCache(orgId, "artifact")` produces in `packages/events` — the compiler
	 * cannot import the broker package without dragging `nats` into a pure function, so the two
	 * are pinned together by spec on the compiler's side rather than by an import.
	 *
	 * Returns whether the value reached the broker, so a verification harness can assert it
	 * without reading the bucket back.
	 */
	async publish(cacheKey: string, artifact: RoutingArtifact): Promise<boolean> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return false;
		}
		try {
			await bucket.put(cacheKey, new TextEncoder().encode(JSON.stringify(artifact)));
			this.published += 1;
			return true;
		} catch (error) {
			this.failed += 1;
			logger.error(
				{
					cacheKey,
					organizationId: artifact.organizationId,
					error,
				},
				"failed to publish a routing artifact",
			);
			return false;
		}
	}

	/** Reads an artifact back. Used by the resolve responder's hit path and by verification. */
	async read(cacheKey: string): Promise<RoutingArtifact | undefined> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return undefined;
		}
		try {
			const entry = await bucket.get(cacheKey);
			if (entry === null || entry.value.length === 0) {
				return undefined;
			}
			return JSON.parse(new TextDecoder().decode(entry.value)) as RoutingArtifact;
		} catch (error) {
			logger.error({ cacheKey, error }, "failed to read a routing artifact");
			return undefined;
		}
	}
}
