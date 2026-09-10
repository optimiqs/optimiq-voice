import type {
	AgentStatsRow,
	CallVolumeDestinationRow,
	CallVolumeEnvelope,
	CallVolumeRow,
} from "./contracts";

/**
 * How the historical reports READ.
 *
 * Separate from `queue-stats.ts` for the same reason that file is separate from `format.ts`: that
 * one is about a QUEUE's window and this is about an agent's and an organization's. What the two
 * share is the shape of the mistakes, and every function here exists because the obvious rendering
 * of its number is the wrong one:
 *
 * - an answer rate over a bucket with no calls is not `0%`, it is nothing, and a chart that draws
 *   the two identically makes a quiet Sunday look like an outage;
 * - a wrap-up average built from two gaps is not a statistic, so the sample count travels with it
 *   and a screen is given the means to say "not enough data" rather than a confident wrong number;
 * - a destination series arrives as `(bucket, type)` triples with the empty combinations ABSENT, so
 *   anything drawing a stacked chart has to fill the holes itself or silently shift its own bars.
 *
 * Pure, so all of that is testable without a DOM, a socket or a database.
 */

/** The share of a bucket's calls that reached an answer, to one decimal. `null` when idle. */
export function answerRatePct(row: Pick<CallVolumeRow, "total" | "answered">): number | null {
	if (row.total === 0) {
		return null;
	}
	return Math.round((row.answered / row.total) * 1_000) / 10;
}

/**
 * The busiest bucket in a series, or `undefined` for an empty one.
 *
 * Ties go to the EARLIER bucket, which is the one a reader looking for "when did it start" wants.
 * One pass rather than a sort: the caller already has the series in chronological order and sorting
 * a copy of it to read one element is the shape of thing that makes a 2 000-point chart stutter.
 */
export function busiestBucket(rows: readonly CallVolumeRow[]): CallVolumeRow | undefined {
	let busiest: CallVolumeRow | undefined;
	for (const row of rows) {
		if (busiest === undefined || row.total > busiest.total) {
			busiest = row;
		}
	}
	return busiest;
}

export interface VolumeTotals {
	readonly total: number;
	readonly inbound: number;
	readonly outbound: number;
	readonly internal: number;
	readonly answered: number;
	readonly unanswered: number;
	readonly answerRatePct: number | null;
	/**
	 * Mean billed length across the whole window, re-weighted by each bucket's ANSWERED count.
	 *
	 * Re-weighted and not a mean of the per-bucket means, which is the error this function exists to
	 * not make: a quiet hour with one nine-minute call would otherwise pull the window's average as
	 * hard as a busy hour with two hundred short ones.
	 */
	readonly averageBillsecMs: number;
}

/** Folds a bucketed series into the header figures. One pass; no intermediate arrays. */
export function volumeTotals(rows: readonly CallVolumeRow[]): VolumeTotals {
	let total = 0;
	let inbound = 0;
	let outbound = 0;
	let internal = 0;
	let answered = 0;
	let weightedBillsecMs = 0;
	for (const row of rows) {
		total += row.total;
		inbound += row.inbound;
		outbound += row.outbound;
		internal += row.internal;
		answered += row.answered;
		weightedBillsecMs += row.averageBillsecMs * row.answered;
	}
	return {
		total,
		inbound,
		outbound,
		internal,
		answered,
		unanswered: total - answered,
		answerRatePct: answerRatePct({ total, answered }),
		averageBillsecMs: answered === 0 ? 0 : Math.round(weightedBillsecMs / answered),
	};
}

/**
 * The destination triples collapsed to a window-wide breakdown, busiest first.
 *
 * Indexed through a `Map` rather than a `.find` per triple: an hourly series over a quarter is two
 * thousand buckets times a growing domain, and the quadratic version of this is the one that turns
 * a report into a frozen tab.
 */
export function destinationTotals(rows: readonly CallVolumeDestinationRow[]): readonly {
	readonly destinationType: string;
	readonly total: number;
	readonly answered: number;
}[] {
	const byType = new Map<string, { destinationType: string; total: number; answered: number }>();
	for (const row of rows) {
		const entry = byType.get(row.destinationType);
		if (entry === undefined) {
			byType.set(row.destinationType, {
				destinationType: row.destinationType,
				total: row.total,
				answered: row.answered,
			});
			continue;
		}
		entry.total += row.total;
		entry.answered += row.answered;
	}
	return [...byType.values()].sort(
		(left, right) =>
			right.total - left.total || left.destinationType.localeCompare(right.destinationType),
	);
}

/**
 * Every destination type present anywhere in the window, in the order {@link destinationTotals}
 * puts them — so a legend, a stacked bar and a table cannot disagree about which colour is which.
 */
export function destinationSeriesKeys(envelope: CallVolumeEnvelope): readonly string[] {
	return destinationTotals(envelope.destinations).map((entry) => entry.destinationType);
}

/**
 * The share of an agent's time that was talking rather than recovering, to one decimal.
 *
 * Talk over talk-plus-wrap-up, and NOT over the wall clock: this app has no idea when an agent was
 * logged in, and a "utilisation" computed against an eight-hour day it invented would be a number
 * with an authoritative look and no basis. `null` when there is nothing to divide, which is what
 * {@link hasUsableWrapUp} exists to let a screen say out loud.
 */
export function talkSharePct(row: AgentStatsRow): number | null {
	const denominator = row.talkTimeMs + row.wrapUpMs;
	if (denominator === 0) {
		return null;
	}
	return Math.round((row.talkTimeMs / denominator) * 1_000) / 10;
}

/**
 * Whether an agent's wrap-up average rests on enough gaps to be worth showing.
 *
 * Five, which is a judgement rather than a derivation and is stated as one. The point is not the
 * threshold: it is that a mean of one gap and a mean of four hundred must not render identically,
 * because the first one is noise that a supervisor will otherwise take into a conversation with a
 * person about their performance.
 */
export const MIN_WRAP_UP_SAMPLES = 5;

export function hasUsableWrapUp(row: AgentStatsRow): boolean {
	return row.wrapUpSamples >= MIN_WRAP_UP_SAMPLES;
}

/**
 * An empty row for an agent the window returned nothing for.
 *
 * An agent who took no calls is ABSENT from the response — the query groups over legs that exist —
 * so a report listing the whole roster has to decide what to render in the gap. It renders this,
 * for the reason `emptyQueueStats` exists: an agent who took no calls all week and an agent who was
 * removed from the queue must not look the same, and the first of those is sometimes the point.
 */
export function emptyAgentStats(agentId: string): AgentStatsRow {
	return {
		agentId,
		answered: 0,
		talkTimeMs: 0,
		averageTalkTimeMs: 0,
		longestTalkTimeMs: 0,
		averageAnswerWaitMs: 0,
		averageRingTimeMs: 0,
		wrapUpMs: 0,
		averageWrapUpMs: 0,
		wrapUpSamples: 0,
		queues: [],
	};
}
