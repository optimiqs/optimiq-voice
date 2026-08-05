import {
	PERMISSIONS,
	SYSTEM_ROLE_TEMPLATES,
	type Permission,
	type PermissionScope,
	type SystemRoleTemplate,
} from "./permissions.generated";

/**
 * Client-side reading of the permission registry.
 *
 * The data comes from `./permissions.generated.ts` (written by `scripts/sync-permissions.ts` from
 * `packages/auth/src/permissions.ts`); the predicates below mirror the server's own —
 * `packages/auth/src/permissions.ts#hasPermission` and
 * `apps/api/src/auth/role-permissions.ts#resolveRolePermissions`. `permissions.spec.ts` asserts
 * that mirror holds against the real server implementation, so drift fails a test rather than
 * quietly showing a member a button the API will reject.
 *
 * This is presentation only. Hiding a control is a courtesy; the `@RequirePermissions` guard is
 * the enforcement, and every gated action must still be safe to attempt.
 */

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
	return PERMISSION_SET.has(value);
}

export function parsePermission(value: Permission): {
	resource: string;
	action: string;
	scope?: PermissionScope;
} {
	const [resource = "", action = "", scope] = value.split(".") as [
		string?,
		string?,
		PermissionScope?,
	];
	return scope === undefined ? { resource, action } : { resource, action, scope };
}

/**
 * True when `granted` satisfies `required`, treating an unscoped grant as covering its scopes —
 * holding `voicemail.read` implies `voicemail.read.own`, never the reverse.
 *
 * Unlike the server, an unregistered string degrades to `false` instead of throwing: a stale
 * bundle asking about a permission a newer server removed must not blank the page.
 */
export function hasPermission(granted: Iterable<string>, required: Permission): boolean {
	const grantedSet = granted instanceof Set ? granted : new Set(granted);
	if (grantedSet.has(required)) {
		return true;
	}
	if (!isPermission(required)) {
		return false;
	}
	const { resource, action, scope } = parsePermission(required);
	return scope !== undefined && grantedSet.has(`${resource}.${action}`);
}

export function hasEveryPermission(
	granted: Iterable<string>,
	required: readonly Permission[],
): boolean {
	const grantedSet = new Set(granted);
	return required.every((permission) => hasPermission(grantedSet, permission));
}

export function hasAnyPermission(
	granted: Iterable<string>,
	required: readonly Permission[],
): boolean {
	if (required.length === 0) {
		return true;
	}
	const grantedSet = new Set(granted);
	return required.some((permission) => hasPermission(grantedSet, permission));
}

const TEMPLATE_BY_ID = new Map<string, SystemRoleTemplate>(
	SYSTEM_ROLE_TEMPLATES.map((template) => [template.id, template]),
);

/**
 * better-auth stores `owner` / `admin` / `member` on the membership row while five templates
 * exist, so a bare `member` must resolve to the LEAST privileged template sharing that
 * membership role (`user`) — never to `manager`.
 */
const LEAST_PRIVILEGED_BY_MEMBERSHIP_ROLE = new Map<string, SystemRoleTemplate>();
for (const template of SYSTEM_ROLE_TEMPLATES) {
	const current = LEAST_PRIVILEGED_BY_MEMBERSHIP_ROLE.get(template.membershipRole);
	if (!current || template.permissions.length < current.permissions.length) {
		LEAST_PRIVILEGED_BY_MEMBERSHIP_ROLE.set(template.membershipRole, template);
	}
}

export function resolveRoleTemplate(role: string): SystemRoleTemplate | undefined {
	const normalized = role.trim().toLowerCase();
	if (normalized.length === 0) {
		return undefined;
	}
	return TEMPLATE_BY_ID.get(normalized) ?? LEAST_PRIVILEGED_BY_MEMBERSHIP_ROLE.get(normalized);
}

/** Effective permissions for a membership role. Unknown roles grant nothing. */
export function resolveRolePermissions(role: string | null | undefined): readonly Permission[] {
	if (!role) {
		return [];
	}
	const granted = new Set<Permission>();
	for (const part of role.split(",")) {
		const template = resolveRoleTemplate(part);
		if (!template) {
			continue;
		}
		for (const permission of template.permissions) {
			granted.add(permission);
		}
	}
	return [...granted];
}

/** Role templates a member may be assigned, most privileged first. */
export const ASSIGNABLE_ROLE_TEMPLATES: readonly SystemRoleTemplate[] = [
	...SYSTEM_ROLE_TEMPLATES,
].sort((a, b) => b.permissions.length - a.permissions.length);

export function roleLabel(role: string | null | undefined): string {
	if (!role) {
		return "No role";
	}
	return resolveRoleTemplate(role)?.label ?? role;
}

export type { Permission, PermissionScope, SystemRoleTemplate };
export {
	PERMISSION_CATALOG,
	PERMISSIONS,
	SYSTEM_ROLE_IDS,
	SYSTEM_ROLE_TEMPLATES,
} from "./permissions.generated";
