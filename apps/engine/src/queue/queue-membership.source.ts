import { Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { kvKeyFor, queueMembershipSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "../nats/jetstream.service";
import type { QueueMembershipPort } from "./queue-session";
import type { QueueMembership } from "@optimiq-voice/events";

/**
 * Where the engine gets a queue's roster: the `queue-membership` KV bucket, cached behind a watch.
 *
 * ## Why this is cached and `did-index` is not
 *
 * `DidIndexSource` deliberately reads fresh on every call, because a stale entry attributes a call
 * to the WRONG TENANT — a billing error and an isolation breach at once. Nothing here has that
 * property. A stale roster rings an agent who just left (their leg fails, the loop moves on) or
 * misses one who just arrived (they are picked up on the next pass, a second later). Both
 * self-correct within one iteration of a loop that runs every second, and the alternative is a KV
 * round trip per second per waiting caller — on a system whose whole point is that the busy hour is
 * when queues have callers in them.
 *
 * So it is the `RoutingArtifactSource` pattern rather than the `DidIndexSource` one: memory first, a
 * KV watch for invalidation, and a point read on a miss. There is no RPC third layer, because there
 * is no compile step to fall back to — a queue with no entry in the bucket is a queue the control
 * plane has not published, which is a repair rather than a cache miss.
 *
 * ## A miss is `undefined`, and `undefined` is not "empty"
 *
 * The session refuses to distribute rather than treating an unreadable roster as a queue with no
 * agents, because those two produce identical caller experiences (ejected to the timeout branch)
 * from completely different causes. One is a Monday morning with nobody logged in; the other is a
 * control plane that never wrote the entry, and only one of them is fixed by telling people to log
 * in.
 *
 * ## The writer
 *
 * `apps/api`'s `QueueMembershipPublisher` `put`s here on every `queue`/`queue_agent`/`queue_tier`/
 * `extension` mutation (whole-org re-projection), exactly as it maintains `did-index` for
 * `phone_number`; `rebuild:queue-membership` backfills. Every log line here still names the bucket
 * so an empty queue in production says which projection to check.
 */
@Injectable()
export class QueueMembershipSource
	implements OnModuleInit, OnApplicationShutdown, QueueMembershipPort
{
	private readonly logger = getLogger("engine.queue-membership");
	private readonly cache = new Map<string, QueueMembership>();
	/** De-duplicates concurrent misses: twenty callers hitting one cold queue read once. */
	private readonly inFlight = new Map<string, Promise<QueueMembership | undefined>>();
	private watching = false;
	private stopped = false;
	private watchAbort: (() => void) | undefined;
	private hits = 0;
	private kvReads = 0;
	private misses = 0;
	private invalidations = 0;

	constructor(private readonly jetstream: JetStreamService) {}

	get stats(): {
		readonly cached: number;
		readonly hits: number;
		readonly kvReads: number;
		readonly misses: number;
		readonly invalidations: number;
		readonly watching: boolean;
	} {
		return {
			cached: this.cache.size,
			hits: this.hits,
			kvReads: this.kvReads,
			misses: this.misses,
			invalidations: this.invalidations,
			watching: this.watching,
		};
	}

	async onModuleInit(): Promise<void> {
		// Fire-and-forget, like the routing artifact watch: awaiting a long-lived loop here would
		// never return, and a broker that is not up yet must not fail the engine's boot.
		void this.runWatchLoop();
		await Promise.resolve();
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		this.watchAbort?.();
		this.cache.clear();
		await Promise.resolve();
	}

	/** The queue's roster, or `undefined` when it cannot be obtained. */
	async membershipFor(orgId: string, queueId: string): Promise<QueueMembership | undefined> {
		const key = this.keyFor(orgId, queueId);
		if (key === undefined) {
			return undefined;
		}

		const cached = this.cache.get(key);
		if (cached !== undefined) {
			this.hits += 1;
			return cached;
		}

		const existing = this.inFlight.get(key);
		if (existing !== undefined) {
			return await existing;
		}

		const pending = this.load(key, orgId, queueId).finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, pending);
		return await pending;
	}

	/** Drops one queue's memory copy. The watch calls it; so may an operator endpoint. */
	invalidate(key: string): void {
		if (this.cache.delete(key)) {
			this.invalidations += 1;
		}
	}

	invalidateAll(): void {
		this.invalidations += this.cache.size;
		this.cache.clear();
	}

	private keyFor(orgId: string, queueId: string): string | undefined {
		try {
			return kvKeyFor.queueMembership(orgId, queueId);
		} catch (error) {
			// An id that is not a subject token cannot have been written by the control plane either,
			// so there is nothing to look up. Logged rather than thrown: this runs on a live call.
			this.logger.warn({ orgId, queueId, err: String(error) }, "not a valid queue-membership key");
			return undefined;
		}
	}

	private async load(
		key: string,
		orgId: string,
		queueId: string,
	): Promise<QueueMembership | undefined> {
		const bucket = this.jetstream.queueMembership;
		if (bucket === undefined) {
			return undefined;
		}
		this.kvReads += 1;
		try {
			const entry = await bucket.get(key);
			if (entry === null || entry.value.length === 0) {
				this.misses += 1;
				this.logger.warn(
					{ orgId, queueId, key },
					"no entry in the queue-membership bucket; this queue has no roster the engine can distribute against",
				);
				return undefined;
			}
			const membership = this.parse(entry.value, orgId, queueId);
			if (membership === undefined) {
				this.misses += 1;
				return undefined;
			}
			this.cache.set(key, membership);
			return membership;
		} catch (error) {
			this.misses += 1;
			this.logger.warn(
				{ orgId, queueId, err: String(error) },
				"could not read the queue-membership bucket",
			);
			return undefined;
		}
	}

	/**
	 * Parses one entry, and refuses one filed under the wrong tenant.
	 *
	 * The org check is the same line of defence `RoutingArtifactSource` draws for artifacts: a value
	 * that names one organization sitting under another's key is a tenancy bug, and accepting it here
	 * would ring one tenant's agents for another tenant's caller.
	 */
	private parse(value: Uint8Array, orgId: string, queueId: string): QueueMembership | undefined {
		try {
			const membership = queueMembershipSchema.parse(
				JSON.parse(new TextDecoder().decode(value)) as unknown,
			);
			if (membership.orgId !== orgId || membership.queueId !== queueId) {
				this.logger.error(
					{ orgId, queueId, entryOrgId: membership.orgId, entryQueueId: membership.queueId },
					"discarding a queue-membership entry filed under another queue's key",
				);
				return undefined;
			}
			return membership;
		} catch (error) {
			this.logger.error(
				{ orgId, queueId, err: String(error) },
				"discarding an unreadable queue-membership entry",
			);
			return undefined;
		}
	}

	/**
	 * Follows the bucket, replacing memory copies as they change.
	 *
	 * A `PUT` replaces; a `DEL`/`PURGE` (empty value) invalidates. Both are the control plane telling
	 * this process the roster moved — a supervisor added somebody to a tier, and the next caller
	 * should reach them rather than waiting for a TTL that does not exist on this bucket.
	 */
	private async runWatchLoop(): Promise<void> {
		let attempt = 0;
		while (!this.stopped) {
			const bucket = this.jetstream.queueMembership;
			if (bucket === undefined) {
				await this.sleep(backoffMs(attempt));
				attempt += 1;
				continue;
			}
			try {
				const watch = await bucket.watch();
				this.watchAbort = () => {
					watch.stop();
				};
				this.watching = true;
				attempt = 0;
				this.logger.info("watching the queue-membership KV bucket for roster updates");
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
						"the queue-membership watch ended; rosters will be re-read on the next queued caller",
					);
				}
			}
			this.watching = false;
			this.watchAbort = undefined;
			// This process stopped being told about changes, so it must stop acting as if it knows
			// they have not happened. Same reasoning as the routing artifact watch.
			this.invalidateAll();
			if (this.stopped) {
				return;
			}
			await this.sleep(backoffMs(attempt));
			attempt += 1;
		}
	}

	private applyWatchEntry(key: string, operation: string, value: Uint8Array): void {
		const [orgId, queueId] = key.split(".");
		if (orgId === undefined || queueId === undefined) {
			return;
		}
		if (operation !== "PUT" || value.length === 0) {
			this.invalidate(key);
			return;
		}
		const membership = this.parse(value, orgId, queueId);
		if (membership === undefined) {
			this.invalidate(key);
			return;
		}
		this.cache.set(key, membership);
		this.invalidations += 1;
		this.logger.info(
			{ orgId, queueId, agents: membership.agents.length, revision: membership.revision },
			"applied a queue roster update from KV",
		);
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
