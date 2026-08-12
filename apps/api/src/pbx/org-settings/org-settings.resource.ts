import { orgSetting, userSetting } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * The organization settings cascade's middle level.
 *
 * A `PbxResource` like the other eleven, and it has to be one: `affectsRouting("org_setting")` is
 * TRUE — `packages/routing`'s `ROUTING_TABLE_TO_ENTITY` maps it to the `settings` entity, and the
 * compiler reads eight of its names for the voicemail prefixes, the org caller id, the outbound
 * kill switch and the additional emergency numbers. Writing these rows outside the repository
 * would leave a tenant's compiled artifact describing a dial plan that no longer exists, in a KV
 * bucket every engine instance reads.
 *
 * So every write goes through `PbxResourceService` → `pbx.repository.ts` → compile-on-write, and
 * the routing-cache eviction is automatic. A settings write is rare and a recompile is cheap; the
 * alternative — a `notifications` write that skipped the recompile and a `routing` write that did
 * not — would be two write paths for one table, which is one more than can be kept correct.
 *
 * `destinations: []` and `destinationType: null`: a setting is not a dispatchable location and
 * nothing points at one.
 */
export const ORG_SETTING_RESOURCE: PbxResource = {
	kind: "org-setting",
	tableName: "org_setting",
	table: orgSetting,
	searchColumns: [orgSetting.category, orgSetting.name],
	// Category then name then id: the id is the tiebreak that makes the order total, so paging
	// cannot repeat a row when two settings share a category and a name across a rename.
	orderBy: [orgSetting.category, orgSetting.name, orgSetting.id],
	enabledColumn: orgSetting.enabled,
	destinations: [],
	destinationType: null,
};

/**
 * The cascade's third level — one person's overrides.
 *
 * A `PbxResource` for a DIFFERENT reason than `org_setting` above: `affectsRouting("user_setting")`
 * is FALSE (the compiler reads nothing user-scoped, by the catalogue's own rule), so the repository
 * runs no recompile for it. What routing writes through the repository buys here is the other half
 * of the machinery — the change ledger. A preference write is still a mutation somebody made, and
 * `audit-log.service.ts`'s whole argument ("a committed write must leave a trace") applies to
 * "who turned their own transcription copy off" exactly as it does to an extension. Writing these
 * rows with a bare `withTenantScope` upsert would be the one write path in the area that leaves no
 * ledger row.
 *
 * No controller mounts raw CRUD over this resource, deliberately: the only surface is
 * `/org-settings/me`, whose service pins `userId` to the session. A generic `PbxResourceService`
 * over this declaration would accept a `userId` in a body, which is exactly the input the own-ness
 * argument says must not exist.
 */
export const USER_SETTING_RESOURCE: PbxResource = {
	kind: "user-setting",
	tableName: "user_setting",
	table: userSetting,
	searchColumns: [userSetting.category, userSetting.name],
	orderBy: [userSetting.category, userSetting.name, userSetting.id],
	enabledColumn: userSetting.enabled,
	destinations: [],
	destinationType: null,
};
