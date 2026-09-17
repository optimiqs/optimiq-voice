import { z } from "zod";
import { subjectFor, type QueueEvent } from "../subjects";
import { defineEvent, makeEvent, type EventInput } from "./envelope";
import { agentStatusSchema } from "./telephony";

/**
 * Queue / ACD events — `queue.evt.v1.<orgId>.<queueId>.<event>`.
 *
 * `queueId` is subject-carried and therefore absent from the payloads. `agent.state` is the one
 * event that is not intrinsically per-queue: an agent has ONE status across every tier they sit
 * in. Publish it either on the queue whose distribution it affects, or once on the reserved
 * org-wide scope token {@link import("../subjects").QUEUE_SCOPE_ALL} — wallboards subscribe to
 * `queue.evt.v1.<org>.>` and see both.
 */

/** `caller.joined` — a call entered the queue and is now waiting. */
export const queueCallerJoinedDataSchema = z.object({
	callId: z.uuid(),
	legId: z.uuid(),
	/** 1-based position at the moment of joining. */
	position: z.int().min(1),
	/** Higher wins. Matches the queue's configured priority scale. */
	priority: z.int().min(0).max(1000),
	/** The caller's number, for the wallboard. */
	callerNumber: z.string().max(128).optional(),
	/**
	 * True when this caller rang back inside the queue's discard window and was restored to the
	 * place they had before they hung up (`queue.abandoned_resume_allowed`).
	 *
	 * Worth reporting rather than leaving implicit, because without it a wallboard shows a caller
	 * arriving at position 2 ahead of somebody who has been holding for a minute and the supervisor
	 * watching it has no way to tell a restored place from a bug. Absent means what it has always
	 * meant: a caller who joined at the back.
	 */
	resumed: z.boolean().optional(),
});

/** `caller.answered` — an agent took the call; the wait is over. */
export const queueCallerAnsweredDataSchema = z.object({
	callId: z.uuid(),
	legId: z.uuid(),
	agentId: z.uuid(),
	/** Time between `caller.joined` and answer. The SLA metric. */
	waitMs: z.int().min(0),
	/** Which distribution strategy selected this agent. */
	strategy: z
		.enum(["longest-idle", "ring-all", "round-robin", "top-down", "sequential", "random"])
		.optional(),
});

/**
 * `caller.abandoned` — the caller left the line without an agent taking them.
 *
 * ## Why one event covers five different endings
 *
 * Because an SLA report asks one question — "did this caller get served?" — and every value of
 * `reason` is a no. Splitting them into separate events would make "offered calls" a sum over four
 * subjects that nobody remembers to keep in step, and the first time somebody adds a fifth ending
 * every existing report would silently under-count. The discriminator is a field precisely so that
 * adding an ending cannot break the arithmetic.
 *
 * `exit-key` is the newest of them and is deliberately NOT folded into `overflow`. A caller who
 * pressed 2 to leave a voicemail chose to stop waiting; a caller sent to an overflow destination had
 * the choice made for them. They belong in the same "not served by an agent" bucket for the SLA and
 * in different rows on the report a supervisor reads to decide whether the exit key is working.
 *
 * `callback` is the one ending that is not a loss. The caller accepted virtual hold: they left the
 * line, their place is held as a resume tombstone, and the system owes them a call. It is published
 * as an abandonment because that is what the LINE saw — everybody behind them moved up — and it is
 * its own reason because an SLA that counted it as a caller who gave up would penalise a queue for
 * the feature working.
 */
export const queueCallerAbandonedDataSchema = z.object({
	callId: z.uuid(),
	legId: z.uuid(),
	waitMs: z.int().min(0),
	/** Position at the moment of abandonment — how close they got. */
	position: z.int().min(1).optional(),
	reason: z
		.enum(["caller-hangup", "timeout", "overflow", "no-agents", "exit-key", "callback"])
		.optional(),
	/** The digit they pressed, when `reason` is `exit-key`. Which key was used is the report. */
	exitKey: z.string().min(1).max(1).optional(),
});

/** `agent.state` — the agent's status changed. Drives distribution and the wallboard. */
export const queueAgentStateDataSchema = z.object({
	agentId: z.uuid(),
	status: agentStatusSchema,
	/** Previous status, when the publisher knows it. Makes the stream a transition log. */
	previousStatus: agentStatusSchema.optional(),
	/** Queues this status applies to; omit when it applies to every queue the agent serves. */
	queueIds: z.array(z.uuid()).max(200).optional(),
	/** Free-text break/unavailable reason. */
	reason: z.string().max(128).optional(),
});

/**
 * `callback.placed` — virtual hold made good: the queue dialled the caller back.
 *
 * Published when the CALL EXISTS, not when the caller answers, for the reason
 * `rpc.engine.v1.queue-callback` answers on creation: the ring is minutes of wall clock and a report
 * that waited for it would attribute the attempt to whenever somebody picked up. Whether they
 * answered is `caller.joined` on the same queue a moment later, carrying the same `callId`.
 *
 * `originalCallId` is the CDR link. A callback is a new call with a new `call_id`, so the only thing
 * that relates it to the wait it settles is this field and the `related_call_id` column it feeds —
 * see `packages/cdr-db`.
 */
export const queueCallbackPlacedDataSchema = z.object({
	/** The call the engine created for the callback. */
	callId: z.uuid(),
	/** The queued call the caller accepted the offer on. The link across the two `call_id`s. */
	originalCallId: z.uuid().optional(),
	/** The number dialled — the one the caller presented when they were waiting. */
	callerNumber: z.string().min(1).max(128),
	/** Attempts already spent on this token, `0` on the first. */
	attempts: z.int().min(0).max(10),
	/** How long the held place had been waiting to be called. The virtual-hold SLA. */
	heldMs: z.int().min(0),
});

/**
 * `callback.failed` — an attempt did not produce a call.
 *
 * One event for both endings, with `dropped` as the discriminator, by
 * {@link queueCallerAbandonedDataSchema}'s argument: "how many callback attempts failed" is one
 * question, and splitting the last one onto its own subject would make the count a sum over two
 * streams. `dropped: true` is the promise ending — the attempts are spent and nothing further will
 * be tried — and it is the only one worth alerting on.
 */
export const queueCallbackFailedDataSchema = z.object({
	callerNumber: z.string().min(1).max(128),
	/** Attempts spent INCLUDING this one. */
	attempts: z.int().min(1).max(10),
	/** True when the token was given up on rather than deferred to another attempt. */
	dropped: z.boolean(),
	/** The engine's refusal code, verbatim, so an operator can tell busy from unroutable. */
	reason: z.string().max(64).optional(),
});

export const QUEUE_EVENT_DEFINITIONS = {
	"caller.joined": defineEvent("queue", "caller.joined", queueCallerJoinedDataSchema),
	"caller.answered": defineEvent("queue", "caller.answered", queueCallerAnsweredDataSchema),
	"caller.abandoned": defineEvent("queue", "caller.abandoned", queueCallerAbandonedDataSchema),
	"agent.state": defineEvent("queue", "agent.state", queueAgentStateDataSchema),
	"callback.placed": defineEvent("queue", "callback.placed", queueCallbackPlacedDataSchema),
	"callback.failed": defineEvent("queue", "callback.failed", queueCallbackFailedDataSchema),
} as const;

export type QueueEventDefinitions = typeof QUEUE_EVENT_DEFINITIONS;

export type QueueEventOf<TType extends QueueEvent> = z.infer<
	QueueEventDefinitions[TType]["envelope"]
>;

export type QueueEventDataOf<TType extends QueueEvent> = z.infer<
	QueueEventDefinitions[TType]["data"]
>;

/** Every queue event as one discriminated union. */
export const queueEventSchema = z.discriminatedUnion("type", [
	QUEUE_EVENT_DEFINITIONS["caller.joined"].envelope,
	QUEUE_EVENT_DEFINITIONS["caller.answered"].envelope,
	QUEUE_EVENT_DEFINITIONS["caller.abandoned"].envelope,
	QUEUE_EVENT_DEFINITIONS["agent.state"].envelope,
	QUEUE_EVENT_DEFINITIONS["callback.placed"].envelope,
	QUEUE_EVENT_DEFINITIONS["callback.failed"].envelope,
]);

export type QueueEventEnvelope = z.infer<typeof queueEventSchema>;

export interface QueueEventInput<TType extends QueueEvent> extends Omit<
	EventInput<QueueEventDataOf<TType>>,
	"subject"
> {
	/** Queue id, or `QUEUE_SCOPE_ALL` for an org-wide `agent.state`. */
	readonly queueId: string;
}

/** Builds and validates a queue event, deriving `queue.evt.v1.<orgId>.<queueId>.<type>`. */
export function makeQueueEvent<TType extends QueueEvent>(
	type: TType,
	input: QueueEventInput<TType>,
): QueueEventOf<TType> {
	const definition = QUEUE_EVENT_DEFINITIONS[type];
	const subject = subjectFor.queue(input.orgId, input.queueId, type);
	// See the note in `makeCallEvent`: the record index and the payload are correlated by `type`.
	return makeEvent(definition, { ...input, subject } as never) as QueueEventOf<TType>;
}
