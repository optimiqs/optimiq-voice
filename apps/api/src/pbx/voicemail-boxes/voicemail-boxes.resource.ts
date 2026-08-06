import { voicemailBox } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Voicemail boxes.
 *
 * The box row only; messages and greetings are separate tables and separate concerns (and
 * `voicemail_message` is explicitly NOT a routing input — `affectsRouting("voicemail_message")` is
 * false, which is what stops every new message from evicting a hot artifact).
 *
 * `pinHash` is absent from the DTO: a PIN is set through a dedicated endpoint that hashes it, not
 * by an admin pasting a digest into a JSON body.
 */
export const VOICEMAIL_BOX_RESOURCE: PbxResource = {
	kind: "voicemail-box",
	tableName: "voicemail_box",
	table: voicemailBox,
	searchColumns: [voicemailBox.mailboxNumber, voicemailBox.label, voicemailBox.emailAddress],
	orderBy: [voicemailBox.mailboxNumber, voicemailBox.id],
	enabledColumn: voicemailBox.enabled,
	destinations: [],
	destinationType: "voicemail",
};
