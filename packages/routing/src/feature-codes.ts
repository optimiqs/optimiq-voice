/**
 * Star codes.
 *
 * The action list is closed (`pbx-db` `FEATURE_CODE_ACTIONS`), so what the compiler adds is the
 * one thing the table cannot express: **whether the dialed digits after the code are an argument**.
 *
 * `*97` is dialed alone. `**200` is dialed with an extension glued onto it — directed pickup needs
 * to know whose phone to grab. Without that distinction the internal match table would be a plain
 * string map and half the catalogue would be undialable. With it, a feature code becomes either an
 * exact match or a prefix match that carries a captured argument, which is exactly the shape the
 * engine's feature runtimes want.
 *
 * The default catalogue below mirrors the vanilla map in
 * `plans/reference/freeswitch-capabilities.md` §10 and is what the API seeds a new organization
 * with. It is data, not policy: a tenant may renumber every entry, and the compiler cares only
 * about the codes actually present in the snapshot.
 */

import type { FeatureCodeAction, FeatureCodeParams } from "./snapshot";

/**
 * How a feature code consumes the digits dialed after it.
 *
 * - `none` — the code is dialed alone; anything after it is a different code.
 * - `optional` — dialed alone toggles, dialed with digits sets (e.g. call-forward-all).
 * - `required` — the code is meaningless without a target (e.g. directed pickup).
 */
export const FEATURE_CODE_ARGUMENT_MODES = ["none", "optional", "required"] as const;

export type FeatureCodeArgumentMode = (typeof FEATURE_CODE_ARGUMENT_MODES)[number];

/**
 * Argument mode per action. This is the compiler's interpretation layer over the raw catalogue,
 * and it is exhaustive by construction: adding an action to `pbx-db` without deciding its argument
 * mode is a TypeScript error here.
 */
export const FEATURE_CODE_ARGUMENT_MODE: Readonly<
	Record<FeatureCodeAction, FeatureCodeArgumentMode>
> = {
	// Logs the caller into their own mailbox; the mailbox comes from the calling extension.
	"voicemail-check": "none",
	// Leaves a message directly: the mailbox is the argument, so it cannot be omitted.
	"voicemail-direct": "required",
	"voicemail-record-greeting": "none",
	// Park with no orbit auto-assigns a slot; park with an orbit takes the explicit one.
	"call-park": "optional",
	// Directed pickup: whose ringing phone are we grabbing?
	"call-pickup": "required",
	// Group pickup takes the caller's own pickup group.
	"group-pickup": "none",
	// Dialed alone: toggle off. Dialed with a number: forward there.
	"call-forward-all": "optional",
	"call-forward-busy": "optional",
	"call-forward-no-answer": "optional",
	"do-not-disturb": "none",
	"follow-me": "none",
	// Intercom and paging both need a target endpoint or page group.
	intercom: "required",
	paging: "required",
	"record-toggle": "none",
	redial: "none",
	"echo-test": "none",
	"queue-toggle": "optional",
	"agent-status": "optional",
	// Eavesdrop needs the extension (or channel) being monitored.
	eavesdrop: "required",
	// In-call blind transfer: the destination follows the code.
	transfer: "required",
	/**
	 * Hot desking. Login takes the extension being claimed, because the whole point is that the
	 * handset is NOT that extension's — the caller is standing at somebody else's desk, and the
	 * calling number tells the switch nothing about who they are. Logout takes nothing: the session
	 * to end is whichever one this handset is holding, and letting a second argument name a
	 * different one would let anybody log anybody else out from any phone in the building.
	 */
	"hotdesk-login": "required",
	"hotdesk-logout": "none",
	/**
	 * Per-call CLIR is a PREFIX, not a toggle: `*67<destination>` decides how this one call is
	 * presented and then dials it. Dialled bare there is no call to apply it to — the standing
	 * setting is `extension.outboundCallerIdPresentation`, which is edited on a form and not from a
	 * handset — so `required` is the mode, and `matchFeatureCode` skips a bare `*67` rather than
	 * running a code that would do nothing.
	 */
	"caller-id-presentation-restrict": "required",
	"caller-id-presentation-allow": "required",
	// Both are dialled bare and act on the ONE entity the compiler pinned into the node. A trailing
	// argument would have to name a second flow or condition, which is what a second code is for.
	"call-flow-toggle": "none",
	"time-condition-override": "none",
} as const;

/**
 * The `params` key that SUPPLIES an action's argument, for the actions that have one.
 *
 * `FEATURE_CODE_ARGUMENT_MODE` above answers "does this action need something after the code",
 * which is a question about the ACTION. It is the wrong question for a row that has already been
 * told the answer: `*81` with `params.groupId` pinned to the warehouse page group is a code that
 * pages the warehouse, and reading its mode off the action table makes it `required` — so
 * {@link matchFeatureCode} skips it when it is dialled alone and the tenant's `*81` reaches
 * nothing at all. That is the defect `E2E-routing2.md` recorded.
 *
 * Only an action whose argument the pin REPLACES belongs here. `call-park` is deliberately absent:
 * `params.lotId` pins the lot and the argument selects an orbit WITHIN it, so both are meaningful at
 * once. `intercom` is absent because it cannot be pinned at all (see `featureCodeTarget`).
 */
const FEATURE_CODE_PINNED_ARGUMENT: Partial<Record<FeatureCodeAction, string>> = {
	paging: "groupId",
};

/**
 * How a code is matched, given both its action and what its row already pins.
 *
 * The static table is the default and the pin narrows it, never the other way round: a code with no
 * params behaves exactly as it did before this function existed.
 */
export function featureCodeArgumentMode(
	action: FeatureCodeAction,
	params: FeatureCodeParams | undefined,
): FeatureCodeArgumentMode {
	const pinned = FEATURE_CODE_PINNED_ARGUMENT[action];
	if (pinned !== undefined) {
		const value = params?.[pinned];
		if (typeof value === "string" && value.length > 0) {
			return "none";
		}
	}
	return FEATURE_CODE_ARGUMENT_MODE[action];
}

/** A seed entry: the code, what it does, and what it is called in the admin UI. */
export interface FeatureCodeSeed {
	readonly code: string;
	readonly action: FeatureCodeAction;
	readonly label: string;
	readonly params?: FeatureCodeParams;
}

/**
 * The default star-code catalogue for a new organization.
 *
 * Numbering follows the vanilla FreeSWITCH map (frozen reference §10) wherever it exists, because
 * every installer, every cheat sheet and every phone-side speed dial in the industry assumes it.
 * Where vanilla offers several spellings (`*98` and `4000` both reach voicemail) only the star form
 * is seeded: bare numeric codes collide with a tenant's extension range, and a tenant who wants
 * `4000` can add it.
 */
export const DEFAULT_FEATURE_CODES: readonly FeatureCodeSeed[] = [
	{ code: "*97", action: "voicemail-check", label: "Check my voicemail" },
	{ code: "*98", action: "voicemail-direct", label: "Leave a message in a mailbox" },
	{ code: "*99", action: "voicemail-record-greeting", label: "Record my greeting" },
	{ code: "*8", action: "group-pickup", label: "Pick up a ringing call in my group" },
	{ code: "**", action: "call-pickup", label: "Pick up a specific extension" },
	{ code: "*69", action: "redial", label: "Return the last call" },
	{ code: "*72", action: "call-forward-all", label: "Forward all calls" },
	{ code: "*74", action: "call-forward-busy", label: "Forward when busy" },
	{ code: "*76", action: "call-forward-no-answer", label: "Forward on no answer" },
	{ code: "*78", action: "do-not-disturb", label: "Do not disturb" },
	{ code: "*21", action: "follow-me", label: "Follow me" },
	{ code: "*5", action: "call-park", label: "Park this call" },
	{ code: "*80", action: "intercom", label: "Intercom an extension" },
	{ code: "*81", action: "paging", label: "Page a group" },
	{ code: "*3", action: "record-toggle", label: "Start or stop recording" },
	{ code: "*0", action: "eavesdrop", label: "Monitor a call" },
	{ code: "*1", action: "transfer", label: "Blind transfer" },
	{ code: "*22", action: "queue-toggle", label: "Log in or out of a queue" },
	{ code: "*23", action: "agent-status", label: "Set my agent status" },
	{ code: "*43", action: "echo-test", label: "Echo test" },
	/**
	 * Hot desking. Vanilla has no numbering for it, so the pair is chosen to survive
	 * {@link featureCodeIssues}: `*31` takes an argument, and the only seeded code that is a prefix
	 * of it is `*3` (record-toggle), which takes none — so exact matching separates them and
	 * longest-code-first sends `*311104` to the login rather than the recorder.
	 */
	{ code: "*31", action: "hotdesk-login", label: "Log in to this phone" },
	{ code: "*32", action: "hotdesk-logout", label: "Log out of this phone" },
	/**
	 * The vanilla NANP pair, and the numbering everybody already knows: `*67` withholds, `*82`
	 * presents. Both survive {@link featureCodeIssues} against the rest of this catalogue — nothing
	 * seeded starts with either string — and against `*8` (group pickup), which takes no argument
	 * and is therefore matched exactly, so longest-code-first sends `*8215551234` to `*82`.
	 */
	{
		code: "*67",
		action: "caller-id-presentation-restrict",
		label: "Withhold my number on this call",
	},
	{ code: "*82", action: "caller-id-presentation-allow", label: "Present my number on this call" },
] as const;

/** Codes must be dialable and must not collide with an extension range by accident. */
const FEATURE_CODE_PATTERN = /^[*#][0-9*#]{0,9}$/;

export type FeatureCodeIssue =
	| { readonly code: "malformed-code"; readonly value: string }
	| { readonly code: "duplicate-code"; readonly value: string }
	| { readonly code: "prefix-collision"; readonly value: string; readonly other: string };

/** Whether a stored code is dialable at all. */
export function isWellFormedFeatureCode(code: string): boolean {
	return FEATURE_CODE_PATTERN.test(code);
}

/**
 * Longest-code-wins is what makes `**200` and `*8` coexist, but it only works if no
 * argument-taking code is a prefix of another code. `*8` (group pickup, no argument) and `*80`
 * (intercom, argument) are fine — exact matching disambiguates. `**` (argument) and `**2`
 * (anything) are not: `**200` would be ambiguous.
 *
 * Returns every collision found, in a stable order.
 */
export function featureCodeIssues(
	codes: readonly { readonly code: string; readonly action: FeatureCodeAction }[],
): readonly FeatureCodeIssue[] {
	const issues: FeatureCodeIssue[] = [];
	const seen = new Set<string>();
	const sorted = [...codes].sort((left, right) => left.code.localeCompare(right.code));

	for (const entry of sorted) {
		if (!isWellFormedFeatureCode(entry.code)) {
			issues.push({ code: "malformed-code", value: entry.code });
			continue;
		}
		if (seen.has(entry.code)) {
			issues.push({ code: "duplicate-code", value: entry.code });
			continue;
		}
		seen.add(entry.code);
	}

	for (const entry of sorted) {
		if (FEATURE_CODE_ARGUMENT_MODE[entry.action] === "none") {
			continue;
		}
		for (const other of sorted) {
			if (other.code === entry.code) {
				continue;
			}
			if (other.code.startsWith(entry.code)) {
				issues.push({ code: "prefix-collision", value: entry.code, other: other.code });
			}
		}
	}

	return issues;
}

/** How a compiled feature code is matched against dialed digits. */
export interface CompiledFeatureCode {
	readonly id: string;
	readonly code: string;
	readonly action: FeatureCodeAction;
	readonly argumentMode: FeatureCodeArgumentMode;
	readonly params?: FeatureCodeParams;
	readonly label?: string;
	/** The plan node the engine executes for this code. */
	readonly nodeId: string;
}

export interface FeatureCodeMatch {
	readonly featureCode: CompiledFeatureCode;
	/** Digits dialed after the code. Empty when the code was dialed alone. */
	readonly argument: string;
}

/**
 * The feature code that would swallow `value`, if any.
 *
 * Exactly `matchFeatureCode`'s consumption rule, minus the argument: a code with no argument matches
 * only the whole string, so `*9` does NOT consume `*99`. Written once because it is asked in three
 * places — speed dials, toggle codes and voicemail prefixes — and a copy that drifts from the
 * matcher produces a warning about a collision that cannot happen, which teaches tenants to ignore
 * warnings.
 */
export function featureCodeWouldConsume(
	table: readonly CompiledFeatureCode[],
	value: string,
): CompiledFeatureCode | undefined {
	return table.find(
		(entry) =>
			entry.code === value || (entry.argumentMode !== "none" && value.startsWith(entry.code)),
	);
}

/**
 * Matches dialed digits against a code table, longest code first.
 *
 * The table must already be sorted by descending code length — `compile.ts` guarantees that — so
 * this is a linear walk that stops at the first winner rather than a scoring pass.
 */
export function matchFeatureCode(
	table: readonly CompiledFeatureCode[],
	dialed: string,
): FeatureCodeMatch | null {
	for (const entry of table) {
		if (dialed === entry.code) {
			if (entry.argumentMode === "required") {
				continue;
			}
			return { featureCode: entry, argument: "" };
		}
		if (entry.argumentMode !== "none" && dialed.startsWith(entry.code)) {
			return { featureCode: entry, argument: dialed.slice(entry.code.length) };
		}
	}
	return null;
}
