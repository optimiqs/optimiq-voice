import { outboundRoute } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Outbound routes — the only context that reaches a trunk, and therefore the only place toll
 * fraud can happen.
 *
 * `tollClass` is NOT NULL by design in the schema: an outbound route without a required privilege
 * class is a route every extension may take. The DTO makes it required for the same reason rather
 * than defaulting it.
 *
 * The trunk failover list lives in `trunk_priority` (JSONB), which no foreign key can validate —
 * the compiler reports `unknown-trunk` / `disabled-trunk` warnings for entries that do not
 * resolve, and the trunk resource's delete path scans this column so a trunk in use cannot vanish
 * under a route.
 */
export const OUTBOUND_ROUTE_RESOURCE: PbxResource = {
	kind: "outbound-route",
	tableName: "outbound_route",
	table: outboundRoute,
	searchColumns: [outboundRoute.name],
	orderBy: [outboundRoute.priority, outboundRoute.name, outboundRoute.id],
	enabledColumn: outboundRoute.enabled,
	destinations: [{ prefix: "failover", required: false }],
	destinationType: null,
};
