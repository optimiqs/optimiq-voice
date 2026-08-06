import { extension } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Extensions — the tenant's internal endpoints, and the entity most other rows point at.
 *
 * No destination trio of its own: an extension's forwarding is expressed as dialable strings
 * (`forward_busy_destination`), not as the column trio, because a forward target is frequently a
 * mobile number rather than a row in this database. The compiler resolves those strings against
 * the internal number table and reports `unresolvable-forward` when they go nowhere.
 *
 * `destinationType: "extension"` is what makes a delete safe: every ring-group member, IVR option
 * and DID that names this extension is found by the reverse scan and returned in the 409.
 */
export const EXTENSION_RESOURCE: PbxResource = {
	kind: "extension",
	tableName: "extension",
	table: extension,
	searchColumns: [extension.number, extension.label],
	// `number` is what an admin scans for; `id` breaks its ties so paging cannot repeat a row.
	orderBy: [extension.number, extension.id],
	enabledColumn: extension.enabled,
	destinations: [],
	destinationType: "extension",
};
