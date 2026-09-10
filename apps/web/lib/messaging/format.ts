import type { BadgeTone } from "../cdr/format";
import type {
	CampaignStatus,
	ConversationRow,
	MessageStatus,
	RegistrationStatus,
	TollFreeStatus,
} from "./contracts";

/**
 * How a thread READS.
 *
 * Pure and here rather than inside the components, for the reason `lib/cdr/format.ts` states: these
 * are the decisions that make an inbox legible — how a number is written, how old a message is,
 * how much of it fits in a list row, and which colours a registration state earns — and every one
 * of them is a claim a test can pin. A component that formats inline is a claim nothing checks.
 */

/**
 * A number as a person would write it.
 *
 * NANP numbers get the parenthesised form the whole continent reads without thinking; everything
 * else is grouped from the left after the country code, which is wrong for some national
 * conventions and is still far better than nineteen unbroken digits. A value that is not E.164 at
 * all is returned untouched rather than mangled — the API is the authority on what a number is,
 * and a formatter that "corrects" its input hides the bug.
 */
export function formatE164(value: string): string {
	const trimmed = value.trim();
	if (!/^\+\d{7,15}$/u.test(trimmed)) {
		return trimmed;
	}
	const digits = trimmed.slice(1);
	if (digits.length === 11 && digits.startsWith("1")) {
		return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
	}
	const groups = digits.slice(1).replace(/(\d{3})(?=\d)/gu, "$1 ");
	return `+${digits.slice(0, 1)} ${groups}`.trim();
}

/**
 * The name a conversation goes by.
 *
 * The stored `displayName` when there is one, the formatted number otherwise — never both, and
 * never a placeholder like "Unknown". A thread with no name IS the number, and saying so is more
 * useful than saying nothing twice.
 */
export function conversationTitle(conversation: {
	readonly displayName: string | null;
	readonly remoteE164: string;
}): string {
	const name = conversation.displayName?.trim() ?? "";
	return name.length > 0 ? name : formatE164(conversation.remoteE164);
}

/**
 * How long ago, in the shortest true form.
 *
 * A list of threads is scanned, not read: `2m` and `3d` compare at a glance in a way "2 minutes
 * ago" and "3 days ago" do not. Past a week it becomes a date, because "37d" is a number nobody
 * converts in their head. A future timestamp — clock skew between a phone and a server is
 * routine — reads as `now` rather than as a negative age.
 */
export function relativeTime(iso: string | null, now: Date = new Date()): string {
	if (iso === null) {
		return "—";
	}
	const then = new Date(iso);
	const millis = then.getTime();
	if (Number.isNaN(millis)) {
		return "—";
	}
	const seconds = Math.floor((now.getTime() - millis) / 1000);
	if (seconds < 60) {
		return "now";
	}
	if (seconds < 3600) {
		return `${String(Math.floor(seconds / 60))}m`;
	}
	if (seconds < 86_400) {
		return `${String(Math.floor(seconds / 3600))}h`;
	}
	if (seconds < 604_800) {
		return `${String(Math.floor(seconds / 86_400))}d`;
	}
	return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The longest preview a list row can hold before it starts pushing the timestamp off the end. */
export const PREVIEW_MAX_LENGTH = 80;

/**
 * One line of the last message.
 *
 * Newlines collapse to spaces first — a two-line message would otherwise blow the row's height
 * open — and the ellipsis is the single character, not three periods, so the truncated string
 * measures as one glyph rather than three. A message shorter than the limit is never touched, and
 * in particular never gains an ellipsis that suggests there is more to read.
 */
export function truncatePreview(
	value: string | null,
	maxLength: number = PREVIEW_MAX_LENGTH,
): string {
	const flattened = (value ?? "").replace(/\s+/gu, " ").trim();
	if (flattened.length <= maxLength) {
		return flattened;
	}
	return `${flattened.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * What a conversation row's preview cell shows.
 *
 * An MMS with no text is not an empty thread, so it says so in words rather than rendering a blank
 * cell that reads as "nothing happened here".
 */
export function conversationPreview(conversation: ConversationRow): string {
	const preview = truncatePreview(conversation.lastMessagePreview);
	if (preview.length > 0) {
		return preview;
	}
	return conversation.lastMessageAt === null ? "No messages yet" : "Attachment";
}

/** The unread count as it fits in a badge. Past 99 the exact number stops being information. */
export function unreadBadgeLabel(count: number): string {
	if (count <= 0) {
		return "";
	}
	return count > 99 ? "99+" : String(count);
}

export interface StatusPresentation {
	readonly label: string;
	readonly tone: BadgeTone;
}

/**
 * The registration badge.
 *
 * `rejected` is danger and `unregistered` is neutral, and the gap between them is the point: a
 * number nobody has submitted is a task, and a number the carrier refused is a problem with a
 * stated reason attached. Painting both grey would hide the second inside the first.
 */
export function registrationStatusPresentation(status: RegistrationStatus): StatusPresentation {
	switch (status) {
		case "registered": {
			return { label: "Registered", tone: "success" };
		}
		case "pending": {
			return { label: "Pending", tone: "warning" };
		}
		case "rejected": {
			return { label: "Rejected", tone: "danger" };
		}
		default: {
			return { label: "Not registered", tone: "neutral" };
		}
	}
}

/**
 * A message's status pill.
 *
 * `sent` is neutral rather than green on purpose — the carrier took it, nobody has confirmed a
 * phone got it — and only `delivered` earns success. A thread that painted both green would make
 * the delivery receipt, the one thing the status column exists for, invisible.
 */
export function messageStatusPresentation(status: MessageStatus): StatusPresentation {
	switch (status) {
		case "delivered": {
			return { label: "Delivered", tone: "success" };
		}
		case "sent": {
			return { label: "Sent", tone: "neutral" };
		}
		case "sending": {
			return { label: "Sending", tone: "accent" };
		}
		case "queued": {
			return { label: "Queued", tone: "accent" };
		}
		default: {
			return { label: "Failed", tone: "danger" };
		}
	}
}

export function campaignStatusPresentation(status: CampaignStatus): StatusPresentation {
	switch (status) {
		case "active": {
			return { label: "Active", tone: "success" };
		}
		case "pending": {
			return { label: "Pending", tone: "warning" };
		}
		case "rejected": {
			return { label: "Rejected", tone: "danger" };
		}
		case "expired": {
			return { label: "Expired", tone: "danger" };
		}
		default: {
			return { label: "Draft", tone: "neutral" };
		}
	}
}

export function tollFreeStatusPresentation(status: TollFreeStatus): StatusPresentation {
	switch (status) {
		case "verified": {
			return { label: "Verified", tone: "success" };
		}
		case "in-review": {
			return { label: "In review", tone: "warning" };
		}
		case "pending": {
			return { label: "Pending", tone: "warning" };
		}
		case "rejected": {
			return { label: "Rejected", tone: "danger" };
		}
		default: {
			return { label: "Not submitted", tone: "neutral" };
		}
	}
}

/** `local` → `Local`, `toll-free` → `Toll-free`. */
export function numberClassLabel(numberClass: string): string {
	return numberClass === "toll-free" ? "Toll-free" : "Local";
}

/** How an opt-out came to be, in words a person can act on. */
export function optOutSourceLabel(source: string): string {
	switch (source) {
		case "keyword": {
			return "Replied STOP";
		}
		case "carrier": {
			return "Carrier";
		}
		default: {
			return "Added manually";
		}
	}
}

/** `null` retention means "the organization's default", which is a fact and not a blank cell. */
export function retentionLabel(days: number | null): string {
	return days === null ? "Organization default" : `${String(days)} days`;
}

// ---------------------------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------------------------

/**
 * `HH:MM` ↔ minutes past midnight.
 *
 * The form holds `<input type="time">` values and the carrier's campaign body wants a wall-clock
 * string back, so nothing here needs a Date — and deliberately does not use one. Constructing a
 * `Date` to parse "22:00" invents a day, and a day carries a DST transition that can move the very
 * boundary quiet hours exist to hold still. Minutes past midnight is the whole domain.
 *
 * Both directions are total: an unparseable time returns `null` rather than `NaN`, so a caller
 * cannot accidentally send `NaN` to the API, and minutes outside a day WRAP rather than clamp,
 * because 24:00 is midnight and 1500 minutes is tomorrow's 01:00 — which is exactly what an end
 * time before its start time means.
 */
export function timeToMinutes(value: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
	if (!match) {
		return null;
	}
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) {
		return null;
	}
	return hours * 60 + minutes;
}

export function minutesToTime(minutes: number): string {
	const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
	const hours = Math.floor(wrapped / 60);
	const rest = wrapped % 60;
	return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * How long a quiet window lasts, in minutes.
 *
 * A window that ENDS BEFORE it starts crosses midnight — 21:00 to 08:00 is the ordinary case, not
 * an error — so the arithmetic wraps. A window whose ends are equal is a full day of quiet rather
 * than zero, because "no messages between 09:00 and 09:00" cannot sensibly mean "always send".
 */
export function quietHoursDurationMinutes(start: string, end: string): number | null {
	const from = timeToMinutes(start);
	const to = timeToMinutes(end);
	if (from === null || to === null) {
		return null;
	}
	const span = to - from;
	return span > 0 ? span : span + 1440;
}

/** A quiet window in one line, for a status column. */
export function describeQuietHours(quietHours: {
	readonly start: string;
	readonly end: string;
	readonly timeZone: string;
}): string {
	return `${quietHours.start}–${quietHours.end} ${quietHours.timeZone}`;
}
