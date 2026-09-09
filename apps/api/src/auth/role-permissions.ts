import {
	type Permission,
	SYSTEM_ROLE_TEMPLATES,
	type SystemRoleTemplate,
} from "@optimiq-voice/auth";

/**
 * Expands a better-auth `member.role` value into the effective permission set.
 *
 * better-auth stores one of `owner` / `admin` / `member` on the membership row, while
 * `SYSTEM_ROLE_TEMPLATES` carries five templates (`owner`, `admin`, `manager`, `agent`,
 * `user`). Resolution is deliberately conservative:
 *
 * 1. exact template id (so `manager` / `agent` / `user` work the moment the role editor starts
 *    writing them);
 * 2. otherwise the LEAST privileged template whose `membershipRole` matches — a bare `member`
 *    resolves to `user`, never to `manager`.
 *
 * A comma-separated value (better-auth's multi-role encoding) is expanded to the union.
 */

const TEMPLATE_BY_ID = new Map<string, SystemRoleTemplate>(
	SYSTEM_ROLE_TEMPLATES.map((template) => [template.id, template]),
);

const LEAST_PRIVILEGED_TEMPLATE_BY_MEMBERSHIP_ROLE = new Map<string, SystemRoleTemplate>();
for (const template of SYSTEM_ROLE_TEMPLATES) {
	const current = LEAST_PRIVILEGED_TEMPLATE_BY_MEMBERSHIP_ROLE.get(template.membershipRole);
	if (!current || template.permissions.length < current.permissions.length) {
		LEAST_PRIVILEGED_TEMPLATE_BY_MEMBERSHIP_ROLE.set(template.membershipRole, template);
	}
}

export function resolveRoleTemplate(role: string): SystemRoleTemplate | undefined {
	const normalized = role.trim().toLowerCase();
	if (normalized.length === 0) {
		return undefined;
	}
	return (
		TEMPLATE_BY_ID.get(normalized) ??
		LEAST_PRIVILEGED_TEMPLATE_BY_MEMBERSHIP_ROLE.get(normalized) ??
		undefined
	);
}

/**
 * Memoized results, keyed by the raw role value.
 *
 * This is a pure function of module constants — `SYSTEM_ROLE_TEMPLATES` is frozen at import — so a
 * cached answer can never be stale, and there is no invalidation to get wrong. It is memoized
 * because it runs on EVERY authenticated request (`RequirePermissionsGuard` → `resolveAccess`) and
 * on every live-socket revalidation, and it is not cheap: expanding `owner` allocates a `Set` and a
 * 121-element array, measured at 1.8 µs per call. At 2000 req/s that is 3.6 ms of CPU and ~250 000
 * short-lived array slots per second, spent re-deriving a constant.
 *
 * Unbounded is safe because the KEY SPACE is: a role value is a comma-separated list of template
 * ids, every unrecognised part is skipped, and nothing here is derived from user input beyond the
 * `member.role` column — so the map cannot be grown by a caller. Empty results are cached too,
 * which is what makes a junk role cheap on its second appearance rather than expensive forever.
 */
const PERMISSIONS_BY_ROLE = new Map<string, readonly Permission[]>();

/** Effective permissions for a membership role. Unknown roles grant nothing. */
export function resolveRolePermissions(role: string | null | undefined): readonly Permission[] {
	if (!role) {
		return [];
	}
	const cached = PERMISSIONS_BY_ROLE.get(role);
	if (cached !== undefined) {
		return cached;
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
	// Frozen because it is now shared by every caller: a consumer that mutated the returned array
	// would be editing the permission set of every future request with the same role.
	const permissions = Object.freeze([...granted]) as readonly Permission[];
	PERMISSIONS_BY_ROLE.set(role, permissions);
	return permissions;
}
