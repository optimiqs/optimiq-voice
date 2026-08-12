import { z } from "zod/v4";
import { displayName, patchOf } from "../shared/dto";

/**
 * The phrase surface's request shapes.
 *
 * ## There IS a create DTO here, and that is the difference from the library
 *
 * `prompts.dto.ts` has no create body because `prompt.object_key` used to be `notNull`: a library
 * entry cannot exist without audio, so a prompt is created by an upload and by nothing else. A
 * phrase is the exception the column was made nullable for — it owns no file, it names other rows' —
 * so it is created by an ordinary JSON POST with no multipart reader anywhere near it.
 *
 * `kind` and `objectKey` are absent from both bodies and always will be. They are not fields, they
 * are what MAKES this row a phrase: `kind: "phrase"` is stamped by the service and `object_key` is
 * left null, which is the exact pair `prompt_object_key_kind_check` permits. A client that could
 * send either could turn a phrase into a library entry with no file behind it — a row every player
 * would then have to guard against, which is the failure the check constraint exists to prevent.
 *
 * `mohClassId` is absent for a smaller reason: an MOH file is a member of a class, and a sequence is
 * not a file. `language` is absent because a phrase's language is whatever its steps' is, and a tag
 * on the sequence that disagreed with the audio would be a tag that lies.
 */
export const createPhraseDto = z.strictObject({
	name: displayName,
});

export const updatePhraseDto = patchOf(createPhraseDto);

/**
 * One step.
 *
 * `promptId` names a `prompt` row that is NOT a phrase. That constraint cannot live here — a DTO
 * sees a uuid, not the row behind it — and it does not live in the database either, because a check
 * constraint cannot read another row. It is enforced in `phrases.service.ts` at write time, as a
 * `PBX_VALIDATION_FAILED` naming `promptId`, so the form attaches the message to the picker the user
 * just used. The compiler refuses the same thing a second time (`invalid-phrase`) for the rows that
 * predate this endpoint or arrive by any other route; the two are the same rule stated where each
 * layer can state it, and the API's version is the one that can point at a field.
 */
export const createPhraseStepDto = z.strictObject({
	promptId: z.uuid(),
	ordinal: z.int().min(0).max(1000),
	enabled: z.boolean().optional(),
});

export const updatePhraseStepDto = patchOf(createPhraseStepDto);
