import { z } from "zod/v4";
import { VOICEMAIL_GREETING_KINDS } from "@optimiq-voice/pbx-db";

/**
 * A mailbox greeting.
 *
 * ## The four kinds, and what each one is FOR
 *
 * The schema's vocabulary is `unavailable | busy | name | temporary`, and the compiler treats them
 * as three different things:
 *
 * | kind          | played when                                                   |
 * | ------------- | ------------------------------------------------------------- |
 * | `unavailable` | the caller reaches the box and there is nothing more specific  |
 * | `temporary`   | the same, but it WINS over `unavailable` while it exists       |
 * | `busy`        | the callee is on another call (the media server decides)       |
 * | `name`        | the mailbox owner's name, spoken — for directories and MWI     |
 *
 * `VOICEMAIL_LEAVE_GREETING_PRECEDENCE` in `packages/routing` is `["temporary", "unavailable"]`, so
 * "I am on holiday until Monday" is expressed by recording a `temporary` and deleting it on Monday
 * rather than by overwriting the permanent one. That is the whole reason the kind exists, and it is
 * why the upload form offers it.
 *
 * ## There is no create DTO here either
 *
 * `voicemail_greeting.object_key` is `notNull`, so a greeting row cannot exist without audio — the
 * same schema decision `prompt` makes, and the same consequence: a greeting is created by an
 * upload and by nothing else. The fields below are multipart TEXT parts beside the file.
 */
export const uploadGreetingFieldsDto = z.object({
	kind: z.enum(VOICEMAIL_GREETING_KINDS).optional(),
	label: z.string().trim().max(128).optional(),
	/**
	 * Whether to make this the active greeting for its kind immediately.
	 *
	 * Defaults to TRUE in the service, and that default is the interesting decision. An admin who
	 * has just recorded a greeting and uploaded it has expressed an intention; leaving it inactive
	 * would mean the obvious action ("upload the new greeting") silently does nothing to what
	 * callers hear, which is the sort of gap that gets discovered by a customer. Uploading a
	 * greeting to have it ready later is the rarer case, and it is the one that says so explicitly.
	 *
	 * A multipart text part, so the value arrives as a string: `"false"` and `"0"` turn it off.
	 */
	active: z
		.string()
		.optional()
		.transform((value) => (value === undefined ? undefined : !["false", "0", ""].includes(value))),
});

/** `PATCH …/greetings/:greetingId` — the label, and nothing that touches the audio or the routing. */
export const updateGreetingDto = z.strictObject({
	label: z.string().trim().max(128).nullish(),
});

/**
 * `POST …/greetings/:greetingId/activate` has no body, and this is what "no body" means.
 *
 * An empty strict object rather than no schema at all, so a client that sends `{ "kind": "busy" }`
 * is told it is doing something that will not happen — the greeting's own `kind` decides which slot
 * it occupies, and accepting a second opinion would let a caller activate a `name` recording as an
 * `unavailable` greeting.
 */
export const activateGreetingDto = z.strictObject({});

export type UploadGreetingFields = z.infer<typeof uploadGreetingFieldsDto>;
export type UpdateGreeting = z.infer<typeof updateGreetingDto>;
