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
