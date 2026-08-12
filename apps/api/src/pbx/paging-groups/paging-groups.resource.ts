import { pagingGroup, pagingGroupMember } from "@optimiq-voice/pbx-db";
import type { PbxChildResource, PbxResource } from "../shared/pbx-resource";

/**
 * Paging groups and their members.
 *
 * ## Why neither table carries a destination trio
 *
 * Every other resource in this area ends by handing the call somewhere: a ring group's timeout goes
 * to voicemail, a park lot's goes back to the front desk, an IVR's invalid branch replays the menu.
 * A page has nowhere to go. The pager speaks, the members' handsets auto-answer, and when the pager
 * hangs up the announcement is over — there is no unanswered state to route out of, because a page
 * does not wait for an answer, it causes one. So `destinations` is empty on BOTH tables, and adding
 * a `timeout` trio later would be inventing a branch the feature does not have; `paging-schema.ts`
 * refuses the columns for the same reason, so the DTO and the schema agree rather than one of them
 * quietly allowing what the other forbids.
 *
 * A member is not a destination either. `ring_group_destination` carries a trio because a member of
 * a ring group may be an extension, an external number or another group — the fan-out is over
 * DESTINATIONS. A paging member is an `extension_id` foreign key and nothing else, because the
 * engine has to originate an auto-answered leg to a real registered endpoint: an external number
 * cannot be told to pick up, and a nested group would be a fan-out whose depth nobody bounded.
 *
 * ## What can point at a group, and what that costs on delete
 *
 * `destinationType: "paging-group"` — an IVR option, an inbound route or a time condition may send a
 * call into an announcement, so the generic reverse scan has to know the type or deleting a group
 * would leave those rows dangling. On top of that, a `paging` feature code may pin a group in
 * `params.groupId`, which lives inside a `jsonb` column where no foreign key and no column scan can
 * reach; `findPagingGroupFeatureCodeReferences` in `shared/destinations.ts` covers that case, for
 * exactly the same reason `findParkLotFeatureCodeReferences` covers `params.lotId`.
 */
export const PAGING_GROUP_RESOURCE: PbxResource = {
	kind: "paging-group",
	tableName: "paging_group",
	table: pagingGroup,
	searchColumns: [pagingGroup.name, pagingGroup.extensionNumber],
	orderBy: [pagingGroup.name, pagingGroup.id],
	enabledColumn: pagingGroup.enabled,
	/** A page ends when the pager hangs up. There is no branch to take, so there is no trio. */
	destinations: [],
	destinationType: "paging-group",
};

/**
 * One handset in a group.
 *
 * `ordinalColumn` is what earns this collection its `PUT …/reorder`: an announcement to a hundred
 * desks is fanned out rather than originated in one instant, so the order is the operator's
 * decision — the same argument that gives ring-group members a reorder and denies queue tiers one,
 * whose place is `(level, position)` and is routing policy rather than a drag handle.
 */
export const PAGING_GROUP_MEMBER_RESOURCE: PbxChildResource = {
	kind: "paging-group-member",
	tableName: "paging_group_member",
	table: pagingGroupMember,
	searchColumns: [],
	orderBy: [pagingGroupMember.ordinal, pagingGroupMember.id],
	ordinalColumn: pagingGroupMember.ordinal,
	enabledColumn: pagingGroupMember.enabled,
	destinations: [],
	destinationType: null,
	parentColumn: pagingGroupMember.pagingGroupId,
	parentKind: "paging-group",
	parentTable: pagingGroup,
};
