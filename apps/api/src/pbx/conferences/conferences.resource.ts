import { conference } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Conference rooms.
 *
 * No destination trio of its own: a conference is where a call ENDS UP, not a step on the way
 * somewhere else — a participant who leaves has hung up, and there is no branch to take. That is
 * also why `destinationType: "conference"` matters here: it is the only thing that makes the
 * reverse scan find the DIDs, IVR options and ring-group timeouts that point at a room before the
 * room is deleted out from under them.
 *
 * `pinHash` and `moderatorPinHash` are absent from the DTO, exactly as `voicemail_box.pinHash` is:
 * a PIN is set through an endpoint that hashes it, never by an admin pasting a digest into a JSON
 * body. Until that endpoint exists, `requiresPin` in the compiled artifact stays false — recorded
 * as a follow-up rather than papered over with a plaintext column.
 */
export const CONFERENCE_RESOURCE: PbxResource = {
	kind: "conference",
	tableName: "conference",
	table: conference,
	searchColumns: [conference.name, conference.roomNumber],
	orderBy: [conference.roomNumber, conference.id],
	enabledColumn: conference.enabled,
	destinations: [],
	destinationType: "conference",
};
