import { describe, expect, it } from "bun:test";
import {
	hasPermission as serverHasPermission,
	PERMISSION_CATALOG as SERVER_CATALOG,
	PERMISSIONS as SERVER_PERMISSIONS,
	SYSTEM_ROLE_TEMPLATES as SERVER_ROLE_TEMPLATES,
} from "@optimiq-voice/auth/permissions";
import {
	hasAnyPermission,
	hasEveryPermission,
	hasPermission,
	isPermission,
	PERMISSION_CATALOG,
	PERMISSIONS,
	resolveRolePermissions,
	resolveRoleTemplate,
	roleLabel,
	SYSTEM_ROLE_TEMPLATES,
} from "./permissions";
import type { Permission } from "./permissions";

/**
 * These tests exist to make drift loud.
 *
 * The generated module is data copied out of `packages/auth/src/permissions.ts`, and the
 * predicates in `./permissions.ts` are a second implementation of logic the server already has.
 * Both are places where the browser can quietly start disagreeing with the API about who may do
 * what — so both are checked against the real thing rather than against a fixture.
 *
 * Importing `@optimiq-voice/auth/permissions` here is safe: it is a devDependency used by the
 * codegen, the subpath has no runtime dependencies, and nothing in the app imports it.
 */

describe("generated registry", () => {
	it("carries every permission the server declares, in order", () => {
		expect(PERMISSIONS).toEqual(SERVER_PERMISSIONS as unknown as typeof PERMISSIONS);
	});

	it("has not drifted from the server catalog", () => {
		expect(PERMISSION_CATALOG).toEqual(SERVER_CATALOG as unknown as typeof PERMISSION_CATALOG);
	});

	it("carries the same role templates with the same permission sets", () => {
		expect(SYSTEM_ROLE_TEMPLATES.map((template) => template.id)).toEqual(
			SERVER_ROLE_TEMPLATES.map((template) => template.id),
		);
		for (const template of SYSTEM_ROLE_TEMPLATES) {
			const server = SERVER_ROLE_TEMPLATES.find((candidate) => candidate.id === template.id);
			expect(server).toBeDefined();
			expect(template.membershipRole).toBe(server?.membershipRole as never);
			expect([...template.permissions].sort()).toEqual([...(server?.permissions ?? [])].sort());
		}
	});

	it("is a closed set", () => {
		expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
		expect(isPermission("extensions.read")).toBe(true);
		expect(isPermission("extensions.obliterate")).toBe(false);
	});
});

describe("hasPermission", () => {
	it("agrees with the server for every granted/required pair a role can produce", () => {
		for (const template of SYSTEM_ROLE_TEMPLATES) {
			const granted = new Set<string>(template.permissions);
			for (const required of PERMISSIONS) {
				expect(hasPermission(granted, required)).toBe(
					serverHasPermission(granted, required as never),
				);
			}
		}
	});

	it("treats an unscoped grant as covering its scopes, never the reverse", () => {
		expect(hasPermission(["voicemail.read"], "voicemail.read.own")).toBe(true);
		expect(hasPermission(["voicemail.read.own"], "voicemail.read")).toBe(false);
	});

	it("does not leak across resources or actions", () => {
		expect(hasPermission(["extensions.read"], "extensions.write")).toBe(false);
		expect(hasPermission(["extensions.read"], "devices.read")).toBe(false);
	});

	/** The server throws for an unregistered permission; the browser must degrade closed instead. */
	it("answers false for a permission that is not registered", () => {
		expect(hasPermission(["extensions.read"], "extensions.obliterate" as Permission)).toBe(false);
	});
});

describe("hasEveryPermission / hasAnyPermission", () => {
	it("requires all of a set for every, one of a set for any", () => {
		const granted = ["extensions.read", "devices.read"];
		expect(hasEveryPermission(granted, ["extensions.read", "devices.read"])).toBe(true);
		expect(hasEveryPermission(granted, ["extensions.read", "trunks.read"])).toBe(false);
		expect(hasAnyPermission(granted, ["extensions.read", "trunks.read"])).toBe(true);
		expect(hasAnyPermission(granted, ["trunks.read"])).toBe(false);
	});

	it("treats an empty requirement as satisfied for any and for every", () => {
		expect(hasAnyPermission([], [])).toBe(true);
		expect(hasEveryPermission([], [])).toBe(true);
	});
});

describe("resolveRolePermissions", () => {
	it("expands each template id to that template's permissions", () => {
		for (const template of SYSTEM_ROLE_TEMPLATES) {
			expect([...resolveRolePermissions(template.id)].sort()).toEqual(
				[...template.permissions].sort(),
			);
		}
	});

	/**
	 * The rule `apps/api/src/auth/role-permissions.ts` enforces: a bare `member` is the LEAST
	 * privileged template sharing that membership role. Resolving it to `manager` would hand every
	 * plain member the run of the phone system.
	 */
	it("resolves a bare better-auth membership role to the least privileged template", () => {
		expect(resolveRoleTemplate("member")?.id).toBe("user");
		expect(resolveRoleTemplate("owner")?.id).toBe("owner");
		expect(resolveRoleTemplate("admin")?.id).toBe("admin");
	});

	it("is case- and whitespace-insensitive, and unions comma-separated roles", () => {
		expect(resolveRoleTemplate("  MANAGER ")?.id).toBe("manager");
		const union = new Set(resolveRolePermissions("agent,manager"));
		for (const permission of resolveRolePermissions("manager")) {
			expect(union.has(permission)).toBe(true);
		}
	});

	it("grants nothing for an unknown, empty or absent role", () => {
		expect(resolveRolePermissions("nonsense")).toEqual([]);
		expect(resolveRolePermissions("")).toEqual([]);
		expect(resolveRolePermissions(null)).toEqual([]);
		expect(resolveRolePermissions(undefined)).toEqual([]);
	});

	it("gives owner everything and user only self-service scopes", () => {
		expect(resolveRolePermissions("owner").length).toBe(PERMISSIONS.length);
		const user = resolveRolePermissions("user");
		expect(user).toContain("voicemail.read.own");
		expect(user).not.toContain("trunks.write");
	});
});

describe("roleLabel", () => {
	it("uses the template label, falls back to the raw role, and names the empty case", () => {
		expect(roleLabel("manager")).toBe("Manager");
		expect(roleLabel("something-else")).toBe("something-else");
		expect(roleLabel(null)).toBe("No role");
	});
});
