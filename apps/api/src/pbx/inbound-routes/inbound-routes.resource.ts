import { inboundRoute } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Inbound routes — carrier traffic, resolved in the `inbound` context, which cannot reach a trunk.
 *
 * Two trios: the destination the call takes when the rule matches (required), and a failover taken
 * when that destination is unreachable (optional). Both are validated for shape and existence
 * before the row lands.
 *
 * `orderBy` is `(priority, name)` because priority is the tenant's explicit intent and is what the
 * compiler sorts by; listing them in any other order would make the admin UI disagree with the
 * order calls are actually matched in.
 */
export const INBOUND_ROUTE_RESOURCE: PbxResource = {
	kind: "inbound-route",
	tableName: "inbound_route",
	table: inboundRoute,
	searchColumns: [inboundRoute.name, inboundRoute.matchPattern],
	orderBy: [inboundRoute.priority, inboundRoute.name, inboundRoute.id],
	enabledColumn: inboundRoute.enabled,
	destinations: [
		{ prefix: "", required: true },
		{ prefix: "failover", required: false },
	],
	destinationType: null,
};
