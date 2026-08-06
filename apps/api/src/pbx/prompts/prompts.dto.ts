import { z } from "zod/v4";
import { PROMPT_KINDS } from "@optimiq-voice/pbx-db";
import { displayName } from "../shared/dto";
import { listQuerySchema } from "../shared/pagination";

/**
 * The prompt library's request shapes.
 *
 * ## There is no create DTO, and that is the point
 *
 * `prompt.object_key` is `notNull`, so a prompt row cannot exist without audio — a deliberate
 * schema decision, and the right one: a library entry with no file is an entry an IVR can be
 * pointed at and that plays nothing. So a prompt is CREATED by the upload and by nothing else, and
 * the fields that would have been a create body arrive as multipart FIELDS beside the file. They
 * are validated by {@link uploadPromptFieldsDto} after the multipart reader has extracted them.
 *
 * What remains a JSON body is the PATCH, which edits the row's metadata and never its audio.
 * Replacing the audio is a second upload — a new row — rather than a mutation, because the object
 * key is what a compiled artifact and a running call may already be holding, and rewriting the
 * bytes under a key that something is playing is a race with a caller on the other end of it.
 */

/**
 * The non-file parts of an upload form.
 *
 * Everything is optional but `name`, and `name` defaults to the uploaded file's name in the service
 * rather than here — this schema does not know it. `z.strictObject` is deliberately NOT used: a
 * browser's `FormData` is free to carry parts this endpoint does not read, and refusing an upload
 * because a form serialised a stray field would be a hostile reading of a transport format.
 */
export const uploadPromptFieldsDto = z.object({
	name: displayName.optional(),
	kind: z.enum(PROMPT_KINDS).optional(),
	/** BCP 47. Stored for the day a tenant has one prompt per language. */
	language: z
		.string()
		.trim()
		.max(35)
		.regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u, "must be a language tag, e.g. en-US")
		.optional(),
	mohClassId: z.uuid().optional(),
});

/**
 * The metadata patch.
 *
 * `objectKey`, `contentType`, `sizeBytes` and `checksum` are absent and always will be: they are
 * facts ABOUT the stored object, written by the upload path from the bytes it actually stored.
 * Accepting them from a client would let an admin re-point a library entry at another tenant's
 * object by editing a string — the object key is the only thing standing between a row and a file,
 * and RLS does not protect the filesystem.
 *
 * `kind` and `mohClassId` are absent too, for a smaller reason: moving a file between the library
 * and an MOH class would move the OBJECT, and a metadata patch that silently did not is a patch
 * that lies. Re-upload instead.
 */
export const updatePromptDto = z.strictObject({
	name: displayName.optional(),
	language: z
		.string()
		.trim()
		.max(35)
		.regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u, "must be a language tag, e.g. en-US")
		.optional(),
});

/**
 * `GET /prompts` — the library list.
 *
 * `kind` narrows to one use. The default is deliberately NOT "everything": a library screen that
 * showed every MOH file of every class mixed in with the IVR prompts would be unusable in a tenant
 * with any hold music at all, so an absent `kind` means the two kinds a prompt PICKER can offer —
 * `prompt` and `greeting` — and MOH files are reached through their class.
 */
export const promptListQuerySchema = listQuerySchema.extend({
	kind: z.enum(PROMPT_KINDS).optional(),
	mohClassId: z.uuid().optional(),
});

export type PromptListQuery = z.infer<typeof promptListQuerySchema>;
export type UploadPromptFields = z.infer<typeof uploadPromptFieldsDto>;
export type UpdatePrompt = z.infer<typeof updatePromptDto>;
