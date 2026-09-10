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
 * ## A watch can stop delivering without ever dying, so it is also POLLED
 *
 * The failure that made this necessary was found live and is worth naming, because nothing in the
 * client reports it. `kv.watch()` is an ordered push consumer with `flow_control: true`: every few
 * seconds the broker asks the client to acknowledge the window on `$JS.FC.<stream>.<consumer>.<n>`,
 * and if that reply never lands the broker simply stops pushing. The subscription stays open, the
 * iterator stays alive, `sub.closed` never resolves, no error is ever surfaced — the entries just
 * stop, permanently. A broker-side publish permission that omits `$JS.FC.>` produces exactly this,
 * and so does any other reason the reply cannot get through.
 *
 * So the watch is not trusted to report its own death. {@link RoutingArtifactSource.runStaleGuard}
 * compares the highest revision the watch has delivered against the bucket's own last revision, and
 * when the bucket has moved on and the watch has not, it tears the watch down — which puts it
 * through the same reconnect-and-`invalidateAll` path a broker restart does. That is self-healing
 * rather than a fix: the underlying cause is still whatever stopped the flow-control reply, which
 * is why the recovery logs at WARN and is counted rather than being handled quietly.
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

/**
 * How long a memory copy is served without going back to the bucket.
 *
 * The watch is still the real invalidation; this is the backstop the class note above describes, for
 * the window where the watch is nominally alive but has stopped delivering. It mirrors the bucket's
 * own 1 h TTL, so an entry this process would keep forever expires the same way the stored one does.
 */
const CACHE_TTL_MS = 3_600_000;

/**
 * How long the watch may deliver NOTHING before its memory copies stop being trusted.
 *
 * The class note above names the failure this closes, and an end-to-end run found it: this process's
 * watch iterator stayed alive yielding nothing — no error, so no reconnect, so no `invalidateAll`.
 * Every plan the UI published after that moment compiled, stored and never arrived, and calls walked
 * the old artifact for as long as the process lived. `CACHE_TTL_MS` was nominally the backstop, but
 * an hour of routing a tenant's calls to the destination they deleted is not a backstop.
 *
 * The cause turned out to be the broker refusing the watch's flow-control reply, not anything the
 * bucket did — see the class note. This rule stays regardless of the cause, because it is the rule
 * that makes a memory copy only as trustworthy as the channel that would have invalidated it.
 *
 * Ninety seconds, because that is the shape of the signal rather than a guess at traffic: a healthy
 * watch delivers on every compile any tenant makes, and a fleet that has published nothing for a
 * minute and a half costs one KV read per call to find that out — the same read the miss path
 * already makes. Being slightly too eager here buys a read; being too patient routes a call wrong.
 */
const WATCH_SILENCE_MS = 90_000;

/**
 * How many organizations' artifacts this process holds at once.
 *
 * The watch `remember`s every key any API instance writes, not only the ones this engine has routed
 * a call for, so on a large fleet an unbounded map grows to one full node table per tenant that has
 * ever been compiled. Eviction is least-recently-remembered: `Map` keeps insertion order and
 * {@link RoutingArtifactSource.remember} re-inserts.
 */
const CACHE_MAX_ENTRIES = 500;

/**
 * How many consecutive probes must see the bucket ahead of the watch before it is re-established.
 *
 * The probe itself runs every `ENGINE_ROUTING_WATCH_PROBE_MS`, and what it compares is revisions,
 * not silence: {@link WATCH_SILENCE_MS} stops a stalled watch from being BELIEVED, but silence
 * cannot tell a wedged iterator from a fleet nobody is configuring, and only "has the BUCKET moved
 * past what this watch delivered" can.
 *
 * One strike is not enough: a `put` that landed between the last delivery and the probe is a gap
 * that closes by itself milliseconds later, and re-creating the consumer for it would churn the
 * watch on every write. Two puts a full probe interval of delivery time on the far side of the
 * write, which is four orders of magnitude more than a push consumer needs.
 */
const WATCH_STALE_STRIKES = 2;

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
	/**
	 * When the watch last DELIVERED anything, whether or not it changed the cache.
	 *
	 * Separate from `invalidations`, and the difference is the whole point: a recompile that
	 * produced the same hash is a delivered entry that changes no counter, so a watch which has
	 * stopped delivering and a tenant whose configuration is simply quiet look identical through
	 * `invalidations` alone. This one distinguishes them, and it is the field to look at when a
	 * change has been saved in the UI and the call path is still walking the old plan: `watching`
	 * can be true — the iterator is alive and yielding nothing — while this timestamp stands still.
	 */
	private lastWatchEntryAt: number | undefined;
	/** When the current watch iterator started, so a fresh watch is not judged for its silence. */
	private watchStartedAt = Date.now();
	/** Highest KV revision the CURRENT watch delivered. Reset every time the watch is re-established. */
	private watchRevision = 0;
	/**
	 * A bucket revision a demonstrably healthy watch could not reach, and which is therefore not
	 * evidence of a stall.
	 *
	 * The bucket's last revision counts every write ever made to it; a watch started on last-value
	 * only ever sees the newest write per key, so a key whose newest write was later superseded and
	 * compacted away leaves a gap no re-establish will ever close. Without this, such a gap would
	 * re-create the watch every probe for the life of the process. Recording the
	 * revision at each recovery makes the gap cost one re-establish, and detection still works,
	 * because the next real write pushes the bucket past it.
	 */
	private settledRevision = 0;
	private staleStrikes = 0;
	/** How many times the guard found the watch stalled and re-established it. `/healthz` reads it. */
	private staleRecoveries = 0;

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
		readonly watchRevision: number;
		readonly staleRecoveries: number;
		readonly lastWatchEntryAt?: string;
	} {
		return {
			cached: this.cache.size,
			hits: this.hits,
			kvReads: this.kvReads,
			rpcCalls: this.rpcCalls,
			invalidations: this.invalidations,
			watching: this.watching,
			watchRevision: this.watchRevision,
			staleRecoveries: this.staleRecoveries,
			...(this.lastWatchEntryAt === undefined
				? {}
				: { lastWatchEntryAt: new Date(this.lastWatchEntryAt).toISOString() }),
		};
	}

	async onModuleInit(): Promise<void> {
		// Fire-and-forget: the watch is a long-lived loop and awaiting it here would never return.
		// A broker that is not up yet is handled by the loop's own retry, not by failing boot — the
		// engine can still resolve over RPC, and a media server that is up must be able to answer.
		// `.catch` and not a bare `void`: a throw that escapes the loop would otherwise be an
		// unhandled rejection, which is a process-level crash under `--unhandled-rejections=strict`
		// and, worse, a silently absent watch under the default.
		void this.runWatchLoop().catch((error: unknown) => {
			this.logger.error({ err: String(error) }, "the routing-cache watch loop exited");
		});
		void this.runStaleGuard().catch((error: unknown) => {
			this.logger.error({ err: String(error) }, "the routing-cache watch guard exited");
		});
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
			if (Date.now() - cached.at < CACHE_TTL_MS && this.watchIsCurrent()) {
				this.hits += 1;
				return cached.artifact;
			}
			this.cache.delete(organizationId);
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
	 * Whether the invalidation channel is behaving, which is what makes a memory copy trustworthy.
	 *
	 * A copy is only as current as the thing that would tell this process it had changed. A watch
	 * that is not running says so outright; one that is running but has delivered nothing for
	 * {@link WATCH_SILENCE_MS} cannot be distinguished from a dead one from in here, and the two
	 * must therefore be treated the same — see the constant for the incident that proves it. The
	 * cost of being wrong is a KV read the miss path already knows how to make; the cost of the
	 * other answer is a call routed by a plan the tenant deleted.
	 */
	private watchIsCurrent(): boolean {
		// Only the silence is checked, not `watching`: a watch that ENDS already drops every memory
		// copy through `invalidateAll`, so there is nothing here for a `watching === false` clause to
		// protect — and asserting it would turn a broker outage, when the KV read this would force is
		// the one thing certain to fail, into a compile per call.
		//
		// A watch that has only just started has legitimately delivered nothing yet, so the clock runs
		// from when this iterator began rather than from an absent timestamp.
		return Date.now() - (this.lastWatchEntryAt ?? this.watchStartedAt) < WATCH_SILENCE_MS;
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
		this.cache.delete(artifact.organizationId);
		this.cache.set(artifact.organizationId, { artifact, at: Date.now() });
		while (this.cache.size > CACHE_MAX_ENTRIES) {
			const oldest = this.cache.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.cache.delete(oldest.value);
		}
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
				this.watchStartedAt = Date.now();
				// A new iterator has delivered nothing yet, so the previous one's high-water mark
				// must not vouch for it — this is the number the guard's comparison rests on.
				this.watchRevision = 0;
				this.staleStrikes = 0;
				attempt = 0;
				this.logger.info("watching the routing-cache KV bucket for artifact updates");
				for await (const entry of watch) {
					if (this.stopped) {
						break;
					}
					this.applyWatchEntry(entry.key, entry.operation, entry.value, entry.revision);
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

	private applyWatchEntry(key: string, operation: string, value: Uint8Array, revision = 0): void {
		this.lastWatchEntryAt = Date.now();
		if (revision > this.watchRevision) {
			this.watchRevision = revision;
		}
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

	/**
	 * Re-establishes a watch the bucket has left behind.
	 *
	 * The oracle is the bucket's own last revision, read from its stream state. Every key in
	 * `routing-cache` is an `<orgId>.artifact` written by `apps/api`, and the watch's filter covers
	 * all of them, so the last revision is a number a healthy watch must have reached. When it has
	 * not, and has still not one probe later, the iterator is wedged — see the class note for the
	 * flow-control mechanism that wedges it — and the only recovery from inside this process is to
	 * throw the consumer away and take a new one.
	 *
	 * `watchAbort` is deliberately how that is done, rather than a second reconnect path: stopping
	 * the iterator ends the `for await` in {@link runWatchLoop}, which drops every memory copy and
	 * reconnects exactly as a broker restart already does. One recovery path, not two.
	 */
	private async runStaleGuard(): Promise<void> {
		while (!this.stopped) {
			await this.sleep(this.env.ENGINE_ROUTING_WATCH_PROBE_MS);
			if (this.stopped) {
				return;
			}
			const bucket = this.jetstream.routingCache;
			// A watch that is not running is the reconnect loop's problem, and it is already on it.
			if (bucket === undefined || !this.watching) {
				this.staleStrikes = 0;
				continue;
			}
			let bucketRevision: number;
			try {
				bucketRevision = (await bucket.status()).streamInfo.state.last_seq;
			} catch (error) {
				// An unreadable status is not evidence of a stalled watch — it is evidence of a
				// broker this process cannot talk to, which the connection layer reports.
				this.logger.warn(
					{ err: String(error) },
					"could not read the routing-cache bucket status; leaving the watch alone",
				);
				continue;
			}
			if (bucketRevision <= Math.max(this.watchRevision, this.settledRevision)) {
				this.staleStrikes = 0;
				continue;
			}
			this.staleStrikes += 1;
			if (this.staleStrikes < WATCH_STALE_STRIKES) {
				continue;
			}
			this.staleStrikes = 0;
			this.settledRevision = bucketRevision;
			this.staleRecoveries += 1;
			this.logger.warn(
				{
					bucketRevision,
					watchRevision: this.watchRevision,
					staleRecoveries: this.staleRecoveries,
					...(this.lastWatchEntryAt === undefined
						? {}
						: { lastWatchEntryAt: new Date(this.lastWatchEntryAt).toISOString() }),
				},
				"the routing-cache watch is alive but behind the bucket; re-establishing it. " +
					"A watch that stalls without ending is usually the broker's flow-control reply " +
					"being refused — check the engine's publish grant for $JS.FC.>",
			);
			this.watchAbort?.();
		}
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
