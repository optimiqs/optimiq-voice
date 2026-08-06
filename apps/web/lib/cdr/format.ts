import type { CallDirection, CallDisposition, CallLegRow, RecordingRow } from "./contracts";

/**
 * How a call record READS.
 *
 * Pure and here rather than in the components, because these are the decisions that make a call
 * list legible and every one of them is testable: how a duration is written, which outcomes are
 * green, and — the one that actually matters — how a flat list of legs becomes the shape of a call.
 */

/**
 * `mm:ss`, or `h:mm:ss` past an hour.
 *
 * Not "3.4 minutes" and not "204000ms". A call list is scanned for outliers, and the eye compares
 * `00:12` to `04:31` in a way it cannot compare `12s` to `4.5m`. Sub-second durations round DOWN to
 * `00:00` rather than up, because a leg that lasted 400ms did not last a second and reporting it as
 * one is how "why does this show 1s of billing" tickets start.
 */
export function formatDuration(millis: number): string {
	const total = Math.max(0, Math.floor(millis / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const pad = (value: number): string => String(value).padStart(2, "0");
	return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * The billable duration, with zero written as an em dash.
 *
 * `00:00` and "not billed" are different facts and must not look the same: an unanswered leg that
 * rang for thirty seconds bills nothing, and showing it as `00:00` next to an answered leg that
 * genuinely lasted under a second makes the billing column unreadable.
 */
export function formatBillsec(millis: number): string {
	return millis <= 0 ? "—" : formatDuration(millis);
}

/** Byte sizes for a recordings list. Binary units, because that is what the object store reports. */
export function formatBytes(bytes: number): string {
	if (bytes <= 0) {
		return "—";
	}
	const units = ["B", "KiB", "MiB", "GiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? "B"}`;
}

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

/**
 * The colour of an outcome.
 *
 * `voicemail` is deliberately NOT green: the caller reached a machine, which is a different thing
 * from reaching a person, and a report that paints them the same colour hides the metric a contact
 * centre actually watches. `no-answer` is a warning rather than a danger — nobody picked up, which
 * is normal — while `failed` is a danger, because something broke.
 */
export function dispositionTone(disposition: CallDisposition): BadgeTone {
	switch (disposition) {
		case "answered":
			return "success";
		case "voicemail":
			return "accent";
		case "no-answer":
			return "warning";
		case "busy":
			return "warning";
		default:
			return "danger";
	}
}

export function dispositionLabel(disposition: CallDisposition): string {
	return disposition === "no-answer" ? "No answer" : capitalize(disposition);
}

export function directionLabel(direction: CallDirection): string {
	return capitalize(direction);
}

export function directionTone(direction: CallDirection): BadgeTone {
	return direction === "internal" ? "neutral" : "accent";
}

/**
 * The tone of a hangup cause.
 *
 * `NORMAL_CLEARING` is the one cause that means "nothing went wrong", so it is the only neutral
 * one; everything else is at least worth noticing. The distinction between warning and danger is
 * "the call did not connect for an ordinary reason" versus "the platform or the carrier failed",
 * which is the split an operator triages on.
 */
const ORDINARY_CAUSES = new Set([
	"NORMAL_CLEARING",
	"ORIGINATOR_CANCEL",
	"USER_BUSY",
	"NO_ANSWER",
	"NO_USER_RESPONSE",
	"LOSE_RACE",
	"SUBSCRIBER_ABSENT",
	"BLIND_TRANSFER",
	"ATTENDED_TRANSFER",
	"PICKED_OFF",
	"NONE",
]);

export function hangupCauseTone(cause: string): BadgeTone {
	if (cause === "NORMAL_CLEARING" || cause === "NONE") {
		return "neutral";
	}
	return ORDINARY_CAUSES.has(cause) ? "warning" : "danger";
}

/** `NO_USER_RESPONSE` → `No user response`. The taxonomy is for machines; the column is for people. */
export function hangupCauseLabel(cause: string): string {
	return capitalize(cause.toLowerCase().replace(/_/gu, " "));
}

/** `ring_group` → `Ring group`; the routing plan's kebab forms read the same way. */
export function destinationTypeLabel(destinationType: string): string {
	return capitalize(destinationType.replace(/[_-]/gu, " "));
}

/**
 * A leg's counterparty — who the row is ABOUT.
 *
 * On an inbound leg the interesting party is the caller; on an outbound one it is the callee. A
 * list that always shows `from → to` makes the reader do that translation on every row.
 */
export function counterparty(leg: CallLegRow): string {
	return leg.direction === "outbound" ? leg.toNumber : leg.fromNumber;
}

export interface CallLegNode {
	readonly leg: CallLegRow;
	readonly children: readonly CallLegNode[];
	/** How deep this leg sits under the A-leg, for indentation. */
	readonly depth: number;
}

/**
 * The legs of one call, as the tree they actually form.
 *
 * A ring-group call is one A-leg and four B-legs; a transfer adds another. Rendering them as five
 * sibling rows loses the only interesting thing about the record — which leg dialled which — so
 * this reassembles it from `originatingLegId`, the column the engine sets on every B-leg precisely
 * so this is possible (`channel-orchestrator.service.ts`: "this is what makes the four rows of a
 * ring-group call assemble back into one call").
 *
 * ## Orphans are kept, not dropped
 *
 * A leg whose `originatingLegId` names a leg that is not in the set — because the parent's
 * partition was dropped by retention, or because the range the user is looking at starts after it
 * — is attached at the ROOT rather than discarded. A recording of a call that shows four of five
 * legs is a bug report; a recording that shows five legs with one of them unattached is a true
 * statement about what is known.
 *
 * Cycles cannot occur in the data (a leg is originated before it can originate), but a corrupted
 * row could produce one, so traversal is bounded by the visited set rather than by trust.
 */
export function buildCallTree(legs: readonly CallLegRow[]): readonly CallLegNode[] {
	const byId = new Map(legs.map((leg) => [leg.id, leg]));
	const children = new Map<string, CallLegRow[]>();
	const roots: CallLegRow[] = [];

	for (const leg of legs) {
		const parentId = leg.originatingLegId;
		if (parentId !== null && parentId !== leg.id && byId.has(parentId)) {
			const bucket = children.get(parentId);
			if (bucket) {
				bucket.push(leg);
			} else {
				children.set(parentId, [leg]);
			}
		} else {
			roots.push(leg);
		}
	}

	const visited = new Set<string>();
	const build = (leg: CallLegRow, depth: number): CallLegNode => {
		visited.add(leg.id);
		const kids = (children.get(leg.id) ?? [])
			.filter((child) => !visited.has(child.id))
			.map((child) => build(child, depth + 1));
		return { leg, children: kids, depth };
	};

	return roots.filter((leg) => !visited.has(leg.id)).map((leg) => build(leg, 0));
}

/** The tree flattened back to rows, in the order it should be drawn. */
export function flattenCallTree(nodes: readonly CallLegNode[]): readonly CallLegNode[] {
	const out: CallLegNode[] = [];
	const walk = (node: CallLegNode): void => {
		out.push(node);
		for (const child of node.children) {
			walk(child);
		}
	};
	for (const node of nodes) {
		walk(node);
	}
	return out;
}

/** The recordings that belong to one leg. */
export function recordingsForLeg(
	recordings: readonly RecordingRow[],
	legId: string,
): readonly RecordingRow[] {
	return recordings.filter((recording) => recording.legId === legId);
}

function capitalize(value: string): string {
	return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}
