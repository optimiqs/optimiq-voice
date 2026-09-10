import { z } from "zod/v4";
import { VOICEMAIL_FOLDERS } from "@optimiq-voice/pbx-db";
import { DEFAULT_LIMIT, DEFAULT_PAGE, MAX_LIMIT } from "../shared/pagination";

/**
 * Reading and moving the messages in a mailbox.
 *
 * ## There is no `read` column, and there should not be
 *
 * `voicemail_message` has a `folder` (`new` / `saved` / `deleted`) and nothing else that could mean
 * "read". That is the vocabulary every voicemail system since the answering machine has used, and
 * it is the vocabulary the MWI lamp is defined in: the lamp is lit by the NEW count, so "mark as
 * read" and "move out of new" are not two facts that could disagree — they are one fact.
 *
 * The API therefore exposes the folder, and derives `read` from it for the UI's benefit rather
 * than storing a second flag that a folder move would have to remember to keep in step. Marking a
 * message unread moves it back to `new`, which is what relights the lamp, which is what the user
 * meant.
 *
 * ## Delete is a folder, and then it is a row
 *
 * `DELETE …/messages/:id` moves the message to the `deleted` folder. That is the schema's own
 * tombstone — the folder exists precisely so a caller who pressed 7 by mistake has somewhere to
 * find their message — and it is what the engine's `*97` menu will mean by delete.
 *
 * `?purge=true` removes the row instead. Two operations rather than one because "gone from my
 * inbox" and "gone from the database" are different decisions with different consequences, and a
 * UI that offered only the second would make an accidental tap unrecoverable. The audio object is
 * NOT unlinked either way: the retention policy owns the object store's lifecycle, and a control
 * plane that deleted files behind retention's back would produce rows whose media vanished for a
 * reason nothing recorded.
 */

/** `read` means "not in the new folder". Derived, never stored — see the note above. */
export function isMessageRead(folder: string): boolean {
	return folder !== "new";
}

export const voicemailMessageListQuerySchema = z.object({
	/** Absent means every folder except `deleted`, which is what an inbox view wants. */
	folder: z.enum(VOICEMAIL_FOLDERS).optional(),
	page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
	limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export type VoicemailMessageListQuery = z.infer<typeof voicemailMessageListQuerySchema>;

/**
 * `PATCH …/messages/:id`.
 *
 * Either the folder directly, or `read` as the shorthand the UI actually has a control for. Both,
 * rather than only the folder, because "mark as read" is one click and translating it into "move
 * to saved" in the browser would put a rule about mailbox semantics in the presentation layer.
 * Exactly one of the two must be present: a body carrying both could contradict itself.
 */
export const updateVoicemailMessageDto = z
	.strictObject({
		folder: z.enum(VOICEMAIL_FOLDERS).optional(),
		read: z.boolean().optional(),
	})
	.refine(
		(value) => (value.folder === undefined) !== (value.read === undefined),
		"send exactly one of `folder` or `read`",
	);

export type UpdateVoicemailMessage = z.infer<typeof updateVoicemailMessageDto>;

/** `DELETE …/messages/:id?purge=true`. */
export const deleteVoicemailMessageQuerySchema = z.object({
	purge: z
		.stringbool({ truthy: ["true", "1"], falsy: ["false", "0", ""] })
		.optional()
		.default(false),
});

/**
 * `POST …/messages/:id/forward`.
 *
 * One route and one `mode` rather than two verbs, because forward and copy are the SAME operation
 * with one extra step: both write the audio and the row into another mailbox, and only forward then
 * removes the original. Two endpoints would be two code paths that had to be kept in step about
 * tenancy, MWI and the object copy, which is exactly the part worth having once.
 *
 * A recorded introduction — the "record your comment, then send" prompt of a desk phone — is NOT
 * part of this. It needs a recording leg on the call path, which is the engine's to own; nothing
 * here fabricates one.
 */
export const forwardVoicemailMessageDto = z.strictObject({
	/** The mailbox the copy lands in. Must be in the caller's organization, or this is a 404. */
	targetVoicemailBoxId: z.uuid(),
	/** `forward` removes the original once the copy is filed; `copy` leaves it where it is. */
	mode: z.enum(["forward", "copy"]).default("forward"),
});

export type ForwardVoicemailMessage = z.infer<typeof forwardVoicemailMessageDto>;
