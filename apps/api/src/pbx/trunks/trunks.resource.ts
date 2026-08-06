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
	/**
	 * The outbound-auth secret half, withheld for the same reason as an extension's.
	 *
	 * `authUser` is deliberately NOT here. It is the SIP username — the public half of the pair,
	 * the value the carrier prints on its own portal, and the one thing an operator staring at a
	 * failing registration most needs to see. `trunk-detail.tsx` renders it as "SIP username" and
	 * should keep doing so; hiding it would cost a real diagnostic and buy nothing, because a
	 * username without its secret authenticates nothing.
	 *
	 * `sipSecretRef` is the other half's address in the secret manager, and it is withheld. The
	 * carrier-provisioning path writes it through `TrunksService.update` (`carrier.service.ts`),
	 * whose envelope is spread into the provisioning response — so redacting at the resource is
	 * what keeps it out of that second surface too, rather than only out of the CRUD one.
	 */
	secretColumns: ["sipSecretRef"],
};
