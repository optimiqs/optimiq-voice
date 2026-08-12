import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { firstValueFrom, timeout } from "rxjs";
import { ROUTING_RESOLVE_RPC, routingResolveResponseSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import {
	parseRoutingArtifact,
	ROUTING_CACHE_ARTIFACT_NAME,
	RoutingArtifactVersionError,
	routingCacheKey,
} from "@optimiq-voice/routing";
import { JetStreamService } from "../nats/jetstream.service";
import { ENGINE_ENV, ROUTING_RPC_CLIENT } from "../nats/nats.tokens";
import type { EngineEnv } from "../config/engine-env";
import type { RoutingResolveRequest, RoutingResolveResponse } from "@optimiq-voice/events";
import type { RoutingArtifact } from "@optimiq-voice/routing";

/**
 * Where the engine gets an organization's compiled routing artifact.
 *
 * ## Three layers, in this order
 *
 * 1. **In-process memory.** Resolving a route is on the call path; a KV round trip per inbound
 *    INVITE is a round trip in the middle of a ringing phone.
 * 2. **The `routing-cache` KV bucket.** Written by `apps/api` inside the same unit of work as the
 *    row change, so it is the freshest thing that is not a compile.
 * 3. **`rpc.routing.v1.resolve`.** The miss path: the API loads the tenant's snapshot, compiles it,
 *    and hands the artifact back for the engine to cache.
 *
 * ## Invalidation is a watch, not a TTL
 *
 * `packages/routing` states the contract in one sentence: one artifact per organization, one key
 * per organization, any mutation to any routing entity invalidates it. That makes a KV **watch**
 * the correct mechanism — the API's `put` after a save is itself the invalidation signal, and the
 * engine replaces its memory copy the moment it lands. The bucket's 1 h TTL stays what it is
 * documented to be: a backstop, not the refresh interval.
 *
 * A watch that dies (a broker restart) is restarted with backoff, and the memory cache is dropped
 * when it does — an engine that stopped hearing about changes must not keep serving the last thing
 * it heard as if it were current.
 *
 * ## The version guard is a hard failure, deliberately
 *
 * `parseRoutingArtifact` throws on an `artifactVersion` this release does not understand. The entry
 * is DISCARDED and the RPC path recompiles, rather than the artifact being walked best-effort.
 * Half-reading an artifact written by a future release is how a call ends up somewhere nobody
 * configured.
 *
 * ## The Nest message shape matters
 *
 * The request goes out through `ClientProxy.send`, not a raw NATS publish. The API's responder is a
 * NestJS microservice, and Nest's NATS server expects its own envelope (`{ pattern, data, id }`) —
 * a raw request on the same subject is never answered and the caller sits there until its deadline,
 * with a caller listening to silence.
 */

/** One organization's artifact, plus when this process last had it confirmed. */
interface CacheEntry {
	readonly artifact: RoutingArtifact;
	readonly at: number;
}

@Injectable()
export class RoutingArtifactSource implements OnModuleInit, OnApplicationShutdown {
	private readonly logger = getLogger("engine.routing");
	private readonly cache = new Map<string, CacheEntry>();
	/** De-duplicates concurrent misses: fifty simultaneous calls to one org compile once. */
	private readonly inFlight = new Map<string, Promise<RoutingArtifact | undefined>>();
	private watching = false;
	private stopped = false;
	private watchAbort: (() => void) | undefined;
	private hits = 0;
	private kvReads = 0;
	private rpcCalls = 0;
	private invalidations = 0;

	constructor(
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
		@Inject(ROUTING_RPC_CLIENT) private readonly client: ClientProxy,
		private readonly jetstream: JetStreamService,
	) {}

	/** Counters `/healthz` and the specs read. */
	get stats(): {
		readonly cached: number;
		readonly hits: number;
		readonly kvReads: number;
		readonly rpcCalls: number;
		readonly invalidations: number;
		readonly watching: boolean;
	} {
		return {
			cached: this.cache.size,
			hits: this.hits,
			kvReads: this.kvReads,
			rpcCalls: this.rpcCalls,
			invalidations: this.invalidations,
			watching: this.watching,
		};
	}

	async onModuleInit(): Promise<void> {
		// Fire-and-forget: the watch is a long-lived loop and awaiting it here would never return.
		// A broker that is not up yet is handled by the loop's own retry, not by failing boot — the
		// engine can still resolve over RPC, and a media server that is up must be able to answer.
		void this.runWatchLoop();
		await Promise.resolve();
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		this.watchAbort?.();
		this.cache.clear();
		await Promise.resolve();
	}

	/**
	 * The organization's artifact, or `undefined` when it cannot be obtained.
	 *
	 * `undefined` is a real answer and must be treated as one: the caller has a live call and no
	 * routing for it, which is a rejection, never a guess.
	 */
	async get(organizationId: string): Promise<RoutingArtifact | undefined> {
		const cached = this.cache.get(organizationId);
		if (cached !== undefined) {
			this.hits += 1;
			return cached.artifact;
		}

		const existing = this.inFlight.get(organizationId);
		if (existing !== undefined) {
			return await existing;
		}

		const pending = this.load(organizationId).finally(() => {
			this.inFlight.delete(organizationId);
		});
		this.inFlight.set(organizationId, pending);
		return await pending;
	}

	/**
	 * Resolves a media-server endpoint name back to the trunk row it dials.
	 *
	 * The dial template (`PJSIP/{number}@{trunk}`) substitutes the trunk's NAME for `{trunk}`, so
	 * the PJSIP endpoint the qualify pings IS the trunk name — and the compiled artifact's
	 * `trunk-dial` attempts carry both that name and the `trunkId` beside it, which makes the
	 * artifact the reverse index this lookup needs. The scan walks every artifact this process
	 * holds, because a `PeerStatusChange` arrives with no organization on it at all: the
	 * organization is the ANSWER here, not an input.
	 *
	 * Memory-only, deliberately. A qualify tick must not become a KV read or a compile — the miss
	 * path exists for calls, which have a caller waiting, and a trunk status has nobody waiting.
	 * The cache is well populated in practice because the KV watch above `remember`s every
	 * artifact any API instance compiles, not only the ones this engine has routed calls with; an
	 * endpoint this process cannot name is reported as unresolved and the publisher says so once.
	 *
	 * A linear scan and not an index, on the numbers: artifacts are per-organization, trunk-dial
	 * nodes are a handful per artifact, and a transition (not a tick — see `toMediaEvent`) is the
	 * only caller. An index would be a second copy of the artifacts to keep coherent for an event
	 * that fires when a carrier goes down.
	 */
	findTrunkEndpoint(
		endpointName: string,
	): { readonly organizationId: string; readonly trunkId: string } | undefined {
		for (const entry of this.cache.values()) {
			for (const node of Object.values(entry.artifact.nodes)) {
				if (node.kind !== "trunk-dial") {
					continue;
				}
				for (const attempt of node.attempts) {
					if (attempt.name === endpointName) {
						return {
							organizationId: entry.artifact.organizationId,
							trunkId: attempt.trunkId,
						};
					}
				}
			}
		}
		return undefined;
	}

	/** Drops one organization's memory copy. The KV watch calls it; so may an operator endpoint. */
	invalidate(organizationId: string): void {
		if (this.cache.delete(organizationId)) {
			this.invalidations += 1;
		}
	}

	/** Drops every memory copy. Used when the watch dies and this process is no longer informed. */
	invalidateAll(): void {
		this.invalidations += this.cache.size;
		this.cache.clear();
	}

	/** Puts an artifact into the memory cache. Used by the KV watch and by the RPC path. */
	private remember(artifact: RoutingArtifact): void {
		this.cache.set(artifact.organizationId, { artifact, at: Date.now() });
	}

	private async load(organizationId: string): Promise<RoutingArtifact | undefined> {
		const fromKv = await this.readFromCache(organizationId);
		if (fromKv !== undefined) {
			this.remember(fromKv);
			return fromKv;
		}
		const fromRpc = await this.resolveOverRpc(organizationId);
		if (fromRpc !== undefined) {
			this.remember(fromRpc);
		}
		return fromRpc;
	}

	// -------------------------------------------------------------------------------------------
	// KV
	// -------------------------------------------------------------------------------------------

	private async readFromCache(organizationId: string): Promise<RoutingArtifact | undefined> {
		const bucket = this.jetstream.routingCache;
		if (bucket === undefined) {
			return undefined;
		}
		this.kvReads += 1;
		try {
			const entry = await bucket.get(routingCacheKey(organizationId));
			if (entry === null || entry.value.length === 0) {
				return undefined;
			}
			return this.parse(entry.value, organizationId);
		} catch (error) {
			this.logger.warn(
				{ organizationId, err: String(error) },
				"failed to read the routing artifact from KV; falling back to the resolve rpc",
			);
			return undefined;
		}
	}

	/**
	 * Parses one KV value.
	 *
	 * A version mismatch and a shape error are both answered with `undefined` after a log at WARN,
	 * which sends the caller to the RPC path and therefore to a recompile. That is the documented
	 * contract, and it is also the only safe reading: the alternative is executing a plan whose
	 * node shapes this release does not agree with.
	 */
	private parse(value: Uint8Array, organizationId: string): RoutingArtifact | undefined {
		try {
			const artifact = parseRoutingArtifact(JSON.parse(new TextDecoder().decode(value)));
			if (artifact.organizationId !== organizationId) {
				// A key that names one org holding another's artifact is a tenancy bug, not a cache
				// miss. Refusing it here is the last line before a call is routed by the wrong
				// tenant's configuration.
				this.logger.error(
					{ organizationId, artifactOrganizationId: artifact.organizationId },
					"discarding a routing artifact filed under another organization's key",
				);
				return undefined;
			}
			return artifact;
		} catch (error) {
			this.logger.warn(
				{
					organizationId,
					versionMismatch: error instanceof RoutingArtifactVersionError,
					err: String(error),
				},
				"discarding an unreadable routing artifact from KV",
			);
			return undefined;
		}
	}

	/**
	 * Follows the bucket, replacing memory copies as they change.
	 *
	 * The keys are `<orgId>.artifact`, so the organization is the first token. A `DEL`/`PURGE`
	 * arrives with an empty value and means "recompile on next use", which is an invalidation
	 * rather than a replacement.
	 */
	private async runWatchLoop(): Promise<void> {
		let attempt = 0;
		while (!this.stopped) {
			const bucket = this.jetstream.routingCache;
			if (bucket === undefined) {
				await this.sleep(backoffMs(attempt));
				attempt += 1;
				continue;
			}
			try {
				const watch = await bucket.watch({ key: `*.${ROUTING_CACHE_ARTIFACT_NAME}` });
				this.watchAbort = () => {
					watch.stop();
				};
				this.watching = true;
				attempt = 0;
				this.logger.info("watching the routing-cache KV bucket for artifact updates");
				for await (const entry of watch) {
					if (this.stopped) {
						break;
					}
					this.applyWatchEntry(entry.key, entry.operation, entry.value);
				}
			} catch (error) {
				if (!this.stopped) {
					this.logger.warn(
						{ err: String(error) },
						"the routing-cache watch ended; artifacts will be re-read on the next call",
					);
				}
			}
			this.watching = false;
			this.watchAbort = undefined;
			// Every memory copy is now unverified: this process stopped being told about changes,
			// so it must stop acting as if it knows they have not happened.
			this.invalidateAll();
			if (this.stopped) {
				return;
			}
			await this.sleep(backoffMs(attempt));
			attempt += 1;
		}
	}

	private applyWatchEntry(key: string, operation: string, value: Uint8Array): void {
		const organizationId = key.split(".")[0];
		if (organizationId === undefined || organizationId === "") {
			return;
		}
		if (operation !== "PUT" || value.length === 0) {
			this.invalidate(organizationId);
			return;
		}
		const artifact = this.parse(value, organizationId);
		if (artifact === undefined) {
			this.invalidate(organizationId);
			return;
		}
		const previous = this.cache.get(organizationId);
		if (previous?.artifact.snapshotHash === artifact.snapshotHash) {
			// A recompile that produced the same content hash. Nothing routing reads changed, so
			// keeping the existing entry avoids churning the object every call is holding.
			return;
		}
		this.remember(artifact);
		this.invalidations += 1;
		this.logger.info(
			{ organizationId, snapshotHash: artifact.snapshotHash },
			"applied a routing artifact update from KV",
		);
	}

	// -------------------------------------------------------------------------------------------
	// RPC
	// -------------------------------------------------------------------------------------------

	/**
	 * The cache-miss path.
	 *
	 * Only the `artifact` is used; the reply's `matched` / `destinationType` describe a resolve the
	 * API performed against its own idea of the call's facts, and the engine re-resolves locally
	 * with the facts it actually has. Trusting the reply's decision would put the routing decision
	 * in the process that does not hold the channel.
	 */
	private async resolveOverRpc(organizationId: string): Promise<RoutingArtifact | undefined> {
		this.rpcCalls += 1;
		const request: RoutingResolveRequest = {
			orgId: organizationId,
			direction: "inbound",
			// The subject of this call is the ARTIFACT, not one number. A destination is required by
			// the contract, so a deliberately inert placeholder is sent rather than a real DID that
			// would make the API's own resolve look like a real call in its logs.
			destinationNumber: "artifact",
			routingContext: "inbound",
			at: new Date().toISOString(),
		};

		let reply: RoutingResolveResponse;
		try {
			reply = routingResolveResponseSchema.parse(
				await firstValueFrom(
					this.client
						.send(ROUTING_RESOLVE_RPC.subject, request)
						.pipe(timeout(this.env.ENGINE_ROUTING_RPC_TIMEOUT_MS)),
				),
			);
		} catch (error) {
			this.logger.error(
				{ organizationId, err: String(error) },
				"rpc.routing.v1.resolve failed; the call has no routing to execute",
			);
			return undefined;
		}

		if (reply.artifact === undefined) {
			this.logger.error(
				{ organizationId, reason: reply.reason },
				"rpc.routing.v1.resolve returned no artifact",
			);
			return undefined;
		}

		try {
			const artifact = parseRoutingArtifact(reply.artifact);
			if (artifact.organizationId !== organizationId) {
				this.logger.error(
					{ organizationId, artifactOrganizationId: artifact.organizationId },
					"refusing a routing artifact compiled for a different organization",
				);
				return undefined;
			}
			return artifact;
		} catch (error) {
			this.logger.error(
				{
					organizationId,
					versionMismatch: error instanceof RoutingArtifactVersionError,
					err: String(error),
				},
				"rpc.routing.v1.resolve returned an artifact this release cannot read",
			);
			return undefined;
		}
	}

	private async sleep(ms: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			timer.unref?.();
		});
	}
}

/** Capped exponential backoff for the watch loop: 250 ms → 8 s. */
function backoffMs(attempt: number): number {
	return Math.min(8_000, 250 * 2 ** Math.min(attempt, 5));
}
