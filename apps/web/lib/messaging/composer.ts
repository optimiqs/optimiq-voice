import type { SendBlock } from "./errors";

/**
 * Whether the composer may send, and if not, what it says instead.
 *
 * Pure, and separate from the component, because "why can I not send" is the single most important
 * sentence in this feature and it has five different sources. Resolving it inside JSX would make
 * the precedence between them invisible and untestable.
 *
 * ## The precedence, and why it is this way round
 *
 * A POLICY REFUSAL outranks everything, including the permission check. If the carrier has told us
 * this number is unregistered, that is true for an administrator and for an agent alike, and it is
 * the more useful thing to say — telling somebody "your role cannot send" when the number could
 * not send anyway sends them to ask for a grant that will not help.
 *
 * Below that, the permission gate, then the two facts about the form: no number selected, and
 * nothing to send.
 */

export type ComposerBlockReason =
	| "policy"
	| "forbidden"
	| "no-number"
	| "no-conversation"
	| "empty";

export interface ComposerState {
	readonly canSend: boolean;
	readonly disabled: boolean;
	readonly reason: ComposerBlockReason | undefined;
	/** The heading above the explanation. Empty when there is nothing to explain. */
	readonly title: string;
	/**
	 * The explanation, shown verbatim when it came from the server.
	 *
	 * For a `policy` block this string is the API's own `message` and is never rewritten here — the
	 * platform knows which number, which campaign and which clock, and this module does not.
	 */
	readonly message: string;
	/** True when {@link ComposerState.message} came from the API rather than from this module. */
	readonly fromServer: boolean;
}

export interface ComposerInput {
	/** A latched policy refusal from the last send attempt, if there was one. */
	readonly block: SendBlock | undefined;
	readonly canSendPermission: boolean;
	readonly hasNumber: boolean;
	readonly hasRecipient: boolean;
	readonly bodyLength: number;
	readonly attachmentCount: number;
	readonly sending: boolean;
}

export function resolveComposerState(input: ComposerInput): ComposerState {
	if (input.block) {
		return {
			canSend: false,
			disabled: true,
			reason: "policy",
			title: input.block.title,
			message: input.block.message,
			fromServer: true,
		};
	}

	if (!input.canSendPermission) {
		return {
			canSend: false,
			disabled: true,
			reason: "forbidden",
			title: "Your role cannot send messages",
			message:
				"Sending needs the messaging.send permission. You can read this conversation without it; an administrator can change your role under Settings → Members.",
			fromServer: false,
		};
	}

	if (!input.hasNumber) {
		return {
			canSend: false,
			disabled: true,
			reason: "no-number",
			title: "No messaging number selected",
			message: "Choose which of this organization's messaging numbers this reply should come from.",
			fromServer: false,
		};
	}

	if (!input.hasRecipient) {
		return {
			canSend: false,
			disabled: true,
			reason: "no-conversation",
			title: "No conversation selected",
			message: "Pick a thread on the left, and the reply goes back to that number.",
			fromServer: false,
		};
	}

	/**
	 * An empty composer disables the SEND BUTTON and not the text area — there is nothing to explain
	 * and no reason to stop somebody typing. That is why `disabled` and `canSend` come apart here
	 * and nowhere else.
	 */
	const hasContent = input.bodyLength > 0 || input.attachmentCount > 0;
	if (!hasContent || input.sending) {
		return {
			canSend: false,
			disabled: false,
			reason: hasContent ? undefined : "empty",
			title: "",
			message: "",
			fromServer: false,
		};
	}

	return {
		canSend: true,
		disabled: false,
		reason: undefined,
		title: "",
		message: "",
		fromServer: false,
	};
}
