import { Inject, Injectable } from "@nestjs/common";
import { ClientProxy } from "@nestjs/microservices";
import { firstValueFrom } from "rxjs";
import { makeQueueEvent, QUEUE_SCOPE_ALL, validateEvent } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { CALL_EVENTS_CLIENT } from "../nats/nats.tokens";
import type { QueueEventPort } from "./queue-session";
import type { AgentStatus, QueueEvent, QueueEventDataOf } from "@optimiq-voice/events";

/**
 * Publishes ACD events on `queue.evt.v1.<orgId>.<queueId>.<event>`.
 *
 * ## Same transport as call events, and for the same reason
 *
 * A core publish through the Nest NATS client with the envelope-only serializer. The `QUEUES` stream
 * subscribes to `queue.evt.v1.>`, so these are captured, replayable and durably consumable; what is
 * given up is the per-message ack, which is the right trade for live state on the call path. A
 * wallboard that misses one `agent.state` is corrected by the next one; a queued caller who waits
 * for an ack is a queued caller who waits.
 *
 * It shares {@link CALL_EVENTS_CLIENT} rather than opening a third connection: the client is a NATS
 * connection with a serializer, the serializer is the one these envelopes need, and the SUBJECT is
 * what selects the stream. A second connection would buy nothing and cost a reconnect storm's worth
 * of extra sockets per engine.
 *
 * ## `agent.state` and the `_all` scope
 *
 * An agent has ONE status across every queue they sit in, so `agent.state` is not intrinsically a
 * per-queue fact. `packages/events` reserves {@link QUEUE_SCOPE_ALL} for exactly this, and that is
 * what this publishes on when the transition was not caused by a specific queue. When it WAS — a
 * distribution rang them, a call ended — the queue is named, because "which queue put this agent on
 * a call" is the question a supervisor asks about a spike, and a `_all` event cannot answer it.
 * Wallboards subscribe to `queue.evt.v1.<org>.>` and therefore see both.
 *
 * ## Validate before publish
 *
 * Built by `makeQueueEvent` (which validates) and re-validated against the schema its SUBJECT
 * selects — the cross-check that catches an envelope whose `orgId` disagrees with the org token in
 * its own subject. A malformed event is logged and dropped rather than thrown, because throwing here
 * would end a live call over a reporting defect.
 */
@Injectable()
export class QueueEventPublisher implements QueueEventPort {
	private readonly logger = getLogger("engine.queue-events");
	private published = 0;
	private rejected = 0;

	constructor(@Inject(CALL_EVENTS_CLIENT) private readonly client: ClientProxy) {}

	get publishedCount(): number {
		return this.published;
	}

	get rejectedCount(): number {
		return this.rejected;
	}

	async callerJoined(input: {
		readonly orgId: string;
		readonly queueId: string;
		readonly callId: string;
		readonly legId: string;
		readonly position: number;
		readonly priority: number;
		readonly callerNumber?: string;
	}): Promise<void> {
		await this.publish("caller.joined", input.orgId, input.queueId, {
			callId: input.callId,
			legId: input.legId,
			position: input.position,
			priority: input.priority,
			...(input.callerNumber === undefined ? {} : { callerNumber: input.callerNumber }),
		});
	}

	async callerAnswered(input: {
		readonly orgId: string;
		readonly queueId: string;
		readonly callId: string;
		readonly legId: string;
		readonly agentId: string;
		readonly waitMs: number;
		readonly strategy: string;
	}): Promise<void> {
		await this.publish("caller.answered", input.orgId, input.queueId, {
			callId: input.callId,
			legId: input.legId,
			agentId: input.agentId,
			waitMs: input.waitMs,
			// The event's own vocabulary is a subset of `pbx-db`'s (`top-down` and `sequential` are
			// both spelled out there). Anything outside it is omitted rather than coerced: a report
			// that says "some strategy" is honest, and one that says the wrong strategy is not.
			...(isReportableStrategy(input.strategy) ? { strategy: input.strategy } : {}),
		});
	}

	async callerAbandoned(input: {
		readonly orgId: string;
		readonly queueId: string;
		readonly callId: string;
		readonly legId: string;
		readonly waitMs: number;
		readonly position?: number;
		readonly reason: "caller-hangup" | "timeout" | "overflow" | "no-agents";
	}): Promise<void> {
		await this.publish("caller.abandoned", input.orgId, input.queueId, {
			callId: input.callId,
			legId: input.legId,
			waitMs: input.waitMs,
			reason: input.reason,
			...(input.position === undefined ? {} : { position: input.position }),
		});
	}

	/** An agent's status changed. `queueId` names the queue that caused it, when one did. */
	async agentState(input: {
		readonly orgId: string;
		readonly agentId: string;
		readonly status: AgentStatus;
		readonly previousStatus?: AgentStatus;
		readonly queueId?: string;
		readonly reason?: string;
	}): Promise<void> {
		await this.publish("agent.state", input.orgId, input.queueId ?? QUEUE_SCOPE_ALL, {
			agentId: input.agentId,
			status: input.status,
			...(input.previousStatus === undefined ? {} : { previousStatus: input.previousStatus }),
			...(input.queueId === undefined ? {} : { queueIds: [input.queueId] }),
			...(input.reason === undefined ? {} : { reason: input.reason }),
		});
	}

	private async publish<TType extends QueueEvent>(
		type: TType,
		orgId: string,
		queueId: string,
		data: QueueEventDataOf<TType>,
	): Promise<void> {
		let subject: string;
		let envelope: unknown;
		try {
			const built = makeQueueEvent(type, { orgId, queueId, source: "engine", data });
			subject = built.subject;
			envelope = built;
			validateEvent(subject, built);
		} catch (error) {
			this.rejected += 1;
			this.logger.error(
				{ type, orgId, queueId, err: String(error) },
				"refusing to publish a queue event that does not satisfy its contract",
			);
			return;
		}

		try {
			// `emit` returns a cold Observable; nothing is sent until it is subscribed to.
			await firstValueFrom(this.client.emit(subject, envelope));
			this.published += 1;
		} catch (error) {
			this.logger.error({ type, subject, err: String(error) }, "failed to publish a queue event");
		}
	}
}

const REPORTABLE_STRATEGIES = new Set([
	"longest-idle",
	"ring-all",
	"round-robin",
	"top-down",
	"sequential",
	"random",
]);

function isReportableStrategy(
	strategy: string,
): strategy is "longest-idle" | "ring-all" | "round-robin" | "top-down" | "sequential" | "random" {
	return REPORTABLE_STRATEGIES.has(strategy);
}
