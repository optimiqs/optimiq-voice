import { ringGroup, ringGroupDestination } from "@optimiq-voice/pbx-db";
import type { PbxChildResource, PbxResource } from "../shared/pbx-resource";

/**
 * Ring groups and their members.
 *
 * A group with no enabled members compiles to a warning (`empty-ring-group`), not an error, and
 * that is the case this API is shaped around: you create the group, then add members. Refusing the
 * first save would make the admin UI impossible to use, so the warning rides out in the mutation
 * envelope and P4 renders it against the members list.
 */
export const RING_GROUP_RESOURCE: PbxResource = {
	kind: "ring-group",
	tableName: "ring_group",
	table: ringGroup,
	searchColumns: [ringGroup.name, ringGroup.extensionNumber],
	orderBy: [ringGroup.name, ringGroup.id],
	enabledColumn: ringGroup.enabled,
	destinations: [{ prefix: "timeout", required: false }],
	destinationType: "ring-group",
};

export const RING_GROUP_DESTINATION_RESOURCE: PbxChildResource = {
	kind: "ring-group-destination",
	tableName: "ring_group_destination",
	table: ringGroupDestination,
	searchColumns: [],
	orderBy: [ringGroupDestination.ordinal, ringGroupDestination.id],
	ordinalColumn: ringGroupDestination.ordinal,
	enabledColumn: ringGroupDestination.enabled,
	destinations: [{ prefix: "", required: true }],
	destinationType: null,
	parentColumn: ringGroupDestination.ringGroupId,
	parentKind: "ring-group",
	parentTable: ringGroup,
};
