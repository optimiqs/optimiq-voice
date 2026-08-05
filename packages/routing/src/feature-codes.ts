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
} as const;

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
