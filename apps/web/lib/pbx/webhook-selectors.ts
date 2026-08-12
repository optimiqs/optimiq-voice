/**
 * The webhook selector grammar, mirrored — never imported.
 *
 * `apps/api/src/pbx/webhooks/webhook-selectors.ts` is the authority, and it builds its four family
 * roots from `@optimiq-voice/events`. That package is not a dependency of this app and should not
 * become one — it carries the broker's codecs — so the grammar is restated here and
 * `webhook-selectors.spec.ts` pins the restatement against the exact strings the server accepts
 * and refuses.
 *
 * ## Why mirror it at all, when the server validates on write
 *
 * Because the failure it prevents is the expensive one. A selector that parses but matches nothing
 * produces a subscription that silently receives no deliveries, and the tenant's only evidence is
 * an endpoint that never fires — indistinguishable from a broken endpoint, a broken network, or a
 * platform that is not publishing. The server refuses those at write time; mirroring the rule
 * means the refusal lands on the control instead of as a 400 after a round trip, and the builder
 * below can offer the wildcards rather than asking somebody to remember them.
 *
 * ## A selector is a filter on WHAT, never on WHOSE
 *
 * The grammar deliberately cannot express an organization token, which is why a family wildcard is
 * `calls.evt.v1.>` and not a real subject (a real one carries `<orgId>.<callId>` between the root
 * and the event). The tenant of a delivery is decided by the dispatcher from the session that owns
 * the subscription, never from anything typed into this form.
 */

import { WEBHOOK_FAMILIES, WEBHOOK_FAMILY_ROOTS, type WebhookFamily } from "./contracts";

/** The server's array bounds: at least one selector, at most this many. */
export const MAX_WEBHOOK_SELECTORS = 32;
/** The server's per-selector length cap. */
export const MAX_SELECTOR_LENGTH = 128;

/**
 * Event names are hierarchical (`channel.record.started`), so a type is one or more dot-separated
 * tokens. `*` is refused rather than treated as a synonym for `>`: a single-token wildcard would
 * match `channel` and not `channel.answered`, which is a distinction nobody wants to discover from
 * an endpoint that receives half a family.
 */
const EVENT_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;

const ROOT_TO_FAMILY: readonly (readonly [string, WebhookFamily])[] = WEBHOOK_FAMILIES.map(
	(family) => [WEBHOOK_FAMILY_ROOTS[family], family] as const,
);

/** A parsed selector: a family, and either every event in it or exactly one. */
export interface ParsedWebhookSelector {
	readonly family: WebhookFamily;
	/** `undefined` means the `>` form: every event in the family. */
	readonly type?: string;
}

/** The `>` form for a family — what the multi-select writes. */
export function familyWildcard(family: WebhookFamily): string {
	return `${WEBHOOK_FAMILY_ROOTS[family]}.>`;
}

/** Parses one selector, or returns `undefined` when it is not one the platform can serve. */
export function parseWebhookSelector(selector: string): ParsedWebhookSelector | undefined {
	const value = selector.trim();
	if (value.length === 0 || value.length > MAX_SELECTOR_LENGTH) {
		return undefined;
	}
	for (const [root, family] of ROOT_TO_FAMILY) {
		if (value === `${root}.>`) {
			return { family };
		}
		if (value.startsWith(`${root}.`)) {
			const type = value.slice(root.length + 1);
			return EVENT_PATTERN.test(type) ? { family, type } : undefined;
		}
	}
	return undefined;
}

/** Whether a selector is the family wildcard rather than an exact type. */
export function isFamilyWildcard(selector: string): boolean {
	const parsed = parseWebhookSelector(selector);
	return parsed !== undefined && parsed.type === undefined;
}

/** Every selector the server would refuse, in the order they were given. */
export function invalidWebhookSelectors(selectors: readonly string[]): readonly string[] {
	return selectors.filter((selector) => parseWebhookSelector(selector) === undefined);
}

/**
 * The message the server produces for an unknown selector, restated so the form says the same
 * sentence before the round trip that the 400 would say after it.
 */
export function invalidSelectorsMessage(invalid: readonly string[]): string {
	return (
		`unknown event selector(s): ${invalid.join(", ")}. Use a family wildcard ` +
		"(`calls.evt.v1.>`) or an exact type (`calls.evt.v1.channel.answered`)."
	);
}

/**
 * Free-text exact types, as the builder's textarea produces them.
 *
 * Split on commas and on any whitespace, because both are what somebody pasting a list will
 * produce and neither can occur INSIDE a selector — the grammar's tokens are alphanumerics,
 * hyphens, underscores and dots. Blank fragments are dropped rather than becoming a zero-length
 * selector the server refuses with a message about length.
 *
 * Duplicates are removed while KEEPING the first occurrence, so the list a user reads back is the
 * one they typed. The server does not deduplicate, and a subscription holding the same selector
 * twice spends one of its 32 slots on nothing.
 */
export function parseSelectorInput(value: string): readonly string[] {
	const seen = new Set<string>();
	const selectors: string[] = [];
	for (const fragment of value.split(/[\s,]+/u)) {
		const trimmed = fragment.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		selectors.push(trimmed);
	}
	return selectors;
}

/**
 * A stored list, split into the families it takes whole and the exact types it names.
 *
 * What the editor needs to reopen a subscription: the checkboxes come from the first half and the
 * textarea from the second. A selector the platform no longer serves — a family that was removed
 * between the row being written and this bundle being built — lands in `unknown` rather than being
 * dropped, because silently discarding it on edit would delete a subscription's filter as a side
 * effect of opening a form.
 */
export interface SelectorSplit {
	readonly families: readonly WebhookFamily[];
	readonly types: readonly string[];
	readonly unknown: readonly string[];
}

export function splitSelectors(selectors: readonly string[]): SelectorSplit {
	const families: WebhookFamily[] = [];
	const types: string[] = [];
	const unknown: string[] = [];

	for (const selector of selectors) {
		const parsed = parseWebhookSelector(selector);
		if (parsed === undefined) {
			unknown.push(selector.trim());
			continue;
		}
		if (parsed.type === undefined) {
			if (!families.includes(parsed.family)) {
				families.push(parsed.family);
			}
			continue;
		}
		const exact = selector.trim();
		if (!types.includes(exact)) {
			types.push(exact);
		}
	}

	return { families, types, unknown };
}

/**
 * The list to send, from the two controls.
 *
 * Family wildcards first and in the platform's own family order, so two subscriptions that select
 * the same thing store the same array — a stored order that follows the order the boxes were
 * ticked would make the audit diff of an unrelated edit look like a selector change.
 *
 * A wildcard SUBSUMES an exact type in the same family (`calls.evt.v1.>` already delivers
 * `calls.evt.v1.channel.answered`), and the redundant entry is dropped rather than kept: the
 * dispatcher stops at the first matching selector, so keeping it changes no delivery and only
 * spends one of the 32 slots.
 */
export function buildSelectors(
	families: readonly WebhookFamily[],
	types: readonly string[],
): readonly string[] {
	const chosen = WEBHOOK_FAMILIES.filter((family) => families.includes(family));
	const covered = new Set<WebhookFamily>(chosen);
	const exact = types.filter((type) => {
		const parsed = parseWebhookSelector(type);
		return parsed === undefined || !covered.has(parsed.family);
	});
	return [...chosen.map(familyWildcard), ...exact];
}

/** How a selector reads in a table cell: the family, and the event when it names one. */
export function selectorLabel(selector: string): string {
	const parsed = parseWebhookSelector(selector);
	if (parsed === undefined) {
		return selector;
	}
	return parsed.type === undefined ? `All ${parsed.family} events` : parsed.type;
}

/**
 * The problem with a whole selector list, or `undefined` when there is none.
 *
 * Held here rather than as a Zod refinement in `schemas.ts` because the control that produces the
 * list is not a single input — it is four checkboxes and a textarea — so the message is attached by
 * the dialog, exactly as the destination picker's is. The three rules are the server's array
 * bounds and its vocabulary, in the order a user hits them.
 */
export function selectorListIssue(selectors: readonly string[]): string | undefined {
	if (selectors.length === 0) {
		return "Choose at least one family, or name an exact event type. A subscription that selects nothing never fires.";
	}
	if (selectors.length > MAX_WEBHOOK_SELECTORS) {
		return `At most ${String(MAX_WEBHOOK_SELECTORS)} selectors. A family wildcard replaces every exact type in it.`;
	}
	const invalid = invalidWebhookSelectors(selectors);
	return invalid.length > 0 ? invalidSelectorsMessage(invalid) : undefined;
}

/** The words the family checkboxes are labelled with. */
export const WEBHOOK_FAMILY_LABELS: Readonly<Record<WebhookFamily, string>> = {
	call: "Calls",
	queue: "Queues",
	voicemail: "Voicemail",
	cdr: "Call records",
};

/** What each family carries, in one line, so the builder is not four opaque wildcards. */
export const WEBHOOK_FAMILY_DESCRIPTIONS: Readonly<Record<WebhookFamily, string>> = {
	call: "Channel lifecycle — ringing, answered, transferred, hung up.",
	queue: "Queue activity — entered, offered to an agent, answered, abandoned.",
	voicemail: "A message left, and its transcription when one is produced.",
	cdr: "One event per completed call leg, as the record is written.",
};
