import { isStaffing } from "./agent-state";
import { selectAgents } from "./queue-strategy";
import type { QueueCandidate } from "./queue-strategy";
import type { AgentStateEntry, QueueMembership, QueueResumeTombstone } from "@optimiq-voice/events";
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
 * Real: joining, music on hold, all six strategies, tier rules, per-agent no-answer/busy/reject
 * penalties, `maxNoAnswer` taking an agent out of distribution, both wait deadlines, wrap-up, and the
 * caller-facing queue events in the right order with the right wait statistics.
 *
 * Real since the contact-centre wave, and each of them a line that used to be in the "missing" list
 * below:
 *
 * - **Position is cluster-wide.** {@link QueueWaitingPort} is a compare-and-set record in the
 *   `queue-waiting` bucket holding the whole line, so "you are caller number four" is true with three
 *   engines behind one media server. When it cannot be read the session announces NOTHING rather than
 *   the number this process could have guessed — see {@link QueueSession.announceIfDue}.
 * - **Recording is honoured**, as a {@link import("@optimiq-voice/routing").RecordPolicy} rather than
 *   the boolean this used to read only to write a note about, and it starts at the ANSWER.
 * - **Priority is real.** It comes off the plan node (the queue's default, or the per-entry override
 *   the compiler minted a distinct node for) and orders the shared line. What it costs is written down
 *   at length in `queue-waiting.ts`: strict priority, no ageing, bounded by the queue's own deadlines.
 * - **Abandoned-resume works**, keyed by caller number, with the promise and the removal written in
 *   one operation. Who else can collect that promise is on `queueResumeTombstoneSchema`.
 * - **Exit keys** end a caller's stay on a single DTMF digit, observed non-blockingly inside the same
 *   loop as everything else.
 * - **Per-tier announcements** override the queue's whisper for the agent who took the call.
 *
 * Missing, and noted on the walk rather than faked:
 *
 * - **Recording is best-effort.** A media plane that cannot tap, or a media server that refuses one,
 *   costs the call its recording and not its existence. A tenant with a legal obligation to record
 *   needs the opposite — a REFUSED call with a spoken reason — and that is a setting nobody has asked
 *   for yet rather than a behaviour to guess at. See {@link QueueSession.startRecording}.
 * - **One digit per poll pass.** A caller who presses four keys in a second has the first of them
 *   acted on; the rest stay in the leg's buffer for whatever they reach next. Fine for a one-digit
 *   exit key, and the reason this is a poll rather than a `gather` is on {@link QueueCallPort.pollDigit}.
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
	/**
	 * Plays one media reference at an ANSWERED AGENT's leg, before it is bridged to the caller.
	 *
	 * ## Why this exists rather than the session reaching for a tap
	 *
	 * A tap ({@link import("../media/media-port").MediaPort.tap}) is the primitive for reaching a
	 * party who is ALREADY in a conversation — it snoops one leg, bridges the snoop to a third leg,
	 * and injects audio into one direction so that one of two people hears something the other does
	 * not. Every part of that machinery exists to solve the problem of a live bridge, and at the
	 * moment this is called there is no bridge: the agent has answered, the caller is still in the
	 * queue hearing hold music, and the two legs have never met. Using a tap here would add a
	 * channel, a bridge and a race to something a plain `play` on the agent's own channel already
	 * does correctly — and would need the media plane to support media bugs, which would make an
	 * agent whisper prompt refuse on a driver that a plain playback works fine on.
	 *
	 * So the whisper is a playback on a leg that is not yet bridged, and the caller cannot hear it
	 * for the most robust possible reason: they are not connected to anything.
	 *
	 * ## It does NOT wait for the audio to finish
	 *
	 * Nothing in this engine can. `PlaybackFinished` is one of the ARI events `toMediaEvent`
	 * deliberately drops, {@link CallSignalBus} has no playback key, and the `play` VERB returns as
	 * soon as audio has started for exactly the same reason. So this returns once the media server
	 * has accepted the playback, and a long whisper prompt may still be playing when the bridge is
	 * built. On the ARI driver a playback is addressed to the CHANNEL and is not injected into the
	 * bridge it later joins, so the caller still never hears it; the agent may hear the tail over the
	 * first moment of the call. The seam that would fix it is a `playbackSignalKey` on the signal bus
	 * plus republishing `PlaybackFinished` in `ari-mapping.ts`, and it is worth doing when something
	 * else needs it too.
	 *
	 * `false` means the media server refused the playback. The caller MUST still be bridged — see
	 * {@link QueueSession.answered}.
	 */
	playToAgent(mediaChannelId: string, media: string): Promise<boolean>;
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
	/** Ends an answered agent leg that this queue could not claim, through the leg teardown hooks. */
	hangupAnsweredAgent(mediaChannelId: string): Promise<void>;
	/** Joins the caller to an answered agent leg. `onEnded` fires when that leg goes away. */
	bridge(mediaChannelId: string, onEnded: () => void): Promise<boolean>;
	/**
	 * The next DTMF digit this caller has pressed, or `undefined` when they have pressed none.
	 *
	 * ## Non-blocking, and why it has to be
	 *
	 * The wait loop already has a structure — one pass, re-read everything, do one thing — and the
	 * exit key has to live inside it rather than beside it. A blocking `gather` would be a second
	 * concurrent thing happening to the caller: it holds the leg's collection open for its whole
	 * timeout, so an announcement that fell due mid-gather would either be delayed or would play into
	 * a collection nobody expected, and two of them running at once on one leg throws outright. A
	 * poll that returns immediately composes with everything the loop already does.
	 *
	 * ## It observes rather than consumes
	 *
	 * The walker implements this by watching the leg's signal bus, which is fed before the digit is
	 * offered to anything else. So a digit the queue ignores is still in the leg's DTMF buffer for
	 * whatever the caller reaches next — which is the behaviour type-ahead depends on, and is why
	 * `4` pressed in a queue that has no exit key still reaches the IVR the timeout branch sends them
	 * to. The queue takes no digit away from anybody; it only leaves the moment it sees its own.
	 *
	 * `undefined` from an implementation that cannot observe digits at all is a queue with no working
	 * exit key, which is exactly what every queue had before.
	 */
	pollDigit(): string | undefined;
	/**
	 * Starts recording the conversation, once the agent is bridged in.
	 *
	 * Returns whether recording is now running. `false` is not fatal and never stops the call — see
	 * {@link QueueSession.startRecording} for why a queue whose media plane cannot record answers the
	 * caller anyway and says so on the walk.
	 */
	startRecording(): Promise<boolean>;
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
	/** The call that owns this state-machine step and every cleanup step that follows it. */
	readonly callId: string;
	readonly legId?: string;
	/** Not eligible again before this instant. Wrap-up and the penalty delays both set it. */
	readonly availableAt?: number;
	/** Absolute value to store; `undefined` leaves the existing count alone. */
	readonly noAnswerCount?: number;
	readonly reason?: string;
}

export interface AgentReservationRequest extends AgentTransitionRequest {
	readonly to: "ringing";
	/** The eligibility instant used to adopt an expired wrap-up entry. */
	readonly now: number;
}

export type AgentStateRead =
	| { readonly kind: "found"; readonly entry: AgentStateEntry }
	| { readonly kind: "absent" }
	| { readonly kind: "unavailable" };

export interface AgentStatePort {
	/** Live state for every agent on a roster. Missing ids mean "never seen", not "available". */
	readStates(orgId: string, agentIds: readonly string[]): Promise<Map<string, AgentStateEntry>>;
	/** A point read that distinguishes confirmed absence from an unreadable bucket. */
	readState(orgId: string, agentId: string): Promise<AgentStateRead>;
	/** CAS-reserves an available agent or atomically adopts an expired wrap-up entry. */
	reserve(request: AgentReservationRequest): Promise<AgentStateEntry | undefined>;
	/**
	 * Applies a transition, guard-first. Returns the written entry, or `undefined` when the machine
	 * refused it or the write failed. Reservation cleanup must follow `undefined` with `readState`:
	 * only a confirmed absence or ownership change makes a failed release complete.
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
		readonly resumed?: boolean;
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
		readonly reason: "caller-hangup" | "timeout" | "overflow" | "no-agents" | "exit-key";
		readonly exitKey?: string;
	}): Promise<void>;
}

/**
 * Where a caller stands in the CLUSTER's line for this queue.
 *
 * Replaces the in-process counter this used to have. That counter answered from the callers one
 * engine happened to be holding, so with three instances every announced position was a lower bound
 * and a priority order was three separate orders. See `queue-waiting.ts` for the record, the
 * comparator and the starvation stance; see `queue-waiting.store.ts` for the compare-and-set.
 *
 * Every method is async and none of them may throw: the implementation is a KV round trip, and a
 * broken line must cost a caller their POSITION ANNOUNCEMENT, never their call.
 */
export interface QueueWaitingPort {
	join(request: QueueWaitingJoin): Promise<QueueWaitingView>;
	/** Re-reads the line and renews this caller's lease when it is due. Called each poll pass. */
	refresh(request: QueueWaitingRefresh): Promise<QueueWaitingView>;
	/** Removes the caller, writing a resume tombstone in the same operation when one is asked for. */
	leave(request: QueueWaitingLeave): Promise<void>;
}

export interface QueueWaitingJoin {
	readonly orgId: string;
	readonly queueId: string;
	readonly callId: string;
	readonly legId: string;
	readonly priority: number;
	readonly callerNumber?: string;
	readonly instanceId: string;
	readonly now: number;
	/** Whether a live tombstone for `callerNumber` may be claimed to restore their old place. */
	readonly resumeAllowed: boolean;
}

export interface QueueWaitingRefresh {
	readonly orgId: string;
	readonly queueId: string;
	readonly callId: string;
	readonly legId: string;
	readonly priority: number;
	readonly callerNumber?: string;
	readonly instanceId: string;
	/** The order this caller holds — restored, not recomputed, if the entry has to be rewritten. */
	readonly joinedAt: number;
	readonly now: number;
}

export interface QueueWaitingLeave {
	readonly orgId: string;
	readonly queueId: string;
	readonly callId: string;
	readonly now: number;
	readonly tombstone?: QueueResumeTombstone;
}

/** What the line says about one caller. */
export interface QueueWaitingView {
	/**
	 * 1-based position, or 0 for "not known".
	 *
	 * 0 is a real answer and the session acts on it: the record could not be read, or this caller is
	 * not in it. It declines to announce rather than announcing a number it guessed, because a caller
	 * told "you are number one" four times running has been lied to four times.
	 */
	readonly position: number;
	readonly waiting: number;
	readonly longestWaitMs: number;
	/** True when a `join` claimed a tombstone and restored this caller's earlier place. */
	readonly resumed: boolean;
	/** The instant this caller's place is ordered by. Their arrival, or the one they resumed. */
	readonly joinedAt: number;
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
	readonly waiting: QueueWaitingPort;
	readonly cursor: QueueCursorPort;
}

export interface QueueSessionSettings {
	/** How often the loop re-evaluates when nobody is reachable. */
	readonly pollIntervalMs: number;
	/** How long one agent's phone rings before the session moves on. */
	readonly agentRingTimeoutSeconds: number;
	/** Injected so `random` is deterministic in a spec. */
	readonly random: () => number;
	/** This engine process, written onto the caller's waiting-line entry. */
	readonly instanceId: string;
	/** Injected so release retries are deterministic without making production timers ref the process. */
	readonly scheduleReleaseRetry: (callback: () => Promise<void>, delayMs: number) => void;
}

export const DEFAULT_QUEUE_SESSION_SETTINGS: QueueSessionSettings = {
	pollIntervalMs: 1_000,
	agentRingTimeoutSeconds: 20,
	random: Math.random,
	instanceId: "engine",
	scheduleReleaseRetry: (callback, delayMs) => {
		const timer = setTimeout(() => {
			void callback();
		}, delayMs);
		timer.unref?.();
	},
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
	/**
	 * The caller pressed the queue's exit key. The walker takes the queue's exit branch.
	 *
	 * A separate outcome from `timeout` even though both end in "take a branch", because they are
	 * opposite facts about the same caller: one ran out of patience and one made a choice, and an SLA
	 * report that could not tell them apart would show a queue whose exit key works well as a queue
	 * that times people out. The digit travels so the walker's note and the event can name it.
	 */
	| { readonly kind: "exit-key"; readonly digit: string; readonly waitMs: number }
	/** The leg went away underneath the session before it could join. */
	| { readonly kind: "aborted" }
	/** The roster could not be obtained. Distinguished from "no agents" deliberately. */
	| { readonly kind: "failed"; readonly reason: string };

const MILLIS_PER_SECOND = 1_000;
const RELEASE_RETRY_INITIAL_MS = 250;
const RELEASE_RETRY_MAX_MS = 5_000;

interface AgentRelease {
	readonly candidate: QueueCandidate;
	readonly request: AgentTransitionRequest;
}

type OwnedTransitionResult = "succeeded" | "ownership-changed" | "retry";

interface OwnedTransitionRetry {
	readonly request: AgentTransitionRequest;
	readonly promise: Promise<boolean>;
	readonly resolve: (succeeded: boolean) => void;
}

export class QueueSession {
	private readonly settings: QueueSessionSettings;
	/** Agents this caller has already rung, and when they may be rung again. */
	private readonly tried = new Map<string, number>();
	/** At most one owned-state retry loop per agent in this session. */
	private readonly transitionRetries = new Map<string, OwnedTransitionRetry>();
	/** The frozen order `sequential` walks; computed on the first pass and never recomputed. */
	private frozenOrder: readonly string[] | undefined;
	/** When this caller's WAIT started. Always their real arrival, even when their place is older. */
	private joinedAt = 0;
	/**
	 * The instant the shared line ORDERS this caller by.
	 *
	 * Equal to {@link joinedAt} for everybody except a resumed caller, whose place is the one they
	 * had before they hung up. The two are separate fields because they answer different questions
	 * and conflating them would corrupt both: `waitMs` on every event would include the minutes the
	 * resumed caller was not on the phone (an SLA report of a queue nobody was waiting in), and using
	 * the arrival for the order would put them at the back, which is the feature not working.
	 */
	private orderedAt = 0;
	private position = 0;
	private waiting = 0;
	private priority = 0;
	private lastAnnouncedAt = 0;
	private recording = false;

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
		this.orderedAt = this.joinedAt;
		this.lastAnnouncedAt = this.joinedAt;
		this.priority = this.node.priority;

		const joined = await this.services.waiting.join({
			orgId: this.call.organizationId,
			queueId: this.node.queueId,
			callId: this.call.callId,
			legId: this.call.callerLegId,
			priority: this.priority,
			instanceId: this.settings.instanceId,
			now: this.joinedAt,
			resumeAllowed: this.node.abandonedResumeAllowed,
			...(this.call.callerNumber === undefined ? {} : { callerNumber: this.call.callerNumber }),
		});
		this.applyView(joined);
		if (joined.resumed) {
			this.orderedAt = joined.joinedAt;
			// The priority may have been restored upward with the place — see the store's `join`.
			this.priority = Math.max(this.priority, this.node.priority);
			this.call.note(
				`queue "${this.node.queueId}": this caller rang back inside the ${String(this.node.discardAbandonedAfterSeconds)}s window and was restored to the place they had before they hung up`,
			);
		}

		await this.publishJoined(joined.resumed);

		let outcome: QueueOutcome;
		try {
			outcome = await this.wait();
		} catch (error) {
			this.call.note(`queue "${this.node.queueId}" failed: ${String(error)}`);
			outcome = { kind: "failed", reason: String(error) };
		}
		// Outside the try, and after the outcome is known, because WHY the caller left decides
		// whether their place is held for them. A `finally` that ran before the outcome existed could
		// only ever leave unconditionally, and would either hold a place for somebody an agent
		// answered or hold none for the person who hung up — which is the whole feature.
		await this.leaveLine(outcome);
		return outcome;
	}

	/**
	 * Takes the caller out of the shared line, with a resume promise when they earned one.
	 *
	 * Exactly one outcome earns one: `abandoned`, which is the caller hanging up while waiting. Not
	 * a timeout — the queue decided that, and the caller is being sent somewhere by configuration, so
	 * holding a place they did not choose to leave would mean their call-back jumped the line ahead of
	 * people who never gave up. Not an exit key, for a stronger version of the same reason: they chose
	 * to stop waiting. Not `answered`, obviously. Not `failed` or `aborted`, because a place restored
	 * on the strength of an infrastructure fault is a place nobody can account for.
	 */
	private async leaveLine(outcome: QueueOutcome): Promise<void> {
		const now = this.call.now();
		const callerNumber = this.call.callerNumber;
		const holdsPlace =
			outcome.kind === "abandoned" &&
			this.node.abandonedResumeAllowed &&
			this.node.discardAbandonedAfterSeconds > 0 &&
			callerNumber !== undefined &&
			callerNumber !== "";

		await this.services.waiting.leave({
			orgId: this.call.organizationId,
			queueId: this.node.queueId,
			callId: this.call.callId,
			now,
			...(holdsPlace
				? {
						tombstone: {
							callerNumber: callerNumber as string,
							joinedAt: this.orderedAt,
							priority: this.priority,
							abandonedAt: now,
							expiresAt: now + this.node.discardAbandonedAfterSeconds * MILLIS_PER_SECOND,
						},
					}
				: {}),
		});
	}

	private applyView(view: QueueWaitingView): void {
		this.position = view.position;
		this.waiting = view.waiting;
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

			// Before anything else on the pass. A caller who has pressed the exit key has stopped
			// being a queued caller, and every line below this — the roster read, the deadlines, the
			// selection — is work on their behalf that they have just told us not to do. Checking it
			// first is also what makes the key feel instant rather than "some time in the next second".
			const exit = await this.exitKeyPressed();
			if (exit !== undefined) {
				return exit;
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

			const selection = this.nextCandidates(membership, states, waited);
			if (selection.candidates.length === 0 || !this.mayOffer(selection.eligible)) {
				await this.announceIfDue();
				await this.call.delay(this.settings.pollIntervalMs);
				continue;
			}

			const offered = await this.offer(membership, selection.candidates);
			if (offered !== undefined) {
				return offered;
			}
		}
	}

	/**
	 * Whether this caller may ring anybody yet, given who is ahead of them.
	 *
	 * ## The gate, and why it is a bound rather than a turnstile
	 *
	 * A caller may offer when their rank in the shared line is at most the number of agents currently
	 * eligible. Rank 1 with one free agent offers; ranks 1, 2 and 3 with three free agents all offer,
	 * and the reservation's compare-and-set sorts out who gets whom; rank 3 with one free agent waits,
	 * which is precisely how a priority-800 caller who arrived a moment ago gets the phone before a
	 * priority-0 caller who has been holding.
	 *
	 * The obvious alternative — only rank 1 may offer — is a turnstile, and it is wrong in a way that
	 * costs real money: a queue with five free agents would serve one caller per poll interval,
	 * turning an instant answer for five people into a five-second staircase, and doing it precisely
	 * during the traffic spike that made five people call at once. The bound gives the same ordering
	 * guarantee with none of the serialisation, because the thing that must be exclusive (the AGENT)
	 * is already made exclusive by `reserve`.
	 *
	 * ## It opens when the line is unknown
	 *
	 * A rank of 0 means the record could not be read. The gate then passes, and that is deliberate: a
	 * broker hiccup must degrade priority ordering, not stop a queue distributing calls. The failure
	 * this direction is "for a few seconds the queue behaved exactly as it did before priorities
	 * existed"; the other direction is a queue that silently answers nobody while the wallboard fills
	 * up, which is an outage nobody would attribute to a KV read.
	 */
	private mayOffer(eligibleAgents: number): boolean {
		if (this.position <= 0) {
			return true;
		}
		return this.position <= Math.max(1, eligibleAgents);
	}

	/**
	 * The exit key, checked once per pass.
	 *
	 * Digits that are NOT the exit key are ignored here and deliberately left in the leg's buffer —
	 * see {@link QueueCallPort.pollDigit}. Only one digit is taken per pass, which is enough: the pass
	 * runs every poll interval, and a caller who mashes four keys has the first of them answered
	 * within a second rather than having three of them silently discarded.
	 */
	private async exitKeyPressed(): Promise<QueueOutcome | undefined> {
		const key = this.node.exitKey;
		if (key === undefined || key === "") {
			return undefined;
		}
		const digit = this.call.pollDigit();
		if (digit === undefined || digit.toUpperCase() !== key.toUpperCase()) {
			return undefined;
		}

		const waitMs = this.waitedMs();
		this.call.note(
			`queue "${this.node.queueId}": the caller pressed the exit key "${key}" after ${String(Math.round(waitMs / MILLIS_PER_SECOND))}s and left the queue`,
		);
		await this.call.stopMusicOnHold();
		await this.services.events.callerAbandoned({
			orgId: this.call.organizationId,
			queueId: this.node.queueId,
			callId: this.call.callId,
			legId: this.call.callerLegId,
			waitMs,
			reason: "exit-key",
			exitKey: key,
			...(this.position > 0 ? { position: this.position } : {}),
		});
		return { kind: "exit-key", digit: key, waitMs };
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
	): { readonly candidates: readonly QueueCandidate[]; readonly eligible: number } {
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

		// The count BEFORE the fan-out narrows it to one. That is what the admission gate needs: "how
		// many phones could be ringing right now", not "how many this caller is about to ring".
		const eligible = selection.ordered.length;

		if (selection.fanOut === "all") {
			return { candidates: selection.ordered, eligible };
		}

		if (this.node.strategy === "sequential") {
			this.frozenOrder ??= selection.ordered.map((candidate) => candidate.agent.agentId);
			const frozen = this.frozenOrder;
			const byId = new Map(selection.ordered.map((c) => [c.agent.agentId, c]));
			for (const agentId of frozen) {
				const candidate = byId.get(agentId);
				if (candidate !== undefined) {
					return { candidates: [candidate], eligible };
				}
			}
			// Everybody on the frozen list has been tried or has gone. The pass is over; the loop
			// keeps waiting, and the next selection re-freezes only if the order was never set.
			return { candidates: [], eligible };
		}

		return {
			candidates: selection.ordered.length === 0 ? [] : [selection.ordered[0] as QueueCandidate],
			eligible,
		};
	}

	// -------------------------------------------------------------------------------------------
	// Offering the call
	// -------------------------------------------------------------------------------------------

	/**
	 * Rings the selected agents and settles what happened.
	 *
	 * Returns `undefined` when the caller is still waiting — the loop's signal to try again.
	 *
	 * Agents are moved to `ringing` BEFORE the originate. The state port applies that transition with
	 * a revision-conditional write, so two engine instances racing from the same `available` revision
	 * have exactly one winner. A refused write simply removes that candidate from this offer.
	 */
	private async offer(
		membership: QueueMembership,
		candidates: readonly QueueCandidate[],
	): Promise<QueueOutcome | undefined> {
		const reserved: QueueCandidate[] = [];
		const pending = new Map<string, QueueCandidate>();
		try {
			for (const candidate of candidates) {
				const written = await this.services.agents.reserve({
					orgId: this.call.organizationId,
					agentId: candidate.agent.agentId,
					to: "ringing",
					queueId: this.node.queueId,
					callId: this.call.callId,
					legId: this.call.callerLegId,
					now: this.call.now(),
				});
				if (
					(written?.previousStatus === "available" || written?.previousStatus === "wrap-up") &&
					written.callId === this.call.callId
				) {
					reserved.push(candidate);
					pending.set(candidate.agent.agentId, candidate);
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
					return await this.answered(membership, pending, outcome.agentId, outcome.mediaChannelId);
				}
				case "aborted": {
					await this.releaseAll(pending, undefined);
					return await this.abandon("caller-hangup");
				}
				case "failed": {
					await this.releaseAll(pending, outcome.cause);
					break;
				}
				default: {
					await this.releaseAll(pending, "NO_ANSWER");
					break;
				}
			}

			await this.startMusic();
			return undefined;
		} finally {
			// Any exception after reservation leaves every still-ringing agent eligible again. Entries
			// already settled above are removed from `pending`, so normal penalties are not overwritten.
			await this.releaseAll(pending, undefined);
		}
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
		reserved: Map<string, QueueCandidate>,
		agentId: string,
		mediaChannelId: string,
	): Promise<QueueOutcome> {
		const waitMs = this.waitedMs();

		const onCall = await this.services.agents.transition({
			orgId: this.call.organizationId,
			agentId,
			to: "on-call",
			queueId: this.node.queueId,
			callId: this.call.callId,
			legId: this.call.callerLegId,
			noAnswerCount: 0,
		});
		if (
			onCall === undefined ||
			onCall.previousStatus !== "ringing" ||
			onCall.callId !== this.call.callId
		) {
			await this.call.hangupAnsweredAgent(mediaChannelId);
			return {
				kind: "failed",
				reason: "the answering agent could not be moved from ringing to on-call",
			};
		}
		reserved.delete(agentId);
		this.services.cursor.remember(this.call.organizationId, this.node.queueId, agentId);

		await this.releaseAll(reserved, undefined);

		await this.services.events.callerAnswered({
			orgId: this.call.organizationId,
			queueId: this.node.queueId,
			callId: this.call.callId,
			legId: this.call.callerLegId,
			agentId,
			waitMs,
			strategy: this.node.strategy,
		});

		await this.whisperToAgent(mediaChannelId, membership, agentId);

		const bridged = await this.call.bridge(mediaChannelId, () => {
			void this.startWrapUp(membership, agentId);
		});

		// AFTER the bridge, and only after a successful one. Recording is a tap on a bridged
		// conversation (`CallControl.startRecording`), so there is nothing to tap until the two legs
		// are joined — and a recording started against a bridge that failed would be an object with
		// one side of a conversation that never happened, filed under the tenant's retention policy.
		if (bridged) {
			await this.startRecording();
		}

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
	 * The agent's cue, played to them and to nobody else, in the gap before the bridge.
	 *
	 * ## Where in the sequence, and why exactly here
	 *
	 * After `queue.caller.answered` and before `bridge`. Not earlier, because the agent is not
	 * confirmed as the owner of this call until the `on-call` transition has been written and a
	 * whisper played to somebody who then loses the call is a whisper about a customer they never
	 * speak to. Not later, because after the bridge there is a conversation and the caller would hear
	 * it — which is the one thing this prompt must never do.
	 *
	 * ## A failure does not stop the call
	 *
	 * The prompt is a courtesy — "this is the sales queue", "this caller has been waiting four
	 * minutes" — and the call is the product. An announcement is worth less than the call, so a
	 * missing prompt id, an unresolvable media ref and a media server that refuses the playback all
	 * end the same way: a note on the walk, and the bridge is built regardless. Refusing to connect a
	 * caller who has already waited in a queue because a sound file is missing would be a much larger
	 * outage than the one it reported.
	 */
	private async whisperToAgent(
		mediaChannelId: string,
		membership: QueueMembership,
		agentId: string,
	): Promise<void> {
		// The TIER's prompt wins over the queue's, and falls back to it. A tier prompt exists to say
		// something the queue's cannot — "this reached you because level 2 opened, so they have
		// already waited" — and playing both would be two announcements in the second an agent has
		// before they speak. Falling back rather than going silent is what makes the tier column
		// optional: a queue where one level has a prompt and the others do not still whispers to
		// everybody.
		const tier = membership.agents.find((agent) => agent.agentId === agentId);
		const promptId = tier?.announcePromptId ?? this.node.agentWhisperPromptId;
		if (promptId === undefined || promptId.trim() === "") {
			return;
		}
		const media = this.call.resolvePrompt(promptId);
		if (media === undefined) {
			this.call.note(
				`queue "${this.node.queueId}" has an agent whisper prompt that resolves to no playable audio; the agent was bridged without it`,
			);
			return;
		}
		try {
			if (!(await this.call.playToAgent(mediaChannelId, media))) {
				this.call.note(
					`queue "${this.node.queueId}": the agent whisper prompt could not be played; the agent was bridged without it`,
				);
			}
		} catch (error) {
			this.call.note(
				`queue "${this.node.queueId}": the agent whisper prompt failed (${String(error)}); the agent was bridged without it`,
			);
		}
	}

	/**
	 * Starts the call recording the queue's policy asks for.
	 *
	 * ## Which policies record, and why `inbound` does
	 *
	 * `all` and `inbound`. A queued call is INBOUND from the queue's point of view whichever direction
	 * the leg that reached the queue was travelling — somebody waited and an agent took them — so a
	 * policy of `inbound` on a queue means "record what this queue distributes". `outbound` therefore
	 * never records here, and `on-demand` deliberately does not either: that is the policy that means
	 * "the agent starts it by hand", and a queue that pre-empted them would make the record-toggle
	 * feature code a no-op and the policy a lie.
	 *
	 * ## A failure is a note, never a hangup
	 *
	 * The three ways this fails are a media plane that never decodes audio (a relay-only bridge cannot
	 * be tapped), a media server that refuses the tap, and a leg that is already being recorded. None
	 * of them is worth dropping a call a customer has already queued for. They are all worth a line on
	 * the walk, because "why is there no recording for this call?" is a compliance question and
	 * "nothing happened" is not an answer to it.
	 *
	 * The honest limitation, recorded rather than hidden: this makes recording BEST-EFFORT, and a
	 * tenant with a legal obligation to record needs the call REFUSED when it cannot be. That is a
	 * different setting (a `record_required` flag whose failure is a hangup with a spoken reason) and
	 * a different conversation with the operator, and inventing it here would mean choosing on their
	 * behalf which of two liabilities they prefer.
	 */
	private async startRecording(): Promise<void> {
		const policy = this.node.recordPolicy;
		if (policy !== "all" && policy !== "inbound") {
			return;
		}
		try {
			this.recording = await this.call.startRecording();
		} catch (error) {
			this.recording = false;
			this.call.note(
				`queue "${this.node.queueId}": recording could not be started (${String(error)}); the call was connected without it`,
			);
			return;
		}
		if (!this.recording) {
			this.call.note(
				`queue "${this.node.queueId}" has a record policy of "${policy}" and the recording could not be started; the call was connected without it`,
			);
		}
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
	 *
	 * A failed write does not forget the reservation. One unref'd retry loop keeps the original
	 * request (and therefore the original penalty deadline) until the write succeeds or a fresh read
	 * proves another call owns the entry.
	 */
	private async releaseAll(
		reserved: Map<string, QueueCandidate>,
		cause: HangupCause | undefined,
	): Promise<void> {
		for (const [agentId, candidate] of reserved) {
			if (this.transitionRetries.has(agentId)) {
				continue;
			}
			const release = this.releaseFor(candidate, cause);
			if (await this.release(release)) {
				reserved.delete(agentId);
			} else {
				this.scheduleReleaseRetry(reserved, release, RELEASE_RETRY_INITIAL_MS);
			}
		}
	}

	private releaseFor(candidate: QueueCandidate, cause: HangupCause | undefined): AgentRelease {
		const agent = candidate.agent;

		if (cause === undefined) {
			return {
				candidate,
				request: {
					orgId: this.call.organizationId,
					agentId: agent.agentId,
					to: "available",
					queueId: this.node.queueId,
					callId: this.call.callId,
				},
			};
		}

		const now = this.call.now();
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
			return {
				candidate,
				request: {
					orgId: this.call.organizationId,
					agentId: agent.agentId,
					to: "unavailable",
					queueId: this.node.queueId,
					callId: this.call.callId,
					noAnswerCount,
					reason: "max-no-answer",
				},
			};
		}

		return {
			candidate,
			request: {
				orgId: this.call.organizationId,
				agentId: agent.agentId,
				to: "available",
				queueId: this.node.queueId,
				callId: this.call.callId,
				availableAt: now + delaySeconds * MILLIS_PER_SECOND,
				...(noAnswerCount === undefined ? {} : { noAnswerCount }),
			},
		};
	}

	private async release(release: AgentRelease): Promise<boolean> {
		return (await this.tryOwnedTransition(release.request)) !== "retry";
	}

	private scheduleReleaseRetry(
		reserved: Map<string, QueueCandidate>,
		release: AgentRelease,
		delayMs: number,
	): void {
		const agentId = release.candidate.agent.agentId;
		if (this.transitionRetries.has(agentId)) {
			return;
		}
		void this.retryOwnedTransition(release.request, release.candidate.agent.name, delayMs).then(
			() => {
				reserved.delete(agentId);
			},
		);
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
			await this.transitionOwnedWithRetry({
				orgId: this.call.organizationId,
				agentId,
				to: "available",
				queueId: this.node.queueId,
				callId: this.call.callId,
			});
			return;
		}

		const until = this.call.now() + seconds * MILLIS_PER_SECOND;
		const wrapped = await this.transitionOwnedWithRetry({
			orgId: this.call.organizationId,
			agentId,
			to: "wrap-up",
			queueId: this.node.queueId,
			callId: this.call.callId,
			availableAt: until,
		});
		if (!wrapped) {
			return;
		}

		await this.call.delay(Math.max(0, until - this.call.now()));

		await this.transitionOwnedWithRetry({
			orgId: this.call.organizationId,
			agentId,
			to: "available",
			queueId: this.node.queueId,
			callId: this.call.callId,
		});
	}

	private async transitionOwnedWithRetry(request: AgentTransitionRequest): Promise<boolean> {
		const result = await this.tryOwnedTransition(request);
		if (result !== "retry") {
			return result === "succeeded";
		}
		return await this.retryOwnedTransition(request, request.agentId, RELEASE_RETRY_INITIAL_MS);
	}

	private async tryOwnedTransition(
		request: AgentTransitionRequest,
	): Promise<OwnedTransitionResult> {
		if ((await this.services.agents.transition(request)) !== undefined) {
			return "succeeded";
		}

		const current = await this.services.agents.readState(request.orgId, request.agentId);
		if (current.kind === "unavailable") {
			return "retry";
		}
		if (current.kind === "absent" || !isOwnedByCall(current.entry, request.callId)) {
			return "ownership-changed";
		}
		return "retry";
	}

	private retryOwnedTransition(
		request: AgentTransitionRequest,
		agentLabel: string,
		delayMs: number,
	): Promise<boolean> {
		const existing = this.transitionRetries.get(request.agentId);
		if (existing !== undefined) {
			return existing.promise;
		}

		let resolveRetry: (succeeded: boolean) => void = () => undefined;
		const promise = new Promise<boolean>((resolve) => {
			resolveRetry = resolve;
		});
		const retry = { request, promise, resolve: resolveRetry };
		this.transitionRetries.set(request.agentId, retry);

		const schedule = (nextDelayMs: number): void => {
			this.settings.scheduleReleaseRetry(async () => {
				let result: OwnedTransitionResult = "retry";
				try {
					result = await this.tryOwnedTransition(request);
				} catch (error) {
					this.call.note(`transitioning queue agent ${agentLabel} failed: ${String(error)}`);
				}

				if (result !== "retry") {
					this.transitionRetries.delete(request.agentId);
					retry.resolve(result === "succeeded");
					return;
				}
				schedule(Math.min(nextDelayMs * 2, RELEASE_RETRY_MAX_MS));
			}, nextDelayMs);
		};

		schedule(delayMs);
		return promise;
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
		// The line is re-read on EVERY pass, not only when an announcement is due, because the
		// position is also the admission gate's input — a caller who only refreshed once a minute
		// would spend that minute deciding whether to ring anybody from a rank that is up to a minute
		// stale. The read is a point get; the lease renewal inside it is throttled separately.
		this.applyView(
			await this.services.waiting.refresh({
				orgId: this.call.organizationId,
				queueId: this.node.queueId,
				callId: this.call.callId,
				legId: this.call.callerLegId,
				priority: this.priority,
				instanceId: this.settings.instanceId,
				joinedAt: this.orderedAt,
				now: this.call.now(),
				...(this.call.callerNumber === undefined ? {} : { callerNumber: this.call.callerNumber }),
			}),
		);

		if (!this.node.announcePositionEnabled || this.node.announceFrequencySeconds <= 0) {
			return;
		}
		const now = this.call.now();
		if (now - this.lastAnnouncedAt < this.node.announceFrequencySeconds * MILLIS_PER_SECOND) {
			return;
		}

		if (this.position <= 0) {
			// The shared line could not be read, so there is no position to announce. Silence and a
			// note, rather than the number this process could have guessed from its own callers: a
			// guess is what the counter this replaced did, and it is how a caller who is ninth is told
			// four times that they are third. `lastAnnouncedAt` is deliberately NOT advanced, so the
			// next pass that CAN read the line announces immediately rather than a minute later.
			this.call.note(
				`queue "${this.node.queueId}": the shared waiting line could not be read, so no position was announced`,
			);
			return;
		}
		this.lastAnnouncedAt = now;

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

	private async publishJoined(resumed: boolean): Promise<void> {
		await this.services.events.callerJoined({
			orgId: this.call.organizationId,
			queueId: this.node.queueId,
			callId: this.call.callId,
			legId: this.call.callerLegId,
			// The event's floor is 1 and an unreadable line has no position, so the fallback stays.
			// It is a floor on the WIRE, not a guess in the runtime: `this.position` is left at 0 and
			// the announcement declines, which is the difference that matters.
			position: Math.max(1, this.position),
			priority: this.priority,
			...(resumed ? { resumed: true } : {}),
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

function isOwnedByCall(entry: AgentStateEntry, callId: string): boolean {
	return (
		(entry.status === "ringing" || entry.status === "on-call" || entry.status === "wrap-up") &&
		entry.callId === callId
	);
}
