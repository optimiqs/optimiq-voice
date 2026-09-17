/**
 * Virtual hold, from the platform's side of the promise.
 *
 * `queue-session.ts` covers the caller's half: they are offered a callback, they accept, their place
 * is written as a resume tombstone carrying a `callback` block, and their call ends. This file is
 * the other half — the thing that notices an agent is free, dials the number back, and gives up
 * honestly when it cannot.
 *
 * # Why a runner and not a queue session
 *
 * Because there is no call. Every other part of the ACD plane hangs off a leg the engine is already
 * holding, and its lifetime is that leg's lifetime. A callback has neither: the caller hung up
 * minutes ago and nothing is waiting on the outcome. So it is a periodic sweep over one queue's
 * tokens, and it is written as a class with an explicit {@link QueueCallbackRunner.tick} rather than
 * a timer that owns itself, for the reason `QueueSessionSettings.scheduleReleaseRetry` gives: a spec
 * has to be able to run one pass and look at the result, and a production timer that refs the
 * process is how an engine stops draining.
 *
 * # Why it checks for a free agent before dialling
 *
 * The promise was "we will call you when somebody is free", and calling before that is worse than
 * not calling at all: the caller answers, is put straight back on hold, and has now been interrupted
 * as well as kept waiting. So the gate is the same `isEligibleForDistribution` the distribution loop
 * uses — one definition of "an agent could take this call", used on both sides of the promise.
 *
 * # What a failed attempt costs
 *
 * One attempt, and a delay. {@link deferCallback} pushes the token forward by the queue's
 * `retryDelaySeconds` and drops it when the attempts are spent, so a number that is switched off
 * does not hold a place in the line forever and does not starve the tokens behind it. Dropping is
 * the honest end of the promise: the platform said it would call back, it called back as many times
 * as the tenant configured, and there is nothing further it can offer.
 */

import { isEligibleForDistribution } from "./agent-state";
import type { AgentStatePort, QueueMembershipPort } from "./queue-session";
import type { QueueResumeTombstone } from "@optimiq-voice/events/schemas";
import type { QueueCallbackPlan } from "@optimiq-voice/routing";

/** What a callback attempt asks the call plane for. */
export interface QueueCallbackRequest {
	readonly orgId: string;
	readonly queueId: string;
	/** The number to dial. Always the one the caller presented; never re-derived. */
	readonly callerNumber: string;
	/**
	 * What the callback presents as ITS caller id.
	 *
	 * The queue's identity, not the original caller's: the person answering is the customer, and
	 * showing them their own number would be nonsense. Absent means the call plane falls back to the
	 * organization's outbound caller id, which is the same cascade an outbound route uses.
	 */
	readonly callerIdNumber?: string;
	readonly callerIdName?: string;
	readonly ringTimeoutSeconds: number;
	/**
	 * The queue's own number, when it has one.
	 *
	 * Two jobs, both of them the call plane's: it is where the answered customer is put — the
	 * callback ends by walking this number, so the ordinary queue node distributes them to the
	 * ordinary agent and there is no second "connect the agent" path to keep in step — and it is
	 * where the outbound resolve reads the queue's toll class from. Absent means the call plane
	 * falls back to putting the leg into {@link queueId} directly, and has no entitlement to read.
	 */
	readonly queueNumber?: string;
	/**
	 * The queued call this settles. The cross-call CDR link.
	 *
	 * `call_legs` relates legs INSIDE one `call_id` and a callback is a new call, so this is the
	 * only thing that says which wait it settled. It reaches the ledger as
	 * `call_legs.related_call_id`.
	 */
	readonly relatedCallId?: string;
	/** Attempts already spent on this token; `0` on the first. For the event and the log. */
	readonly attempts: number;
	/** How long the held place has been waiting to be called. The virtual-hold SLA. */
	readonly heldMs: number;
}

export type QueueCallbackPlacement =
	| { readonly kind: "placed"; readonly callId: string }
	| { readonly kind: "refused"; readonly reason: string };

/**
 * The call plane, as a callback consumes it.
 *
 * One method, and it must never throw: a runner that took an exception from a dial would abandon
 * the sweep with the token still marked due, and the next tick would try the same number again with
 * no attempt recorded — an unbounded retry loop against one unreachable handset.
 */
export interface QueueCallbackDialer {
	place(request: QueueCallbackRequest): Promise<QueueCallbackPlacement>;
}

/** The tokens, as the runner reads and writes them. Implemented by `QueueWaitingStore`. */
export interface QueueCallbackPort {
	/** Tokens this queue owes a call, in the order their places were held. */
	dueCallbacks(
		orgId: string,
		queueId: string,
		now: number,
	): Promise<readonly QueueResumeTombstone[]>;
	/** Records a failed attempt. Answers `true` when the promise was given up on. */
	deferCallback(
		orgId: string,
		queueId: string,
		callerNumber: string,
		now: number,
		retryDelayMs: number,
	): Promise<boolean>;
}

/**
 * The callback lifecycle, as the wallboard and the SLA report read it.
 *
 * OPTIONAL on {@link QueueCallbackServices}, deliberately: a sweep that could not publish must
 * still dial. The promise was to call somebody back, and dropping the call because the reporting
 * plane is unreachable would be putting the report ahead of the thing it reports on — the same
 * trade `QueueEventPublisher` makes when it logs and drops a malformed event rather than throwing
 * on the call path.
 */
export interface QueueCallbackEventPort {
	callbackPlaced(input: {
		readonly orgId: string;
		readonly queueId: string;
		readonly callId: string;
		readonly originalCallId?: string;
		readonly callerNumber: string;
		readonly attempts: number;
		readonly heldMs: number;
	}): Promise<void>;
	callbackFailed(input: {
		readonly orgId: string;
		readonly queueId: string;
		readonly callerNumber: string;
		readonly attempts: number;
		readonly dropped: boolean;
		readonly reason?: string;
	}): Promise<void>;
}

export interface QueueCallbackServices {
	readonly membership: QueueMembershipPort;
	readonly agents: AgentStatePort;
	readonly callbacks: QueueCallbackPort;
	readonly dialer: QueueCallbackDialer;
	readonly events?: QueueCallbackEventPort;
}

export interface QueueCallbackSettings {
	/** How long the callback's own leg rings before it counts as a failed attempt. */
	readonly ringTimeoutSeconds: number;
	/** Injected so a spec can drive the clock. */
	readonly now: () => number;
	/** Written onto the log line, so a three-instance deployment says which one dialled. */
	readonly instanceId: string;
}

export const DEFAULT_QUEUE_CALLBACK_SETTINGS: QueueCallbackSettings = {
	ringTimeoutSeconds: 30,
	now: Date.now,
	instanceId: "engine",
};

/** What one sweep did, for the log and for a spec that wants to assert it. */
export interface QueueCallbackTick {
	readonly considered: number;
	readonly placed: number;
	readonly deferred: number;
	readonly dropped: number;
	/** Why nothing was attempted, when nothing was. */
	readonly skipped?: "no-tokens" | "no-agent" | "no-roster";
}

const MILLIS_PER_SECOND = 1_000;

const NOTHING: QueueCallbackTick = { considered: 0, placed: 0, deferred: 0, dropped: 0 };

export class QueueCallbackRunner {
	private readonly settings: QueueCallbackSettings;

	constructor(
		private readonly orgId: string,
		private readonly queueId: string,
		private readonly plan: QueueCallbackPlan,
		private readonly services: QueueCallbackServices,
		settings: Partial<QueueCallbackSettings> = {},
		/** The queue's own number, when it has one. See {@link QueueCallbackRequest.queueNumber}. */
		private readonly queueNumber?: string,
	) {
		this.settings = { ...DEFAULT_QUEUE_CALLBACK_SETTINGS, ...settings };
	}

	/**
	 * One sweep: at most one callback is placed per free agent.
	 *
	 * "At most one per free agent" rather than "all of them", because the agent is the scarce thing.
	 * Dialling five people back into a queue with one free agent recreates the queue on the customers'
	 * phones, which is the situation virtual hold exists to end.
	 */
	async tick(): Promise<QueueCallbackTick> {
		const now = this.settings.now();
		const due = await this.services.callbacks.dueCallbacks(this.orgId, this.queueId, now);
		if (due.length === 0) {
			return { ...NOTHING, skipped: "no-tokens" };
		}

		const free = await this.freeAgents();
		if (free === undefined) {
			// A roster that cannot be read is an unavailability, not an empty team. Every token keeps
			// its attempt count: a callback not made because the bucket was down must not spend one of
			// the caller's three chances.
			return { ...NOTHING, considered: due.length, skipped: "no-roster" };
		}
		if (free === 0) {
			return { ...NOTHING, considered: due.length, skipped: "no-agent" };
		}

		let placed = 0;
		let deferred = 0;
		let dropped = 0;
		for (const token of due.slice(0, free)) {
			const attempts = token.callback?.attempts ?? 0;
			const placement = await this.services.dialer.place({
				orgId: this.orgId,
				queueId: this.queueId,
				callerNumber: token.callerNumber,
				ringTimeoutSeconds: this.settings.ringTimeoutSeconds,
				...(this.queueNumber === undefined ? {} : { queueNumber: this.queueNumber }),
				...(token.callback?.callId === undefined ? {} : { relatedCallId: token.callback.callId }),
				attempts,
				// From the place they held, not from when the offer was accepted: the wait a callback
				// settles started when they joined the line.
				heldMs: Math.max(0, now - token.joinedAt),
			});
			if (placement.kind === "placed") {
				placed += 1;
				await this.publish(async (events) => {
					await events.callbackPlaced({
						orgId: this.orgId,
						queueId: this.queueId,
						callId: placement.callId,
						...(token.callback?.callId === undefined
							? {}
							: { originalCallId: token.callback.callId }),
						callerNumber: token.callerNumber,
						attempts,
						heldMs: Math.max(0, now - token.joinedAt),
					});
				});
				continue;
			}
			// The token stays: a refusal is one attempt, not the end of the promise. It is the
			// dialler's job to answer rather than throw, so a `refused` here is a real outcome the
			// tenant can be told about.
			const gone = await this.services.callbacks.deferCallback(
				this.orgId,
				this.queueId,
				token.callerNumber,
				now,
				this.plan.retryDelaySeconds * MILLIS_PER_SECOND,
			);
			if (gone) {
				dropped += 1;
			} else {
				deferred += 1;
			}
			await this.publish(async (events) => {
				await events.callbackFailed({
					orgId: this.orgId,
					queueId: this.queueId,
					callerNumber: token.callerNumber,
					// Spent INCLUDING this one, which is what `deferCallback` just recorded.
					attempts: attempts + 1,
					dropped: gone,
					reason: placement.reason,
				});
			});
		}
		return { considered: due.length, placed, deferred, dropped };
	}

	/**
	 * Publishes one lifecycle event, and swallows whatever it costs.
	 *
	 * The sweep must survive a broker that is refusing publishes: the token has already been dialled
	 * or already been deferred by the time this runs, so a throw here would abandon the rest of the
	 * pass over a report nobody is reading yet.
	 */
	private async publish(emit: (events: QueueCallbackEventPort) => Promise<void>): Promise<void> {
		const events = this.services.events;
		if (events === undefined) {
			return;
		}
		try {
			await emit(events);
		} catch {
			// Deliberately silent at this level: `QueueEventPublisher` logs and counts its own
			// rejections, and a second log line here would double-count them.
		}
	}

	/**
	 * How many agents could take a call right now, or `undefined` when the roster is unreadable.
	 *
	 * The same test the distribution loop applies, deliberately: a callback placed against a
	 * different definition of "free" would ring a customer for an agent the queue would not have
	 * offered the call to.
	 */
	private async freeAgents(): Promise<number | undefined> {
		const membership = await this.services.membership.membershipFor(this.orgId, this.queueId);
		if (membership === undefined) {
			return undefined;
		}
		const enabled = membership.agents.filter((agent) => agent.enabled);
		if (enabled.length === 0) {
			return 0;
		}
		const states = await this.services.agents.readStates(
			this.orgId,
			enabled.map((agent) => agent.agentId),
		);
		const now = this.settings.now();
		return enabled.filter((agent) => {
			const state = states.get(agent.agentId);
			return state !== undefined && isEligibleForDistribution(state, now);
		}).length;
	}
}
