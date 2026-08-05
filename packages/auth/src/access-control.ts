import { type AccessControl, createAccessControl, type Role } from "better-auth/plugins/access";
import { defaultRoles, defaultStatements } from "better-auth/plugins/organization/access";
import {
	buildAccessControlStatements,
	SYSTEM_ROLE_TEMPLATES,
	type SystemRoleId,
	UnknownPermissionError,
} from "./permissions";

/**
 * Binds the Optimiq Voice permission registry to better-auth's organization access control.
 *
 * Without this, `member.role` can only ever be one of better-auth's three built-in values
 * (`owner` / `admin` / `member`): the invite and update-role endpoints reject any role that is
 * neither a plugin default nor a key of `OrganizationOptions.roles`
 * (`dist/plugins/organization/routes/crud-invites.mjs:104-122`). Three of the five
 * {@link SYSTEM_ROLE_TEMPLATES} — `manager`, `agent`, `user` — were therefore unreachable, and a
 * bare `member` fell back to the least privileged template. Registering the templates here makes
 * all five assignable.
 *
 * ## The merge is not optional
 *
 * better-auth resolves roles as `options.roles || defaultRoles`
 * (`dist/plugins/organization/has-permission.mjs:7`) — a REPLACEMENT, not a merge. The plugin's
 * own endpoints gate themselves on its `organization` / `member` / `invitation` / `team` / `ac`
 * statements, so handing it a roles map built only from the registry would leave `owner` without
 * `invitation: ["create"]` and break invitations outright. Both the statement map and the roles
 * map therefore start from the plugin's defaults and the registry is layered on top.
 *
 * `member` is deliberately left as the plugin's own `memberAc`: it has no
 * {@link SYSTEM_ROLE_TEMPLATES} counterpart, which is exactly why
 * `apps/api/src/auth/role-permissions.ts` keeps its least-privilege fallback.
 */

/** The resources better-auth's organization plugin gates its own endpoints on. */
export const ORGANIZATION_PLUGIN_RESOURCES: readonly string[] = Object.keys(defaultStatements);

export interface OrganizationAccessControl {
	/** Pass as `OrganizationOptions.ac`. */
	readonly ac: AccessControl;
	/** Pass as `OrganizationOptions.roles`. Keyed by role id, plugin defaults included. */
	readonly roles: Record<string, Role>;
	/** The merged statement map the access controller was built from. */
	readonly statements: Record<string, readonly string[]>;
}

/**
 * Merges the plugin's own statements with the registry's.
 *
 * A resource that exists on both sides would be silently overwritten, so a collision is a hard
 * error rather than a surprise at request time. There is none today: the registry's tenancy
 * resources are plural (`members`, `api-keys`) while the plugin's are singular (`member`, `ac`).
 */
export function buildOrganizationStatements(): Record<string, readonly string[]> {
	const registry = buildAccessControlStatements();
	const collisions = Object.keys(registry).filter((resource) => resource in defaultStatements);
	if (collisions.length > 0) {
		throw new UnknownPermissionError(
			`Permission resource(s) ${collisions.join(", ")} collide with better-auth's own ` +
				"organization statements. Rename the resource in PERMISSIONS.",
		);
	}
	return { ...defaultStatements, ...registry };
}

/**
 * Composes the access controller and the role map for the organization plugin.
 *
 * Each template's role is the union of the plugin statements its `membershipRole` already carried
 * and the statements its permission list expands to, so upgrading a `member` to `manager` adds
 * telephony reach without also granting it the plugin's member-management endpoints.
 */
export function buildOrganizationAccessControl(): OrganizationAccessControl {
	const statements = buildOrganizationStatements();
	// `createAccessControl` is generic over a literal statement map; this one is assembled from
	// the registry at runtime, so the literal inference it wants cannot exist here.
	const ac = createAccessControl(statements as Record<string, readonly string[]>);

	const roles: Record<string, Role> = { ...defaultRoles };
	for (const template of SYSTEM_ROLE_TEMPLATES) {
		roles[template.id] = ac.newRole({
			...defaultRoles[template.membershipRole].statements,
			...buildAccessControlStatements(template.permissions),
		}) as Role;
	}

	return { ac: ac as AccessControl, roles, statements };
}

/** Every role id the organization plugin will accept once the access control is registered. */
export function organizationRoleIds(): readonly string[] {
	return Object.keys(buildOrganizationAccessControl().roles);
}

/** The role a newly created organization's creator is given. */
export const DEFAULT_ORGANIZATION_CREATOR_ROLE: SystemRoleId = "owner";
