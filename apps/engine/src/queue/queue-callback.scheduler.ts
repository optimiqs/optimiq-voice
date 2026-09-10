import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { AgentStateStore } from "./agent-state.store";
import { QueueCallbackRunner } from "./queue-callback";
import { QueueCallbackDialerService } from "./queue-callback.dialer";
import { QueueEventPublisher } from "./queue-event-publisher.service";
import { QueueMembershipSource } from "./queue-membership.source";
import { QueueWaitingStore } from "./queue-waiting.store";
import type { QueueCallbackPlan } from "@optimiq-voice/routing";

/**
 * The clock virtual hold runs on.
 *
 * ## Why registration and not enumeration
 *
 * There is no list of "queues that owe somebody a call" to walk. The tokens live in one KV record
 * per queue, keyed by the queue, and reading every key on the bucket once a minute to find the two
 * that matter is a scan whose cost grows with the tenant's queue count rather than with the feature.
 * So a queue is REGISTERED at the moment a promise is made — `QueueSession` writes the token and
 * says so — and forgotten once no token registered on it could still be alive. The map is therefore
 * the size of the outstanding promises, which is the thing this actually iterates.
 *
 * That also makes the restart behaviour explicit and worth stating: an engine that restarts forgets
 * its registrations, and the tokens outlive it in the bucket. They are picked up again the next
 * time anybody joins that queue — which for a queue busy enough to be offering callbacks is
 * seconds, and for one that is not, the tokens expire on their own `expiresAfterSeconds`. The
 * alternative, a bucket scan at boot, is the scan this design exists to avoid.
 *
 * ## One timer for every queue
 *
 * Not one per queue: a fleet with two hundred queues would hold two hundred timers to do the work
 * of one loop, and each of them would be a thing to clear on shutdown. `unref` so a draining engine
 * is not held open by it, and `onApplicationShutdown` clears it anyway — an unref'd timer that is
 * never cleared still fires during the drain, and a callback placed onto an instance that is
 * refusing new work is a customer rung by a process that cannot serve them.
 */
@Injectable()
export class QueueCallbackScheduler implements OnApplicationShutdown {
	private readonly logger = getLogger("engine.queue-callback");
	private readonly runners = new Map<string, QueueCallbackRunner>();
	/**
	 * When each queue may be forgotten — the latest instant a token registered now could still be
	 * alive, from the plan's own `expiresAfterSeconds`.
	 *
	 * NOT a count of empty sweeps, and that distinction is the whole of it: a token deferred after a
	 * failed attempt is not DUE for `retryDelaySeconds`, so it reads as an empty sweep for minutes.
	 * Forgetting the queue on that would deregister exactly the queues that are mid-retry and turn
	 * every `maxAttempts: 3` into one attempt.
	 */
	private readonly forgetAfter = new Map<string, number>();
	private timer: NodeJS.Timeout | undefined;
	private sweeping = false;
	private ticks = 0;

	constructor(
		private readonly membership: QueueMembershipSource,
		private readonly agents: AgentStateStore,
		private readonly waiting: QueueWaitingStore,
		private readonly dialer: QueueCallbackDialerService,
		private readonly events: QueueEventPublisher,
	) {}

	/** How many queues are being swept, and how many sweeps have run. For the health endpoint. */
	get stats(): { readonly queues: number; readonly ticks: number } {
		return { queues: this.runners.size, ticks: this.ticks };
	}

	/**
	 * Says that this queue owes somebody a call.
	 *
	 * Idempotent by (org, queue): a second promise on a queue already being swept pushes its forget
	 * deadline out and keeps the runner it has, because a runner holds no per-token state — every
	 * sweep reads the tokens fresh.
	 */
	register(
		orgId: string,
		queueId: string,
		plan: QueueCallbackPlan,
		options: { readonly queueNumber?: string; readonly intervalMs?: number } = {},
	): void {
		const key = `${orgId}/${queueId}`;
		this.forgetAfter.set(key, Date.now() + plan.expiresAfterSeconds * MILLIS_PER_SECOND);
		if (!this.runners.has(key)) {
			this.runners.set(
				key,
				new QueueCallbackRunner(
					orgId,
					queueId,
					plan,
					{
						membership: this.membership,
						agents: this.agents,
						callbacks: this.waiting,
						dialer: this.dialer,
						events: this.events,
					},
					{},
					options.queueNumber,
				),
			);
		}
		this.start(options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
	}

	/**
	 * One sweep across every registered queue. Exposed so a spec can run a pass and look at it,
	 * exactly as {@link QueueCallbackRunner.tick} is.
	 *
	 * Sequential, and re-entrancy-guarded. A sweep that overlapped itself would read the same token
	 * twice before the first pass had recorded its attempt, which is the unbounded retry loop the
	 * whole attempt budget exists to prevent.
	 */
	async sweep(): Promise<void> {
		if (this.sweeping) {
			return;
		}
		this.sweeping = true;
		this.ticks += 1;
		try {
			const now = Date.now();
			for (const [key, runner] of this.runners) {
				try {
					await runner.tick();
				} catch (error) {
					// The runner documents that its ports answer rather than throw. This is the defect
					// path, and it must not take the other queues' sweeps with it.
					this.logger.error({ queue: key, err: error }, "a queue callback sweep threw");
				}
				if ((this.forgetAfter.get(key) ?? 0) <= now) {
					this.runners.delete(key);
					this.forgetAfter.delete(key);
				}
			}
		} finally {
			this.sweeping = false;
		}
		if (this.runners.size === 0) {
			this.stop();
		}
	}

	onApplicationShutdown(): void {
		this.stop();
		this.runners.clear();
		this.forgetAfter.clear();
	}

	private start(intervalMs: number): void {
		if (this.timer !== undefined) {
			return;
		}
		this.timer = setInterval(() => {
			void this.sweep();
		}, intervalMs);
		this.timer.unref?.();
	}

	private stop(): void {
		if (this.timer === undefined) {
			return;
		}
		clearInterval(this.timer);
		this.timer = undefined;
	}
}

/**
 * How often the sweep runs.
 *
 * Ten seconds, and the number is chosen against the PROMISE rather than against the load. A caller
 * who was told "we will ring you when somebody is free" and is rung ten seconds after that moment
 * has been treated well; one rung a minute after it has watched an agent take two other calls. The
 * cost is one KV read per queue that owes somebody a call, and the map holds only those.
 */
const DEFAULT_SWEEP_INTERVAL_MS = 10_000;

const MILLIS_PER_SECOND = 1_000;
