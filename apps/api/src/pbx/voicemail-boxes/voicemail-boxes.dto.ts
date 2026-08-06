import { z } from "zod/v4";
import { VOICEMAIL_EMAIL_MODES } from "@optimiq-voice/pbx-db";
import { internalNumber, patchOf, resettable } from "../shared/dto";

export const createVoicemailBoxDto = z.strictObject({
	/** Usually the extension number, but boxes may be standalone. */
	mailboxNumber: internalNumber,
	label: z.string().max(128).nullish(),
	extensionId: z.uuid().nullish(),
	emailAddress: z.email().max(255).nullish(),
	emailMode: z.enum(VOICEMAIL_EMAIL_MODES).optional(),
	/** Classic "email and delete": the box keeps no copy. */
	deleteAfterDelivery: z.boolean().optional(),
	transcriptionEnabled: z.boolean().optional(),
	mwiEnabled: z.boolean().optional(),
	maxMessages: resettable(z.int().min(1).max(10_000)),
	maxMessageSeconds: resettable(z.int().min(10).max(3600)),
	enabled: z.boolean().optional(),
});

export const updateVoicemailBoxDto = patchOf(createVoicemailBoxDto);
