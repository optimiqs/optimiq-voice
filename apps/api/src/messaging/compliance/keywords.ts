/**
 * STOP / HELP / START, as a pure function.
 *
 * # Why this is the platform's job and not the carrier's
 *
 * Telnyx will honour STOP at the carrier edge if you let it, and several providers advertise that as
 * a feature. This platform classifies the keyword itself, for three reasons that all point the same
 * way:
 *
 * 1. **The suppression list has to be readable and defensible.** "Did you stop texting this person,
 *    and when did you know?" is answered from a row in `messaging_opt_out` with a timestamp and the
 *    exact word the consumer sent. A block that lives only inside the carrier is a fact this
 *    platform cannot show a regulator, a customer, or the agent who is about to type a reply.
 * 2. **The HELP reply is the tenant's text.** Carrier-side auto-reply sends a generic sentence; CTIA
 *    expects the program to be identifiable and to name a way to reach a human, which is the
 *    campaign's `helpMessage`. Only we hold that.
 * 3. **The block must survive the carrier being unreachable.** A send path that asks the carrier
 *    whether it may send is a send path that fails open the day the carrier is slow.
 *
 * # Why the matching is this loose, and where it stops
 *
 * The FCC's April 2025 order requires a sender to treat *any reasonable* expression of opt-out as
 * one — not just an exact keyword — so matching only `STOP` would under-honour. But this classifier
 * deliberately does not attempt natural language: a free-text "please stop sending me these" is a
 * judgement, and a heuristic that guessed at it would also silence "stop by the shop at 5" and would
 * do so invisibly. So the rule is:
 *
 * - The whole message, trimmed, case-folded, and with surrounding punctuation removed, must BE one
 *   of the recognised words (or, for the multi-word opt-outs the FCC named, one of the recognised
 *   phrases). One word, one intent, no ambiguity.
 * - Anything longer is delivered to the inbox as an ordinary message, where a human reads it. That
 *   is not a gap: the manual opt-out path exists precisely so an agent can record the intent behind
 *   "please take me off this list", and the FCC's ten-business-day window for non-keyword channels
 *   is the window that applies to it.
 *
 * The consequence worth stating: a consumer who texts "STOP." or "stop" or " Stop " is opted out
 * immediately and automatically; a consumer who writes a sentence is opted out by a person, and the
 * ledger records which of the two happened.
 */

/** What an inbound message turned out to be. `undefined` from the classifier means "conversation". */
export type ComplianceIntent = "opt-out" | "opt-in" | "help";

/**
 * The default vocabularies.
 *
 * These are the CTIA/carrier-recognised sets, and they are DEFAULTS rather than the whole story: a
 * campaign declares its own keywords at registration, and what a campaign told TCR it would honour
 * is what it must honour. {@link classifyKeyword} takes the campaign's lists and falls back to these
 * when a number has no campaign — an unregistered number still has to obey STOP, because the
 * obligation is to the consumer and not to the registry.
 */
export const DEFAULT_OPT_OUT_KEYWORDS = [
	"STOP",
	"STOPALL",
	"UNSUBSCRIBE",
	"CANCEL",
	"END",
	"QUIT",
	"REVOKE",
	"OPTOUT",
	"OPT OUT",
	"OPT-OUT",
] as const;

export const DEFAULT_OPT_IN_KEYWORDS = [
	"START",
	"UNSTOP",
	"YES",
	"SUBSCRIBE",
	"OPTIN",
	"OPT IN",
] as const;

export const DEFAULT_HELP_KEYWORDS = ["HELP", "INFO"] as const;

/** The keyword lists a campaign declared, each as the comma-separated string TCR stores. */
export interface CampaignKeywords {
	readonly optOutKeywords?: string | null;
	readonly optInKeywords?: string | null;
	readonly helpKeywords?: string | null;
}

export interface KeywordMatch {
	readonly intent: ComplianceIntent;
	/** The normalised word that matched, stored on the message row as evidence. */
	readonly keyword: string;
}

/**
 * Normalises a body for comparison: trim, collapse internal whitespace, strip surrounding
 * punctuation, upper-case.
 *
 * Surrounding punctuation only — never internal. `STOP.` and `"STOP"` are a consumer whose keyboard
 * added a character; `STOP-GAP` is a word. Stripping internally would collapse the second into the
 * first.
 */
export function normalizeKeywordBody(body: string): string {
	return body
		.trim()
		.replace(/\s+/gu, " ")
		.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "")
		.trim()
		.toUpperCase();
}

/** Splits a TCR-style comma-separated keyword string into normalised entries. */
export function parseKeywordList(value: string | null | undefined): readonly string[] {
	if (value === null || value === undefined) {
		return [];
	}
	return value
		.split(",")
		.map((entry) => normalizeKeywordBody(entry))
		.filter((entry) => entry.length > 0);
}

/**
 * Classifies one inbound body, or returns `undefined` when it is ordinary conversation.
 *
 * Opt-out is checked FIRST and that ordering is not incidental. If a tenant misconfigures a campaign
 * so a word appears in two lists, the safe reading is the one that stops messages: honouring a STOP
 * that was also listed as an opt-in costs the tenant one conversation, while the reverse costs the
 * consumer their opt-out and the tenant a complaint.
 */
export function classifyKeyword(
	body: string | null | undefined,
	campaign?: CampaignKeywords,
): KeywordMatch | undefined {
	if (body === null || body === undefined) {
		return undefined;
	}
	const normalized = normalizeKeywordBody(body);
	if (normalized.length === 0 || normalized.length > 32) {
		// Longer than any keyword anyone registers. See the header: a sentence is a message for a
		// human, not a command for a state machine.
		return undefined;
	}

	const optOut = withDefaults(campaign?.optOutKeywords, DEFAULT_OPT_OUT_KEYWORDS);
	if (optOut.includes(normalized)) {
		return { intent: "opt-out", keyword: normalized };
	}
	const optIn = withDefaults(campaign?.optInKeywords, DEFAULT_OPT_IN_KEYWORDS);
	if (optIn.includes(normalized)) {
		return { intent: "opt-in", keyword: normalized };
	}
	const help = withDefaults(campaign?.helpKeywords, DEFAULT_HELP_KEYWORDS);
	if (help.includes(normalized)) {
		return { intent: "help", keyword: normalized };
	}
	return undefined;
}

/**
 * A campaign's declared list UNION the defaults, never instead of them.
 *
 * A campaign that forgot to list `STOP` still has to honour it — the carriers enforce the universal
 * keywords regardless of what a campaign registered, and so does the TCPA. So the campaign's list
 * can only ADD words, which is the direction that cannot produce a message this platform sends to
 * somebody who asked it to stop.
 */
function withDefaults(
	declared: string | null | undefined,
	defaults: readonly string[],
): readonly string[] {
	const parsed = parseKeywordList(declared);
	return parsed.length === 0 ? defaults : [...new Set([...defaults, ...parsed])];
}
