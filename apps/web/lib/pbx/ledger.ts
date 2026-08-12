/**
 * The two append-only ledgers the PBX area serves, and the things a screen over one of them needs
 * to get right before it renders anything.
 *
 * `/api/v1/audit-log` (the change ledger) and `/api/v1/sip-auth-events` (the attack log) are
 * deliberately the same surface on the server: a defaulted, echoed time window, exact filters over
 * indexed columns, no free-text search, no `total`, and a keyset cursor. That symmetry is worth
 * keeping on this side too — two ledgers that paged differently would be two things for a reader to
 * learn and two places for an off-by-one to hide — so the window, the cursor stack and the request
 * parameters are stated once here and both screens use them.
 *
 * Everything in this file is pure. The hooks that put these values in the URL and in React Query
 * live with their screens; what is testable without a DOM is tested, which is the same division
 * `lib/cdr/time-range.ts` makes for the reporting area.
 *
 * ## Why this is not `lib/cdr/time-range.ts`
 *
 * It is the same idea over a different contract, and the differences are load-bearing rather than
 * cosmetic: these windows default to thirty days and seven days rather than to twenty-four hours,
 * the change ledger refuses a range wider than a year with a specific 400, and the presets a
 * security screen wants are not the presets a call-history screen wants. Importing the reporting
 * area's control and then overriding three of its four constants would be a worse mirror than
 * restating it, and it would make a change to call history silently change the audit log.
 */

// ---------------------------------------------------------------------------------------------
// The server's own numbers, mirrored
// ---------------------------------------------------------------------------------------------

/** `DEFAULT_RANGE_DAYS` in `audit-log.dto.ts` — what the server applies when neither bound is sent. */
export const DEFAULT_AUDIT_RANGE_DAYS = 30;
/** `MAX_RANGE_DAYS`. Wider than this is a 400 (`AUDIT_RANGE_TOO_WIDE`), not a clamp. */
export const MAX_AUDIT_RANGE_DAYS = 366;
export const DEFAULT_AUDIT_LIMIT = 25;
export const MAX_AUDIT_LIMIT = 100;

/** `DEFAULT_EVENT_RANGE_DAYS` in `sip-auth-event.dto.ts`. Seven, not thirty — see below. */
export const DEFAULT_EVENT_RANGE_DAYS = 7;
export const DEFAULT_EVENT_LIMIT = 50;
export const MAX_EVENT_LIMIT = 200;

// ---------------------------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------------------------

/**
 * The presets, plus the custom pair.
 *
 * Four presets rather than three, because the change ledger's own default is thirty days and its
 * ceiling is a year: "this quarter" is a question somebody genuinely asks of a change history
 * ("when did this get turned on?"), and a preset list that stopped at a month would push every one
 * of those into the custom pair.
 *
 * `custom` is what the other five per cent needs — "between 02:00 and 02:20 last Tuesday, when the
 * registrations started failing" — which no preset can express.
 */
export const LEDGER_RANGE_PRESETS = ["24h", "7d", "30d", "90d", "custom"] as const;
export type LedgerRangePreset = (typeof LEDGER_RANGE_PRESETS)[number];

export const LEDGER_RANGE_PRESET_LABELS: Readonly<Record<LedgerRangePreset, string>> = {
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	"90d": "Last 90 days",
	custom: "Custom range",
};

const PRESET_HOURS: Readonly<Record<Exclude<LedgerRangePreset, "custom">, number>> = {
	"24h": 24,
	"7d": 24 * 7,
	"30d": 24 * 30,
	"90d": 24 * 90,
};

export interface ResolvedLedgerRange {
	/** ISO instant, or `undefined` to let the server apply its own default. */
	readonly from: string | undefined;
	readonly to: string | undefined;
}

/** `Date` → the local-time string a `datetime-local` input accepts. */
export function toLocalInputValue(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The instants a preset resolves to, relative to `now`.
 *
 * A `custom` range with one end missing resolves to NOTHING rather than to a half-range. The
 * server would either read the single bound and default the other — silently answering a question
 * nobody asked — or refuse it, and neither is what a user mid-keystroke meant. Falling back to the
 * server's own default keeps the table populated while the second field is being filled in, and
 * the echoed `range` in the response is what tells the user which window they are actually looking
 * at.
 */
export function resolveLedgerRange(
	preset: LedgerRangePreset,
	custom: { readonly from: string; readonly to: string },
	now: Date,
): ResolvedLedgerRange {
	if (preset === "custom") {
		const from = custom.from.length > 0 ? new Date(custom.from) : undefined;
		const to = custom.to.length > 0 ? new Date(custom.to) : undefined;
		if (
			from === undefined ||
			to === undefined ||
			Number.isNaN(from.getTime()) ||
			Number.isNaN(to.getTime())
		) {
			return { from: undefined, to: undefined };
		}
		// Swapped rather than refused, exactly as `resolveAuditRange` does on the server: it is
		// always two date controls wired in the wrong order, and the intent is unambiguous.
		return from.getTime() <= to.getTime()
			? { from: from.toISOString(), to: to.toISOString() }
			: { from: to.toISOString(), to: from.toISOString() };
	}
	const hours = PRESET_HOURS[preset];
	return {
		from: new Date(now.getTime() - hours * 3_600_000).toISOString(),
		to: now.toISOString(),
	};
}

/** Whole days a window spans, rounded up — what {@link MAX_AUDIT_RANGE_DAYS} is compared against. */
export function ledgerRangeDays(range: ResolvedLedgerRange): number | undefined {
	if (range.from === undefined || range.to === undefined) {
		return undefined;
	}
	const from = new Date(range.from).getTime();
	const to = new Date(range.to).getTime();
	if (Number.isNaN(from) || Number.isNaN(to)) {
		return undefined;
	}
	return Math.ceil(Math.abs(to - from) / 86_400_000);
}

/**
 * The message for a window the change ledger will refuse, or `undefined` when it will not.
 *
 * Mirrors `AuditRangeTooWideException` down to the sentence. Shown beside the control rather than
 * sent and caught, because a 400 that empties the table reads as "there is nothing here" — which
 * is the opposite of what a year-wide range means.
 *
 * The attack log has no such ceiling, so this is only asked about the change ledger.
 */
export function auditRangeIssue(range: ResolvedLedgerRange): string | undefined {
	const days = ledgerRangeDays(range);
	if (days === undefined || days <= MAX_AUDIT_RANGE_DAYS) {
		return undefined;
	}
	return `The requested range spans ${String(days)} days; at most ${String(MAX_AUDIT_RANGE_DAYS)} may be queried at once. Narrow the range or page through it.`;
}

// ---------------------------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------------------------

/**
 * Where a reader is in a keyset listing.
 *
 * A stack, not a page number, and that is forced by what a keyset cursor IS: it points forward from
 * an exact position, so "the previous page" cannot be computed from it — it can only be remembered.
 * The empty stack is the first page; every "Older" pushes the cursor the server just handed back,
 * and every "Newer" pops.
 *
 * Held in component state rather than in the URL, which is the one deliberate exception to this
 * app's "filters live in the query string" rule: sharing a FILTER is useful, sharing somebody
 * else's scroll position is not, and a link carrying page four's cursor opens on rows the recipient
 * has no context for.
 */
export type CursorStack = readonly string[];

/** The cursor to send, or `undefined` on the first page. */
export function currentCursor(stack: CursorStack): string | undefined {
	return stack[stack.length - 1];
}

/**
 * The stack after "Older".
 *
 * A `null` next cursor means the server said this was the last page, and pushing nothing is what
 * keeps the button from advancing into an empty listing.
 */
export function pushCursor(stack: CursorStack, next: string | null): CursorStack {
	return next === null ? stack : [...stack, next];
}

/** The stack after "Newer". Already at the first page is a no-op rather than an underflow. */
export function popCursor(stack: CursorStack): CursorStack {
	return stack.length === 0 ? stack : stack.slice(0, -1);
}

/**
 * Which page a reader is on, one-based.
 *
 * Deliberately NOT "page 3 of 47": there is no `total` and there cannot be one, because a
 * `count(*)` over a table that takes a row for every mutation forever is the exact cost the cursor
 * exists to avoid. Saying which page you are on is honest; implying how many there are is not.
 */
export function cursorPageNumber(stack: CursorStack): number {
	return stack.length + 1;
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * A query string with every unset parameter omitted.
 *
 * Omitting rather than sending an empty value matters twice over. The server DEFAULTS an absent
 * window, so `from=` is a parse failure rather than "no filter"; and this parameter object is the
 * React Query cache key, so `actorType=` and an absent `actorType` have to be one cache entry
 * rather than two that fetch the same rows.
 */
export function ledgerSearchParams(query: Readonly<Record<string, unknown>>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}
		params.set(key, String(value));
	}
	return params.toString();
}
