import { describe, expect, it } from "bun:test";
import { defaultRoles, defaultStatements } from "better-auth/plugins/organization/access";
import {
	buildOrganizationAccessControl,
	buildOrganizationStatements,
	DEFAULT_ORGANIZATION_CREATOR_ROLE,
	ORGANIZATION_PLUGIN_RESOURCES,
	organizationRoleIds,
} from "./access-control";
import {
	buildAccessControlStatements,
	PERMISSIONS,
	SYSTEM_ROLE_IDS,
	SYSTEM_ROLE_TEMPLATES,
} from "./permissions";

describe("buildOrganizationStatements", () => {
	it("keeps every statement better-auth's organization plugin gates itself on", () => {
		const statements = buildOrganizationStatements();
		for (const [resource, actions] of Object.entries(defaultStatements)) {
			expect(statements[resource]).toEqual(actions as unknown as string[]);
		}
	});

	it("exposes the plugin resources it must not overwrite", () => {
		expect([...ORGANIZATION_PLUGIN_RESOURCES].sort()).toEqual(
			Object.keys(defaultStatements).sort(),
		);
	});

	it("adds every registry resource on top of the plugin's", () => {
		const statements = buildOrganizationStatements();
		const registry = buildAccessControlStatements();
		for (const [resource, actions] of Object.entries(registry)) {
			expect(statements[resource]).toEqual(actions);
		}
		expect(Object.keys(statements).length).toBe(
			Object.keys(defaultStatements).length + Object.keys(registry).length,
		);
	});

	it("round-trips PERMISSIONS: every permission appears in exactly one resource:action pair", () => {
		const statements = buildOrganizationStatements();
		const rebuilt: string[] = [];
		for (const [resource, actions] of Object.entries(statements)) {
			if (resource in defaultStatements) continue;
			for (const action of actions) {
				rebuilt.push(`${resource}.${action}`);
			}
		}
		expect(rebuilt.sort()).toEqual([...PERMISSIONS].sort());
		expect(new Set(rebuilt).size).toBe(PERMISSIONS.length);
	});

	it("never lets a registry resource shadow a plugin resource", () => {
		const registry = Object.keys(buildAccessControlStatements());
		for (const resource of ORGANIZATION_PLUGIN_RESOURCES) {
			expect(registry).not.toContain(resource);
		}
	});
});

describe("buildOrganizationAccessControl", () => {
	it("makes every SYSTEM_ROLE_TEMPLATES id an assignable organization role", () => {
		const { roles } = buildOrganizationAccessControl();
		for (const id of SYSTEM_ROLE_IDS) {
			expect(Object.keys(roles)).toContain(id);
		}
	});

	it("keeps better-auth's own owner / admin / member resolvable", () => {
		const ids = organizationRoleIds();
		for (const id of Object.keys(defaultRoles)) {
			expect(ids).toContain(id);
		}
	});

	it("registers exactly the plugin defaults plus the templates", () => {
		const ids = new Set(organizationRoleIds());
		const expected = new Set([...Object.keys(defaultRoles), ...SYSTEM_ROLE_IDS]);
		expect([...ids].sort()).toEqual([...expected].sort());
	});

	it("grants each template every permission its registry entry lists", () => {
		const { roles } = buildOrganizationAccessControl();
		for (const template of SYSTEM_ROLE_TEMPLATES) {
			const role = roles[template.id];
			expect(role).toBeDefined();
			for (const [resource, actions] of Object.entries(
				buildAccessControlStatements(template.permissions),
			)) {
				expect(role?.authorize({ [resource]: actions } as never).success).toBe(true);
			}
		}
	});

	it("does not grant a template a permission outside its registry entry", () => {
		const { roles } = buildOrganizationAccessControl();
		// `user` is the smallest template; `numbers.order` belongs to `owner` and `admin` alone.
		//
		// This used to read `secrets.read`, which was the sharpest example available: a grant only
		// `owner` held. `secrets.*` has since been retired — the table it guarded was dropped with
		// the legacy platform, so the permission checked nothing (see `RETIRED_PERMISSIONS`) — and
		// `numbers.order` is the closest surviving pair. It is a real boundary rather than a
		// convenient one: it spends the organization's money, and the registry entry argues at
		// length for why it is not a ride on `numbers.write`.
		expect(roles.user?.authorize({ numbers: ["order"] } as never).success).toBe(false);
		expect(roles.owner?.authorize({ numbers: ["order"] } as never).success).toBe(true);
	});

	it("layers the membership role's plugin statements under each template", () => {
		const { roles } = buildOrganizationAccessControl();
		// Without the merge, `owner` would lose invitation:create and invitations would break.
		expect(roles.owner?.authorize({ invitation: ["create"] } as never).success).toBe(true);
		expect(roles.admin?.authorize({ invitation: ["create"] } as never).success).toBe(true);
		// A `member`-backed template inherits memberAc, which cannot invite.
		expect(roles.manager?.authorize({ invitation: ["create"] } as never).success).toBe(false);
		expect(roles.agent?.authorize({ invitation: ["create"] } as never).success).toBe(false);
	});

	it("separates manager from user — the ambiguity Step 1 finding 3 recorded", () => {
		const { roles } = buildOrganizationAccessControl();
		expect(roles.manager?.authorize({ extensions: ["write"] } as never).success).toBe(true);
		expect(roles.user?.authorize({ extensions: ["write"] } as never).success).toBe(false);
		expect(roles.agent?.authorize({ queues: ["join.own"] } as never).success).toBe(true);
		expect(roles.user?.authorize({ queues: ["join.own"] } as never).success).toBe(false);
	});

	it("builds an access controller carrying the merged statement map", () => {
		const { ac, statements } = buildOrganizationAccessControl();
		expect(ac.statements).toEqual(statements as never);
	});

	it("defaults the creator to owner so verify:auth's owner assertion holds", () => {
		expect(DEFAULT_ORGANIZATION_CREATOR_ROLE).toBe("owner");
		expect(SYSTEM_ROLE_IDS).toContain(DEFAULT_ORGANIZATION_CREATOR_ROLE);
	});
});
