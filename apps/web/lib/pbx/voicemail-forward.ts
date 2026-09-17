import type { VoicemailForwardMode } from "./contracts";

/**
 * The two decisions the forward dialog makes, kept out of the component that renders them.
 *
 * Both are pure and both are the kind of thing that is wrong in a way a screenshot does not show:
 * whether a chosen mailbox is a legal destination, and which of two nearly identical sentences the
 * dialog is showing. Neither needs a query, a session or a DOM, so neither is tested through one.
 */

/**
 * Why the chosen destination cannot be used, or `undefined` when it can.
 *
 * The empty case and the same-box case are separate sentences on purpose. "Choose a mailbox" is an
 * instruction; "that is the mailbox it is already in" is an explanation, and a dialog that answered
 * the second with the first would leave the user re-picking the same row.
 *
 * The SERVER makes both refusals too — a same-box forward is a 400 and a foreign box is a 404 — so
 * this is the immediate answer, never the enforcement. Tenancy is deliberately not checked here:
 * the picker only ever lists the caller's own organization, and a browser-side tenant check would
 * be a rule written twice and trusted in the wrong place.
 */
export function forwardTargetError(sourceBoxId: string, targetBoxId: string): string | undefined {
	if (targetBoxId.length === 0) {
		return "Choose a mailbox to send this message to.";
	}
	if (targetBoxId === sourceBoxId) {
		return "That is the mailbox this message is already in.";
	}
	return undefined;
}

/** Every string that differs between the two modes, in one place so they cannot drift apart. */
export interface VoicemailForwardCopy {
	readonly title: string;
	readonly description: string;
	readonly confirm: string;
}

/**
 * What the dialog says, per mode.
 *
 * The descriptions state the one thing the two modes disagree about — whether the message stays —
 * because that is the whole difference and it is not recoverable by pressing undo.
 */
export function forwardModeCopy(mode: VoicemailForwardMode): VoicemailForwardCopy {
	if (mode === "copy") {
		return {
			title: "Copy to another mailbox",
			description:
				"The message is copied into the mailbox you choose, and stays in this one. The recipient sees it as unread.",
			confirm: "Copy message",
		};
	}
	return {
		title: "Forward to another mailbox",
		description:
			"The message moves to the mailbox you choose and is removed from this one. The recipient sees it as unread.",
		confirm: "Forward message",
	};
}
