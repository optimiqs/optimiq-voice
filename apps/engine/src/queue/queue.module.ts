import { Global, Module } from "@nestjs/common";
import { AgentStateStore } from "./agent-state.store";
import { QueueCallbackDialerService } from "./queue-callback.dialer";
import { QueueCallbackScheduler } from "./queue-callback.scheduler";
import { QueueEventPublisher } from "./queue-event-publisher.service";
import { QueueMembershipSource } from "./queue-membership.source";
import { QueueCursors } from "./queue-registry";
import { QueueWaitingStore } from "./queue-waiting.store";

/**
 * The ACD plane.
 *
 * `@Global` for the same reason `RoutingModule` is: every provider here is a cross-cutting singleton
 * whose IDENTITY is the point, and a second copy would be a bug rather than a duplicate.
 *
 * - A second {@link QueueMembershipSource} means two memory caches and two KV watches, with a window
 *   in which one is stale — so two callers to one queue would be distributed against two different
 *   rosters.
 * - A second {@link QueueWaitingStore} means two in-process lines on a deployment with no shared
 *   bucket — a caller counted in one and announced from the other — and two sets of write counters.
 * - A second {@link QueueCursors} means round-robin that never advances, because each distribution
 *   reads a cursor the other one wrote.
 *
 * {@link QueueSession} itself is NOT a provider, exactly as `PlanWalker` is not: one is constructed
 * per queued caller, over that caller's channel and that caller's node, and it holds per-call state
 * (the penalty box, the frozen `sequential` order, the announcement clock). A singleton would need a
 * map keyed by call and would be one bug away from serving one caller's position to another.
 *
 * {@link QueueCallbackScheduler} IS a provider, and is the one thing here that owns a timer. It has
 * to be a singleton for the reason the cursors do: two schedulers would be two sweeps over the same
 * tokens, and a token read twice before either pass recorded its attempt is a customer rung twice.
 * Its timer is cleared on `onApplicationShutdown`, so a draining engine leaks nothing.
 */
@Global()
@Module({
	providers: [
		QueueEventPublisher,
		QueueCallbackDialerService,
		QueueCallbackScheduler,
		AgentStateStore,
		QueueMembershipSource,
		QueueWaitingStore,
		QueueCursors,
	],
	exports: [
		QueueEventPublisher,
		QueueCallbackScheduler,
		AgentStateStore,
		QueueMembershipSource,
		QueueWaitingStore,
		QueueCursors,
	],
})
export class QueueModule {}
