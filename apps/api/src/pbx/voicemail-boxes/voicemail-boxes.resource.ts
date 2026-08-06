import { voicemailBox } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Voicemail boxes.
 *
 * The box row only; messages and greetings are separate tables and separate concerns (and
 * `voicemail_message` is explicitly NOT a routing input — `affectsRouting("voicemail_message")` is
 * false, which is what stops every new message from evicting a hot artifact).
 *
 * `pinHash` is absent from the DTO and from every response: a PIN is set through
 * `POST /voicemail-boxes/:id/pin`, which hashes it (`voicemail-pin.service.ts`), and cleared with
 * the matching `DELETE`. An admin never pastes a digest into a JSON body and never receives one —
 * `secretColumns` is what makes the second half true. A digest is offline-crackable and a
 * four-digit PIN behind it is seconds of work, so "we only return the hash" is not a defence.
 *
 * The set/clear endpoints write through the SAME repository `update` every other mutation uses,
 * which is what makes the digest reach the engine: `voicemail_box` is a routing table, `pinHash`
 * is now part of `OrgRoutingSnapshot`, and a direct write would leave the compiled artifact
 * carrying the old digest until something unrelated recompiled the tenant.
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
	secretColumns: ["pinHash"],
};
