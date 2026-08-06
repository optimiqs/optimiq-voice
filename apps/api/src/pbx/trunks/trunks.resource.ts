import { trunk } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Carrier trunks.
 *
 * Nothing names a trunk in a `destination_type` — a trunk is reached through an outbound route's
 * ordered failover list, which lives in `outbound_route.trunk_priority` as JSONB. No foreign key
 * can express that, so the repository runs a dedicated `jsonb_array_elements` scan before a
 * delete; see `findTrunkReferences`. Deleting a trunk an outbound route still lists would
 * otherwise leave a route whose only effect is an `unknown-trunk` warning at the next compile.
 *
 * The `status*` columns are the persisted view of the SIP edge's OPTIONS pinger, written by the
 * engine. They are not writable through this API: an admin form must not be able to assert that a
 * carrier is up.
 */
export const TRUNK_RESOURCE: PbxResource = {
	kind: "trunk",
	tableName: "trunk",
	table: trunk,
	searchColumns: [trunk.name, trunk.sipDomain, trunk.sipProxy],
	orderBy: [trunk.name, trunk.id],
	enabledColumn: trunk.enabled,
	destinations: [],
	destinationType: null,
};
