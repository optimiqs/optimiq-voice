import { parkLot } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Call-park orbits.
 *
 * A lot owns an inclusive slot range and a retrieval timeout, plus the branch a call takes when
 * nobody picks it back up — the trio that stops a parked call becoming a caller listening to hold
 * music until the carrier gives up.
 *
 * `feature_code.params.lotId` names a lot from inside a `jsonb` column, so no foreign key can
 * express it and the generic reverse scan cannot see it. `findParkLotFeatureCodeReferences` in
 * `shared/destinations.ts` covers that case, for the same reason `findTrunkReferences` covers the
 * trunk list inside `outbound_route.trunk_priority`.
 */
export const PARK_LOT_RESOURCE: PbxResource = {
	kind: "park-lot",
	tableName: "park_lot",
	table: parkLot,
	searchColumns: [parkLot.name],
	orderBy: [parkLot.name, parkLot.id],
	enabledColumn: parkLot.enabled,
	/** Taken when `timeoutSeconds` expires with the call still parked. */
	destinations: [{ prefix: "timeout", required: false }],
	destinationType: "park",
};
