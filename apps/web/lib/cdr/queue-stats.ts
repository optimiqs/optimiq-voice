import { formatDuration } from "./format";
import type { QueueStatsRow } from "./contracts";
import type { BadgeTone } from "./format";

/**
 * How a queue's service level READS.
 *
 * Separate from `format.ts` because that file is about one CALL — a duration, a disposition, the
 * shape of a leg tree — and this is about an aggregate over thousands of them. The decisions here
 * are the ones that make a wallboard honest rather than decorative, and every one of them is a
 * place where the obvious rendering is the wrong one:
 *
 * - a queue with no traffic has no service level, and `0%` would put it in the same colour as one
 *   that is failing;
 * - `offered` is not `answered + abandoned`, so a "success rate" computed from two of the six
 *   outcomes would flatter a queue nobody staffs;
 * - the colour has to come from the TARGET the reader can see, not from a constant, because the
 *   target is a question the control asks and not a stored setting.
 *
 * Pure, so all of that is testable without a socket, a DOM or a database.
 */

/**
 * The service level as text, with the null case spelled out rather than coalesced.
 *
 * "No traffic" and "0.0%" are different facts about a queue and must never look the same: the first
 * is a queue nobody called in the window, the second is a queue that took calls and answered none
 * of them inside the target. A wallboard that showed both as `0%` would light up a quiet
 * out-of-hours queue exactly like a collapsing one, which is how a screen full of red teaches
 * people to ignore it.
 */
export function formatServiceLevel(serviceLevelPct: number | null): string {
	return serviceLevelPct === null ? "No traffic" : `${serviceLevelPct.toFixed(1)}%`;
}

/**
 * Whether a service level is one somebody has to do something about.
 *
 * Three bands rather than a pass/fail line, because a contact centre is not binary and a tile that
 * flipped from green to red at 79.9% would be a tile people learn to distrust. The thresholds are
 * relative to the target percentage a supervisor is measuring against — 90% of calls inside the
 * target is the conventional goal — and `null` is NEUTRAL rather than a failure, for the reason
 * {@link formatServiceLevel} gives.
 */
export const SERVICE_LEVEL_GOAL_PCT = 90;
export const SERVICE_LEVEL_WARNING_PCT = 75;

export function serviceLevelTone(serviceLevelPct: number | null): BadgeTone {
	if (serviceLevelPct === null) {
		return "neutral";
	}
	if (serviceLevelPct >= SERVICE_LEVEL_GOAL_PCT) {
		return "success";
	}
	return serviceLevelPct >= SERVICE_LEVEL_WARNING_PCT ? "warning" : "danger";
}

/**
 * The share of offered calls that gave up, to one decimal. `null` when nothing was offered.
 *
 * Of OFFERED and not of "abandoned plus answered", which is the same argument the server makes for
 * `serviceLevelPct`: a queue that answered two calls, abandoned ten and timed out a hundred did not
 * have an 83% abandon rate, it had a 9% one and a routing problem. Both denominators being the same
 * is what lets a reader add the columns up.
 */
export function abandonRatePct(row: QueueStatsRow): number | null {
	if (row.offered === 0) {
		return null;
	}
	return Math.round((row.abandoned / row.offered) * 1_000) / 10;
}

/**
 * The outcomes that are NOT "an agent took the call", as label/value pairs, with the zeroes dropped.
 *
 * Four ways to fail and they need different fixes — a caller who hung up is a staffing problem, a
 * timeout is a wait cap somebody set, `noAgents` is nobody logged in, and an exit-key press is the
 * caller choosing a different route and is arguably the feature working. Collapsing them into one
 * "unanswered" number is exactly the summary that makes a queue's actual problem invisible.
 *
 * Zeroes are dropped because a wallboard is read from across a room: four rows of `0` on every
 * healthy queue is four rows of noise obscuring the one queue with a number in it.
 */
export function describeShortfalls(
	row: QueueStatsRow,
): readonly { readonly label: string; readonly value: number }[] {
	return [
		{ label: "Gave up", value: row.abandoned },
		{ label: "Timed out", value: row.timedOut },
		{ label: "Nobody logged in", value: row.noAgents },
		{ label: "Pressed the exit key", value: row.exited },
	].filter((entry) => entry.value > 0);
}

/**
 * An empty row for a queue the window returned nothing for.
 *
 * A queue with no traffic is ABSENT from the response — the query groups over legs that exist — so
 * a wallboard listing every configured queue has to decide what to render in the gap. It renders
 * this: zeroes, and a `null` service level, which every reader here already treats as "no traffic".
 * The alternative, hiding the queue, would make a queue that received no calls all morning
 * indistinguishable from a queue that was deleted — and the first of those is sometimes the
 * incident.
 */
export function emptyQueueStats(queueId: string): QueueStatsRow {
	return {
		queueId,
		offered: 0,
		answered: 0,
		abandoned: 0,
		timedOut: 0,
		noAgents: 0,
		exited: 0,
		averageAnswerWaitMs: 0,
		averageAbandonWaitMs: 0,
		longestAnswerWaitMs: 0,
		serviceLevelPct: null,
		withinTarget: 0,
	};
}

// ---------------------------------------------------------------------------------------------
// The live half: how a wait reads, and when it should pull an eye
// ---------------------------------------------------------------------------------------------

/**
 * A wait, as `mm:ss` — or an em dash when there is nobody to time.
 *
 * The reporting area's own formatter, reused rather than restated: the eye compares `00:12` to
 * `04:31` in a way it cannot compare `12s` to `4.5m`, and a wallboard is very little except that
 * comparison. `null` is the empty line and renders as a dash, because "nobody is waiting" and
 * "somebody arrived this instant" are different facts and `00:00` would say the second.
 */
export function formatWait(millis: number | null): string {
	return millis === null ? "—" : formatDuration(millis);
}

/**
 * How long the worst wait has to be before a tile stops looking calm.
 *
 * Two minutes and five minutes. These are DISPLAY thresholds and not policy: the queue's own
 * `maxWaitSeconds` is what actually ejects a caller, and this only decides when a supervisor's eye
 * is pulled across the room.
 *
 * Deliberately NOT derived from the queue's wait cap, which is the obvious idea and the wrong one:
 * a queue whose cap is 0 holds callers indefinitely, so a threshold computed from it would never
 * fire — and a queue holding somebody forever is precisely the one where somebody needs to notice.
 */
export const WAIT_BUSY_MS = 120_000;
export const WAIT_ALERT_MS = 300_000;

export type WaitTone = "neutral" | "busy" | "alert";

export function waitTone(longestMs: number): WaitTone {
	if (longestMs >= WAIT_ALERT_MS) {
		return "alert";
	}
	return longestMs >= WAIT_BUSY_MS ? "busy" : "neutral";
}
