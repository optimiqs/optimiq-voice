import { isStaffing } from "./agent-state";
import { selectAgents } from "./queue-strategy";
import type { QueueCandidate } from "./queue-strategy";
import type { AgentStateEntry, QueueMembership } from "@optimiq-voice/events";
import type { QueuePlanNode } from "@optimiq-voice/routing";
import type { HangupCause } from "@optimiq-voice/telephony";

/**
 * One caller's stay in one queue.
 *
 * ## The shape of the problem
 *
 * A queued caller is doing two things at once: waiting (with music, announcements and two
 * deadlines), and being offered to agents (one at a time or all at once, with per-agent penalties
 * and a wrap-up timer that outlives the call). Written as two concurrent loops those interact
 * badly — an announcement fires while an agent is ringing, a deadline expires between the answer
 * and the bridge. Written as ONE loop with a poll interval they do not: every pass re-reads the
 * clock, the roster and the agent states, decides what this caller's situation now requires, and
 * does exactly one thing.
 *
 * The poll interval is the price. It is set to a second by default, which is well inside the
 * granularity anything here is specified in (`announce_frequency_seconds`, `max_wait_seconds` and
 * the penalty delays are all seconds) and is not a busy-wait: each pass is two cached reads and a
 * comparator over a roster that is almost always under twenty entries.
 *
 * ## Everything is a port
 *
 * The media, the roster, the agent states, the queue events and the position counter are all
 * injected. `queue-session.spec.ts` runs a complete queued call — join, music, an agent who does
 * not answer, a second who does, the bridge, and the wrap-up that follows — with no Asterisk, no
 * NATS and no clock. {@link QueueCallPort} in particular is implemented by `PlanWalker`, which
 * already owns originate/bridge/answer; this file never learns what a media channel id is.
 *
 * ## What is real and what is honestly missing
 *
 * Real: joining, music on hold, position announcements, all six strategies, tier rules, per-agent
 * no-answer/busy/reject penalties, `maxNoAnswer` taking an agent out of distribution, both wait
 * deadlines, wrap-up, and the three caller-facing queue events in the right order with the right
 * wait statistics.
 *
 * Missing, and noted on the walk rather than faked:
 *
 * - **Position is per engine instance.** {@link QueuePositionPort} counts the callers THIS process
 *   is holding. With one engine that is the true position; with several it is a lower bound. A
 *   cluster-wide position needs a shared counter (a KV entry per queue, or a JetStream ordered
 *   consumer), which is a backbone change rather than a runtime one.
 * - **`recordEnabled` is not honoured.** Recording a queue call is the same unimplemented feature as
 *   recording a ring-group call, and belongs with the recording work rather than here.
 * - **Priority is always 0.** `queue.caller.joined` carries a priority the plan node does not have;
 *   `pbx-db` has no priority column either, so there is nothing to read. Reported as 0, which is
 *   what "unprioritised" means on that scale.
 * - **`abandonedResumeAllowed`** (a caller who rings back keeps their place) needs state that
 *   outlives the call. Not attempted.
 */

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

/** One agent leg the session wants rung. */
export interface QueueDialAttempt {
	readonly agentId: string;
	/** The agent's dial string from the roster, handed to the media server verbatim. */
	readonly endpoint: string;
	/** Human label for the notes and the log. */
	readonly label: string;
	/** What the B-leg's CDR records as the number reached. */
	readonly destinationNumber: string;
	readonly timeoutSeconds: number;
}

export type QueueDialOutcome =
	| { readonly kind: "answered"; readonly agentId: string; readonly mediaChannelId: string }
	| { readonly kind: "failed"; readonly agentId: string; readonly cause: HangupCause }
	/** Nobody picked up inside the ring timeout. */
	| { readonly kind: "timeout" }
	/** The CALLER went away while the agents were ringing. */
	| { readonly kind: "aborted" };

/**
 * The media primitives a queued call needs, as the walker already implements them.
 *
 * Deliberately not `MediaPort`: the session must not originate or bridge directly, because doing so
 * would bypass the leg hooks that give each agent leg its own CDR with the right hangup cause. Every
 * method here goes through the walker's existing dial/bridge machinery.
 */
export interface QueueCallPort {
	readonly isTearingDown: boolean;
	/** The caller's leg id, for the queue events. */
	readonly callerLegId: string;
	readonly callId: string;
	readonly organizationId: string;
	readonly callerNumber?: string;
	/** Answers the A-leg and waits for the media path. `false` means the caller is gone. */
	ensureAnswered(): Promise<boolean>;
	/** Plays one media reference at the caller. `false` means the play failed. */
	play(media: string): Promise<boolean>;
	startMusicOnHold(mohClass?: string): Promise<void>;
	stopMusicOnHold(): Promise<void>;
	/**
	 * Rings the attempts. `all` races them and hangs the losers up with `LOSE_RACE`; `one` rings the
	 * head of the list only. Aborts as soon as the CALLER hangs up, so an agent's phone does not keep
	 * ringing for somebody who has gone.
	 */
	dial(
		attempts: readonly QueueDialAttempt[],
		fanOut: "one" | "all",
		ringTimeoutSeconds: number,
	): Promise<QueueDialOutcome>;
	/** Joins the caller to an answered agent leg. `onEnded` fires when that leg goes away. */
	bridge(mediaChannelId: string, onEnded: () => void): Promise<boolean>;
	/** A prompt id as a playable media reference, or `undefined` when it resolves to nothing. */
	resolvePrompt(promptId: string | undefined): string | undefined;
	/** A number as playable digit sounds, for the position announcement. */
	spellNumber(value: string): readonly string[];
	/** Records a gap or a decision on the walk's notes. */
	note(message: string): void;
	delay(ms: number): Promise<void>;
	now(): number;
}

export interface QueueMembershipPort {
	/** `undefined` means the roster could not be obtained — never "the queue is empty". */
	membershipFor(orgId: string, queueId: string): Promise<QueueMembership | undefined>;
}

/** One agent transition the session wants written. */
export interface AgentTransitionRequest {
	readonly orgId: string;
	readonly agentId: string;
	readonly to: AgentStateEntry["status"];
	readonly queueId: string;
	readonly callId?: string;
	readonly legId?: string;
	/** Not eligible again before this instant. Wrap-up and the penalty delays both set it. */
	readonly availableAt?: number;
	/** Absolute value to store; `undefined` leaves the existing count alone. */
	readonly noAnswerCount?: number;
	readonly reason?: string;
}

export interface AgentStatePort {
	/** Live state for every agent on a roster. Missing ids mean "never seen", not "available". */
	readStates(orgId: string, agentIds: readonly string[]): Promise<Map<string, AgentStateEntry>>;
	/**
	 * Applies a transition, guard-first. Returns the written entry, or `undefined` when the machine
	 * refused it or the write failed — both of which the session treats as "this agent is not
	 * mine to ring", never as success.
	 */
	transition(request: AgentTransitionRequest): Promise<AgentStateEntry | undefined>;
}

/** The three caller-facing queue events. Fire-and-forget: a wallboard must not fail a call. */
export interface QueueEventPort {
	callerJoined(input: {
		readonly orgId: string;
		readonly queueId: string;
		readonly callId: string;
		readonly legId: string;
		readonly position: number;
		readonly priority: number;
		readonly callerNumber?: string;
	}): Promise<void>;
	callerAnswered(input: {
		readonly orgId: string;
		readonly queueId: string;
		readonly callId: string;
		readonly legId: string;
		readonly agentId: string;
		readonly waitMs: number;
		readonly strategy: string;
	}): Promise<void>;
	callerAbandoned(input: {
		readonly orgId: string;
		readonly queueId: string;
		readonly callId: string;
		readonly legId: string;
		readonly waitMs: number;
		readonly position?: number;
		readonly reason: "caller-hangup" | "timeout" | "overflow" | "no-agents";
	}): Promise<void>;
}

/** Where a caller stands in the line this process is holding. */
export interface QueuePositionPort {
	/** Adds the caller and returns their 1-based position. */
	join(orgId: string, queueId: string, callId: string): number;
	/** Their position now, which shrinks as callers ahead of them are answered. */
	positionOf(orgId: string, queueId: string, callId: string): number;
	leave(orgId: string, queueId: string, callId: string): void;
}

/** Which agent this queue distributed to last. Per queue, per process; see `round-robin`. */
export interface QueueCursorPort {
	lastAgentFor(orgId: string, queueId: string): string | undefined;
	remember(orgId: string, queueId: string, agentId: string): void;
}

/** Everything the session talks to. */
export interface QueueServices {
	readonly membership: QueueMembershipPort;
	readonly agents: AgentStatePort;
	readonly events: QueueEventPort;
	readonly positions: QueuePositionPort;
	readonly cursor: QueueCursorPort;
}

export interface QueueSessionSettings {
	/** How often the loop re-evaluates when nobody is reachable. */
	readonly pollIntervalMs: number;
	/** How long one agent's phone rings before the session moves on. */
	readonly agentRingTimeoutSeconds: number;
	/** Injected so `random` is deterministic in a spec. */
	readonly random: () => number;
}

export const DEFAULT_QUEUE_SESSION_SETTINGS: QueueSessionSettings = {
	pollIntervalMs: 1_000,
	agentRingTimeoutSeconds: 20,
	random: Math.random,
};

export type QueueOutcome =
	/** An agent answered and the caller is bridged to them. The walk is over. */
	| { readonly kind: "answered"; readonly agentId: string; readonly waitMs: number }
	/** A wait deadline expired. The walker takes the queue's timeout branch. */
	| {
			readonly kind: "timeout";
			readonly reason: "timeout" | "no-agents";
			readonly waitMs: number;
	  }
	/** The caller hung up while waiting. Nothing left to route. */
	| { readonly kind: "abandoned"; readonly waitMs: number }
	/** The leg went away underneath the session before it could join. */
	| { readonly kind: "aborted" }
	/** The roster could not be obtained. Distinguished from "no agents" deliberately. */
	| { readonly kind: "failed"; readonly reason: string };

const MILLIS_PER_SECOND = 1_000;

export class QueueSession {
	private readonly settings: QueueSessionSettings;
	/** Agents this caller has already rung, and when they may be rung again. */
	private readonly tried = new Map<string, number>();
	/** The frozen order `sequential` walks; computed on the first pass and never recomputed. */
	private frozenOrder: readonly string[] | undefined;
	private joinedAt = 0;
	private position = 0;
	private lastAnnouncedAt = 0;

	constructor(
		private readonly node: QueuePlanNode,
		private readonly call: QueueCallPort,
		private readonly services: QueueServices,
		settings: Partial<QueueSessionSettings> = {},
	) {
		this.settings = { ...DEFAULT_QUEUE_SESSION_SETTINGS, ...settings };
	}

	/**
	 * Runs the caller's whole stay.
	 *
	 * Never throws: this is called from inside a walk that is called from inside an ARI event
	 * callback, and an exception there takes every other live call with it. A failure becomes a
	 * `failed` outcome the walker turns into a hangup cause.
	 */
	async run(): Promise<QueueOutcome> {
		if (!(await this.call.ensureAnswered())) {
			return { kind: "aborted" };
		}

		this.joinedAt = this.call.now();
		this.lastAnnouncedAt = this.joinedAt;
		this.position = this.services.positions.join(
			this.call.organizationId,
			this.node.queueId,
			this.call.callId,
		);

		await this.publishJoined();

		if (this.node.recordEnabled) {
			this.call.note(
				`queue "${this.node.queueId}" asks for call recording, which is not implemented for queues yet; the call was taken without it`,
			);
		}

		try {
			return await this.wait();
		} catch (error) {
			this.call.note(`queue "${this.node.queueId}" failed: ${String(error)}`);
			return { kind: "failed", reason: String(error) };
		} finally {
			this.services.positions.leave(this.call.organizationId, this.node.queueId, this.call.callId);
		}
	}

	// -------------------------------------------------------------------------------------------
	// The loop
	// -------------------------------------------------------------------------------------------

	private async wait(): Promise<QueueOutcome> {
		await this.playGreeting();
		await this.startMusic();

		for (;;) {
			if (this.call.isTearingDown) {
				return await this.abandon("caller-hangup");
			}

			const waited = this.waitedMs();
			const membership = await this.services.membership.membershipFor(
				this.call.organizationId,
				this.node.queueId,
			);
			if (membership === undefined) {
				// NOT "the queue is empty". A roster that cannot be read is an infrastructure failure,
				// and ejecting the caller to the timeout branch for it would look identical to a queue
				// nobody staffs — which is exactly the confusion an operator cannot afford at 09:00.
				this.call.note(
					`queue "${this.node.queueId}" has no membership entry in the queue-membership bucket; the caller cannot be distributed`,
				);
				return { kind: "failed", reason: "no queue membership" };
			}

			const states = await this.services.agents.readStates(
				this.call.organizationId,
				membership.agents.map((agent) => agent.agentId),
			);

			const deadline = this.deadlineReached(waited, membership, states);
			if (deadline !== undefined) {
				return await this.timeOut(deadline);
			}

			const candidate = this.nextCandidates(membership, states, waited);
			if (candidate.length === 0) {
				await this.announceIfDue();
				await this.call.delay(this.settings.pollIntervalMs);
				continue;
			}

			const offered = await this.offer(membership, candidate);
			if (offered !== undefined) {
				return offered;
			}
		}
	}

	/**
	 * Which deadline, if any, this caller has now passed.
	 *
	 * `maxWaitNoAgentSeconds` is checked FIRST and against a different question: not "is anybody
	 * free" but "is anybody working this queue at all" (see `isStaffing`). A caller who is 12th in
	 * line behind a busy team should wait out `maxWaitSeconds`; a caller who reached a queue nobody
	 * has logged into should be ejected in the ten seconds the setting exists to enforce.
	 *
	 * Both settings treat 0 as "no deadline", which is what `pbx-db`'s defaults mean.
	 */
	private deadlineReached(
		waitedMs: number,
		membership: QueueMembership,
		states: ReadonlyMap<string, AgentStateEntry>,
	): "timeout" | "no-agents" | undefined {
		const noAgent = this.node.maxWaitNoAgentSeconds;
		if (noAgent > 0 && waitedMs >= noAgent * MILLIS_PER_SECOND) {
			const staffed = membership.agents.some(
				(agent) => agent.enabled && isStaffing(states.get(agent.agentId)),
			);
			if (!staffed) {
				return "no-agents";
			}
		}
		const maxWait = this.node.maxWaitSeconds;
		if (maxWait > 0 && waitedMs >= maxWait * MILLIS_PER_SECOND) {
			return "timeout";
		}
		return undefined;
	}

	/**
	 * The agents to ring on this pass.
	 *
	 * `sequential` is the one strategy that does not simply take the current selection: its order is
	 * frozen at the caller's first pass and walked once. Everything else recomputes, so an agent who
	 * became free while the caller waited is considered immediately.
	 */
	private nextCandidates(
		membership: QueueMembership,
		states: ReadonlyMap<string, AgentStateEntry>,
		waitedMs: number,
	): readonly QueueCandidate[] {
		const now = this.call.now();
		const excluded = new Set(
			[...this.tried.entries()].filter(([, until]) => until > now).map(([agentId]) => agentId),
		);

		const cursor = this.services.cursor.lastAgentFor(this.call.organizationId, this.node.queueId);

		const selection = selectAgents({
			strategy: this.node.strategy,
			membership,
			states,
			waitedMs,
			now,
			excludedAgentIds: excluded,
			random: this.settings.random,
			...(cursor === undefined ? {} : { roundRobinAfterAgentId: cursor }),
		});

		if (selection.fanOut === "all") {
			return selection.ordered;
		}

		if (this.node.strategy === "sequential") {
			this.frozenOrder ??= selection.ordered.map((candidate) => candidate.agent.agentId);
			const frozen = this.frozenOrder;
			const byId = new Map(selection.ordered.map((c) => [c.agent.agentId, c]));
			for (const agentId of frozen) {
				const candidate = byId.get(agentId);
				if (candidate !== undefined) {
					return [candidate];
				}
			}
			// Everybody on the frozen list has been tried or has gone. The pass is over; the loop
			// keeps waiting, and the next selection re-freezes only if the order was never set.
			return [];
		}

		return selection.ordered.length === 0 ? [] : [selection.ordered[0] as QueueCandidate];
	}

	// -------------------------------------------------------------------------------------------
	// Offering the call
	// -------------------------------------------------------------------------------------------

	/**
	 * Rings the selected agents and settles what happened.
	 *
	 * Returns `undefined` when the caller is still waiting — the loop's signal to try again.
	 *
	 * Agents are moved to `ringing` BEFORE the originate. That ordering is what stops two engine
	 * instances distributing the same agent to two callers at once: the second instance's read sees
	 * `ringing` and skips them. It is not a lock (KV `put` is last-writer-wins, not compare-and-set),
	 * and the residual race is one double-ring, which the agent's phone rejects with `USER_BUSY` —
	 * an outcome this loop already handles. A true reservation needs a compare-and-set on the entry's
	 * revision, which is a follow-up.
	 */
	private async offer(
		membership: QueueMembership,
		candidates: readonly QueueCandidate[],
	): Promise<QueueOutcome | undefined> {
		const reserved: QueueCandidate[] = [];
		for (const candidate of candidates) {
			const written = await this.services.agents.transition({
				orgId: this.call.organizationId,
				agentId: candidate.agent.agentId,
				to: "ringing",
				queueId: this.node.queueId,
				callId: this.call.callId,
				legId: this.call.callerLegId,
			});
			if (written !== undefined) {
				reserved.push(candidate);
			}
		}

		if (reserved.length === 0) {
			// Every candidate was taken between the read and the write. Not an error; the next pass
			// sees the newer state. A short back-off stops this becoming a spin.
			await this.call.delay(this.settings.pollIntervalMs);
			return undefined;
		}

		await this.call.stopMusicOnHold();

		const outcome = await this.call.dial(
			reserved.map((candidate) => ({
				agentId: candidate.agent.agentId,
				endpoint: candidate.agent.contact,
				label: `queue agent ${candidate.agent.name}`,
				destinationNumber: candidate.agent.contact,
				timeoutSeconds: this.settings.agentRingTimeoutSeconds,
			})),
			candidates.length > 1 || this.node.strategy === "ring-all" ? "all" : "one",
			this.settings.agentRingTimeoutSeconds,
		);

		switch (outcome.kind) {
			case "answered": {
				return await this.answered(membership, reserved, outcome.agentId, outcome.mediaChannelId);
			}
			case "aborted": {
				await this.releaseAll(reserved, undefined);
				return await this.abandon("caller-hangup");
			}
			case "failed": {
				await this.releaseAll(reserved, outcome.cause);
				break;
			}
			default: {
				await this.releaseAll(reserved, "NO_ANSWER");
				break;
			}
		}

		await this.startMusic();
		return undefined;
	}

	/**
	 * An agent picked up.
	 *
	 * The order matters and is asserted: the agent is marked `on-call`, `queue.caller.answered` is
	 * published with the wait the caller actually experienced, and THEN the bridge is built. A
	 * wallboard that saw the answer after the bridge would be reporting a call it had already been
	 * shown as connected; a bridge built before the state write would leave an agent who is on a call
	 * and marked available, and the next caller would ring them.
	 *
	 * The losers of a ring-all race are released back to `available` with NO penalty — they did
	 * nothing wrong, and a penalty here would take the whole team out of distribution every time one
	 * of them answered.
	 */
	private async answered(
		membership: QueueMembership,
		reserved: readonly QueueCandidate[],
		agentId: string,
		mediaChannelId: string,
	): Promise<QueueOutcome> {
		const waitMs = this.waitedMs();

		await this.services.agents.transition({
			orgId: this.call.organizationId,
			agentId,
			to: "on-call",
			queueId: this.node.queueId,
			callId: this.call.callId,
			legId: this.call.callerLegId,
			noAnswerCount: 0,
		});
		this.services.cursor.remember(this.call.organizationId, this.node.queueId, agentId);

		for (const candidate of reserved) {
			if (candidate.agent.agentId === agentId) {
				continue;
			}
			await this.services.agents.transition({
				orgId: this.call.organizationId,
				agentId: candidate.agent.agentId,
				to: "available",
				queueId: this.node.queueId,
			});
		}

		await this.services.events.callerAnswered({
			orgId: this.call.organizationId,
			queueId: this.node.queueId,
			callId: this.call.callId,
			legId: this.call.callerLegId,
			agentId,
			waitMs,
			strategy: this.node.strategy,
		});

		const bridged = await this.call.bridge(mediaChannelId, () => {
			void this.startWrapUp(membership, agentId);
		});

		if (!bridged) {
			// The answer was real and the bridge was not. The agent is on a leg that is about to be
			// torn down, so they go straight into wrap-up rather than back into distribution — ringing
			// somebody whose handset just went dead is how a caller gets three seconds of silence.
			void this.startWrapUp(membership, agentId);
			return { kind: "failed", reason: "the queue call could not be bridged" };
		}

		return { kind: "answered", agentId, waitMs };
	}

	/**
	 * Puts an agent who did not take the call back into the pool, with the right penalty.
	 *
	 * The three delays are distinct on purpose and `pbx-db` stores them separately: a busy phone is
	 * on another call and will be free soon, an explicit rejection is a person saying not now, and a
	 * ring-out may be an empty desk. Collapsing them into one number is how a queue either hammers a
	 * busy agent or benches a whole team for a minute over one decline.
	 *
	 * `maxNoAnswer` is the escape hatch: an agent who rings out that many times consecutively is
	 * taken out of distribution entirely, because every further attempt costs the NEXT caller a full
	 * ring timeout. Bringing them back is a login, which is the control plane's.
	 */
	private async releaseAll(
		reserved: readonly QueueCandidate[],
		cause: HangupCause | undefined,
	): Promise<void> {
		for (const candidate of reserved) {
			await this.release(candidate, cause);
		}
	}

	private async release(candidate: QueueCandidate, cause: HangupCause | undefined): Promise<void> {
		const agent = candidate.agent;
		const now = this.call.now();

		if (cause === undefined) {
			await this.services.agents.transition({
				orgId: this.call.organizationId,
				agentId: agent.agentId,
				to: "available",
				queueId: this.node.queueId,
			});
			return;
		}

		const delaySeconds = penaltySecondsFor(cause, agent);
		const noAnswerCount =
			cause === "USER_BUSY" ? undefined : (candidate.state.noAnswerCount ?? 0) + 1;

		this.tried.set(agent.agentId, now + delaySeconds * MILLIS_PER_SECOND);

		if (
			noAnswerCount !== undefined &&
			agent.maxNoAnswer > 0 &&
			noAnswerCount >= agent.maxNoAnswer
		) {
			this.call.note(
				`queue agent ${agent.name} reached ${String(agent.maxNoAnswer)} consecutive no-answers and was taken out of distribution`,
			);
			await this.services.agents.transition({
				orgId: this.call.organizationId,
				agentId: agent.agentId,
				to: "unavailable",
				queueId: this.node.queueId,
				noAnswerCount,
				reason: "max-no-answer",
			});
			return;
		}

		await this.services.agents.transition({
			orgId: this.call.organizationId,
			agentId: agent.agentId,
			to: "available",
			queueId: this.node.queueId,
			availableAt: now + delaySeconds * MILLIS_PER_SECOND,
			...(noAnswerCount === undefined ? {} : { noAnswerCount }),
		});
	}

	/**
	 * After-call work.
	 *
	 * Two writes rather than one timer: the agent goes to `wrap-up` with a DEADLINE the moment the
	 * call ends, and a second write moves them to `available` when it passes. The deadline is what
	 * makes this survive the process — another instance reading the entry sees `wrap-up` with a time
	 * in the past and treats them as eligible (see `isEligibleForDistribution`), so a restart during
	 * somebody's wrap-up does not strand them off the roster until they log out and back in.
	 *
	 * A queue whose `wrapUpSeconds` is zero skips straight to `available`, which is what the setting
	 * means and not a special case worth a branch anywhere else.
	 */
	private async startWrapUp(membership: QueueMembership, agentId: string): Promise<void> {
		const agent = membership.agents.find((candidate) => candidate.agentId === agentId);
		const seconds = agent?.wrapUpSeconds || membership.wrapUpSeconds;

		if (seconds <= 0) {
			await this.services.agents.transition({
				orgId: this.call.organizationId,
				agentId,
				to: "available",
				queueId: this.node.queueId,
			});
			return;
		}

		const until = this.call.now() + seconds * MILLIS_PER_SECOND;
		await this.services.agents.transition({
			orgId: this.call.organizationId,
			agentId,
			to: "wrap-up",
			queueId: this.node.queueId,
			availableAt: until,
		});

		await this.call.delay(seconds * MILLIS_PER_SECOND);

		await this.services.agents.transition({
			orgId: this.call.organizationId,
			agentId,
			to: "available",
			queueId: this.node.queueId,
		});
	}

	// -------------------------------------------------------------------------------------------
	// Caller-facing media and events
	// -------------------------------------------------------------------------------------------

	private async playGreeting(): Promise<void> {
		const media = this.call.resolvePrompt(this.node.greetingPromptId);
		if (media === undefined) {
			return;
		}
		await this.call.play(media);
	}

	private async startMusic(): Promise<void> {
		if (this.call.isTearingDown) {
			return;
		}
		// `mohClass` is the class NAME, resolved from `mohClassId` by the compiler — the media server
		// addresses a class by name and answers a row id by silently selecting its default.
		//
		// The row id is deliberately NOT passed as a fallback. It used to be, on the theory that a
		// deployment might provision classes under their ids; ids are UUIDv7 and names are names, so
		// that theory was never true and the effect was identical to passing nothing. `undefined` says
		// the same thing honestly, and is also what an artifact compiled before the resolution
		// existed, or one whose class was deleted, correctly produces.
		await this.call.startMusicOnHold(this.node.mohClass);
	}

	/**
	 * The position announcement.
	 *
	 * Music is stopped first and restarted after, because a position read over hold music is a
	 * position nobody hears. The digits use the `digits/*` sounds every Asterisk install ships, the
	 * same approach the voicemail box readback takes, so this works with no prompt pack and no TTS.
	 */
	private async announceIfDue(): Promise<void> {
		if (!this.node.announcePositionEnabled || this.node.announceFrequencySeconds <= 0) {
			return;
		}
		const now = this.call.now();
		if (now - this.lastAnnouncedAt < this.node.announceFrequencySeconds * MILLIS_PER_SECOND) {
			return;
		}
		this.lastAnnouncedAt = now;

		this.position = this.services.positions.positionOf(
			this.call.organizationId,
			this.node.queueId,
			this.call.callId,
		);

		await this.call.stopMusicOnHold();
		const preamble = this.call.resolvePrompt(this.node.announcePromptId);
		if (preamble !== undefined) {
			await this.call.play(preamble);
		}
		for (const media of this.call.spellNumber(String(this.position))) {
			if (this.call.isTearingDown) {
				return;
			}
			await this.call.play(media);
		}
		await this.startMusic();
	}

	private async publishJoined(): Promise<void> {
		await this.services.events.callerJoined({
			orgId: this.call.organizationId,
			queueId: this.node.queueId,
			callId: this.call.callId,
			legId: this.call.callerLegId,
			position: Math.max(1, this.position),
			// The plan node has no priority and neither does `pbx-db`'s queue table. 0 is what
			// "unprioritised" means on the event's 0-1000 scale; inventing one would be worse.
			priority: 0,
			...(this.call.callerNumber === undefined ? {} : { callerNumber: this.call.callerNumber }),
		});
	}

	private async abandon(reason: "caller-hangup" | "timeout" | "no-agents"): Promise<QueueOutcome> {
		const waitMs = this.waitedMs();
		await this.services.events.callerAbandoned({
			orgId: this.call.organizationId,
			queueId: this.node.queueId,
			callId: this.call.callId,
			legId: this.call.callerLegId,
			waitMs,
			position: Math.max(1, this.position),
			reason,
		});
		return reason === "caller-hangup"
			? { kind: "abandoned", waitMs }
			: { kind: "timeout", reason, waitMs };
	}

	/**
	 * A wait deadline expired.
	 *
	 * It is published as `caller.abandoned` with the reason, not as a separate event: from the
	 * queue's point of view a caller who timed out is a caller who did not get served, and the SLA
	 * report wants them in the same bucket as a hangup with the reason as the discriminator. That is
	 * exactly what `queueCallerAbandonedDataSchema.reason` models.
	 */
	private async timeOut(reason: "timeout" | "no-agents"): Promise<QueueOutcome> {
		this.call.note(
			reason === "no-agents"
				? `queue "${this.node.queueId}" has nobody logged in; the caller was ejected after ${String(this.node.maxWaitNoAgentSeconds)}s`
				: `queue "${this.node.queueId}" reached its ${String(this.node.maxWaitSeconds)}s maximum wait`,
		);
		await this.call.stopMusicOnHold();
		return await this.abandon(reason);
	}

	private waitedMs(): number {
		return Math.max(0, this.call.now() - this.joinedAt);
	}
}

/**
 * Which of the agent's three delays a cause earns.
 *
 * `CALL_REJECTED` is a person pressing decline; `USER_BUSY` is a phone that is already on a call;
 * everything else — a ring-out, an unreachable endpoint, a media failure — is a no-answer. An
 * endpoint with no contact is deliberately grouped with no-answer rather than given its own delay:
 * `pbx-db` has three columns and inventing a fourth here would put a number in the code that no
 * operator can see or change.
 */
export function penaltySecondsFor(
	cause: HangupCause,
	agent: {
		readonly noAnswerDelaySeconds: number;
		readonly busyDelaySeconds: number;
		readonly rejectDelaySeconds: number;
	},
): number {
	if (cause === "USER_BUSY") {
		return agent.busyDelaySeconds;
	}
	if (cause === "CALL_REJECTED") {
		return agent.rejectDelaySeconds;
	}
	return agent.noAnswerDelaySeconds;
}
