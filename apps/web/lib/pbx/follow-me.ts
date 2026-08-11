import {
	followMeFormSchema,
	type FollowMeFormValues,
	type FollowMeParsedValues,
	type FollowMeTargetFormValues,
} from "./schemas";
import type { ExtensionRow, FollowMeTarget } from "./contracts";

/**
 * Reading and writing `extension.follow_me` — the one column on an extension that is a whole
 * object rather than a scalar.
 *
 * This is to follow-me what `destinations.ts` is to the destination trio: the row shape and the
 * form shape are different, so the conversion lives in one tested place instead of inside a
 * dialog. The form holds seconds as STRINGS, because every numeric control in this app does; the
 * column holds them as integers, because the engine reads them.
 *
 * ## The column is replaced whole, so the dialog must not write it unless it changed
 *
 * `PATCH /extensions/:id` with a `followMe` key REPLACES the stored object. There is no merge, and
 * there cannot be one — an absent target in an array is a deleted target, which is the only sane
 * reading of an ordered ladder. That makes an unconditional write dangerous in a way the flat
 * columns are not: an operator who opens the dialog to fix a caller ID would rewrite the ladder
 * from whatever this form happened to render, and any key the form does not render would be gone.
 *
 * {@link normalizeFollowMe} and {@link writeFollowMe} therefore produce the SAME shape from the two
 * sides, and {@link sameFollowMe} compares them. The dialog omits the key when they agree — the
 * diff-only rule the routing settings screen established, applied to the one field on this form
 * that needs it.
 *
 * ## Nothing configured is `null`, not an empty ladder
 *
 * A disabled ladder with no targets is spelled `null` on both sides. Storing
 * `{ enabled: false, targets: [] }` would be a second spelling of "no follow-me" that reads as a
 * change every time a dialog opens on a row that has never used the feature.
 */

/** The wire shape: what a `followMe` key on a create or update body carries. */
export interface FollowMePayload {
	readonly enabled: boolean;
	readonly ignoreBusy: boolean;
	readonly targets: readonly FollowMeTarget[];
}

/**
 * A fresh row, pre-filled rather than empty.
 *
 * `delaySeconds` and `timeoutSeconds` are required by the server, so a blank row would be a form
 * that fails on submit for a reason the user did not cause. Zero delay and thirty seconds is the
 * ladder rung everybody writes first: ring this one immediately, for as long as a desk phone rings.
 *
 * `confirm` starts OFF because absent is off on the wire. The row's own copy is where the case for
 * turning it on lives — it is the answer to a mobile's voicemail answering the call.
 */
export const EMPTY_FOLLOW_ME_TARGET: FollowMeTargetFormValues = {
	destination: "",
	delaySeconds: "0",
	timeoutSeconds: "30",
	confirm: false,
};

/** What the editor opens on for an extension that has never used follow-me. */
export const EMPTY_FOLLOW_ME: FollowMeFormValues = {
	enabled: false,
	ignoreBusy: false,
	targets: [],
};

/** The stored object, in the one spelling {@link sameFollowMe} can compare. */
export function normalizeFollowMe(
	stored: ExtensionRow["followMe"] | undefined,
): FollowMePayload | null {
	if (stored === null || stored === undefined) {
		return null;
	}
	const targets = stored.targets.map((target) => ({
		destination: target.destination,
		delaySeconds: target.delaySeconds,
		timeoutSeconds: target.timeoutSeconds,
		confirm: target.confirm ?? false,
	}));
	if (!stored.enabled && targets.length === 0) {
		return null;
	}
	return { enabled: stored.enabled, ignoreBusy: stored.ignoreBusy ?? false, targets };
}

/** The stored object as the editor's controls hold it. */
export function readFollowMe(extension: ExtensionRow | null): FollowMeFormValues {
	const stored = normalizeFollowMe(extension?.followMe);
	if (stored === null) {
		return EMPTY_FOLLOW_ME;
	}
	return {
		enabled: stored.enabled,
		ignoreBusy: stored.ignoreBusy,
		targets: stored.targets.map((target) => ({
			destination: target.destination,
			delaySeconds: String(target.delaySeconds),
			timeoutSeconds: String(target.timeoutSeconds),
			confirm: target.confirm ?? false,
		})),
	};
}

/**
 * The editor's controls as the wire carries them.
 *
 * `null` when there is nothing to store, which clears the column. A ladder that is switched off but
 * still holds targets is kept — the same rule `confirmPromptId` follows on a ring group: turning a
 * feature off is not a request to delete the configuration behind it.
 */
export function writeFollowMe(parsed: FollowMeParsedValues): FollowMePayload | null {
	if (!parsed.enabled && parsed.targets.length === 0) {
		return null;
	}
	return {
		enabled: parsed.enabled,
		ignoreBusy: parsed.ignoreBusy,
		targets: parsed.targets.map((target) => ({
			destination: target.destination,
			delaySeconds: target.delaySeconds,
			timeoutSeconds: target.timeoutSeconds,
			confirm: target.confirm,
		})),
	};
}

/** Whether two ladders are the same one. Order is meaning here, so it is compared positionally. */
export function sameFollowMe(
	before: FollowMePayload | null,
	after: FollowMePayload | null,
): boolean {
	if (before === null || after === null) {
		return before === after;
	}
	if (
		before.enabled !== after.enabled ||
		before.ignoreBusy !== after.ignoreBusy ||
		before.targets.length !== after.targets.length
	) {
		return false;
	}
	return before.targets.every((target, index) => {
		const other = after.targets[index];
		return (
			other !== undefined &&
			target.destination === other.destination &&
			target.delaySeconds === other.delaySeconds &&
			target.timeoutSeconds === other.timeoutSeconds &&
			(target.confirm ?? false) === (other.confirm ?? false)
		);
	});
}

/**
 * Per-control messages for the editor, keyed `targets.<index>.<field>`.
 *
 * The key is the row and the box, not the whole section: a ladder of six with one bad number needs
 * the message on that number. The server cannot help here — `pbxFieldErrors` collapses
 * `followMe.targets.0.destination` to `followMe`, because the flat forms it serves have no nested
 * controls — so a client check is the only thing that can put a message on the right box.
 */
export function followMeFieldErrors(values: FollowMeFormValues): Readonly<Record<string, string>> {
	const parsed = followMeFormSchema.safeParse(values);
	if (parsed.success) {
		return {};
	}
	const errors: Record<string, string> = {};
	for (const issue of parsed.error.issues) {
		const key = issue.path.join(".");
		errors[key] ??= issue.message;
	}
	return errors;
}

/** Moves a rung of the ladder. Out-of-range moves are no-ops rather than silent reorders. */
export function moveFollowMeTarget(
	targets: readonly FollowMeTargetFormValues[],
	index: number,
	delta: number,
): readonly FollowMeTargetFormValues[] {
	const next = [...targets];
	const target = index + delta;
	const current = next[index];
	const swap = next[target];
	if (current === undefined || swap === undefined) {
		return targets;
	}
	next[index] = swap;
	next[target] = current;
	return next;
}

/**
 * What the extensions list says about a row, or `undefined` when there is nothing to say.
 *
 * Only an ACTIVE ladder earns a badge. A stored-but-disabled one changes nothing about where a call
 * goes, and a list that flagged it would be telling an operator their calls are being chased when
 * they are not.
 */
export function followMeSummary(stored: ExtensionRow["followMe"] | undefined): string | undefined {
	const normalized = normalizeFollowMe(stored);
	if (normalized === null || !normalized.enabled) {
		return undefined;
	}
	const count = normalized.targets.length;
	return count === 0 ? "Follow me: no targets" : `Follow me: ${count}`;
}
