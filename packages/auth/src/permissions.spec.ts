import { describe, expect, it } from "bun:test";
import {
	buildAccessControlStatements,
	getSystemRoleTemplate,
	hasPermission,
	isPermission,
	parsePermission,
	type Permission,
	PERMISSION_CATALOG,
	PERMISSION_PATTERN,
	PERMISSION_SCOPES,
	PERMISSIONS,
	SYSTEM_ROLE_IDS,
	SYSTEM_ROLE_TEMPLATES,
	type SystemRoleId,
	type SystemRoleTemplate,
	UnknownPermissionError,
} from "./permissions";

describe("PERMISSIONS", () => {
	/**
	 * The registry is at **91 of 91** as of the audit-log read surface.
	 *
	 * The ceiling was raised by one, in the change that needed it, for `audit.read` — and the
	 * argument the previous note asked for is this: the `audit_log` ledger records every change
	 * every member made, with the before/after diff of each. The only existing grant broad enough
	 * to have covered it was `settings.read`, which every self-service role holds so that a user's
	 * own preferences screen renders. Reusing it would have handed the organization's entire
	 * change history to the narrowest role in the registry — the opposite of a boundary. No other
	 * grant expresses "may read what everyone else did", so the registry gained one.
	 *
	 * It gained exactly one: the table is append-only in the database (the tenant role holds
	 * `SELECT, INSERT` and nothing more), so there is no write, delete or retention action left
	 * for a second permission to guard.
	 *
	 * That is deliberate, not an accident of arriving last. The carrier integration needed exactly
	 * one new grant — `numbers.order`, which is the only carrier operation whose blast radius
	 * (spending the organization's money on a recurring commitment) is not already covered by an
	 * existing one. Release rides `numbers.delete`, because a role that can delete the row but not
	 * release the number upstream would orphan DIDs at the carrier and bill for them forever; trunk
	 * provisioning rides `trunks.write`, because "change how this organization reaches the PSTN" is
	 * already what that permission means.
	 *
	 * The ceiling itself is not arbitrary — it is the argument that FusionPBX's ~940 field-level
	 * permissions were unusable and that a model an admin can actually reason about has to fit on a
	 * page. So the next feature that wants a permission should first spend the effort we spent
	 * here: prove the existing grants cannot express the boundary. If it genuinely cannot, raise
	 * this number in the same change and say why, rather than deleting the assertion.
	 */
	/**
	 * Raised from 91 to 93 by the security floor, with the effort the comment above demands spent
	 * first.
	 *
	 * `sip_acl_entry` gained a CRUD surface and the SIP edge gained an authentication-failure
	 * ledger, and neither could ride an existing grant. `settings.write` was the candidate and it
	 * is the wrong one twice over: it is held by roles that manage preferences, while the thing
	 * being granted is the ability to open the platform's SIP surface to an arbitrary network —
	 * the same blast radius as issuing credentials — and `settings.read` is held by EVERY
	 * self-service role, which would publish the perimeter and the attack log to every user in the
	 * organization. `provisioning.*` guards the phone-config surface and not the SIP edge;
	 * `secrets.*` is about credential material, not about who may reach the authenticator.
	 *
	 * Two, then, and not the four that were drafted: no `security.delete` (disabling and deleting a
	 * rule are the same act) and no separate attack-log read (same audience, same incident, and a
	 * role that sees refusals but not the rule causing them cannot finish the investigation). Both
	 * arguments are recorded beside the entries in `permissions.ts`.
	 */
	/**
	 * Raised from 93 to 96 by the integrator surface — `calls.originate`, `webhooks.read` and
	 * `webhooks.write` — with the effort every note above demands spent first.
	 *
	 * The platform had no way for anything outside it to make a call happen or to be told that one
	 * did. Both halves of closing that are WRITES with blast radii nothing in the registry covers.
	 *
	 * `calls.originate` is one entry against a resource that did not exist. The two candidates to
	 * ride were `extensions.write` and `cdr.read`, and both are the wrong shape: the first is
	 * configuration — it changes what an extension IS — while this rings a phone and, off-net, spends
	 * the organization's money at whatever rate the key-holder chooses; the second is a read of what
	 * already happened, which is the argument `live-topics.ts` used to put the LIVE call feed on
	 * `cdr.read` and which does not extend to causing a call. The precedent is exact: `numbers.order`
	 * was carved out of `numbers.write` for the identical "this one spends money" reason.
	 *
	 * It is one and not four. `calls.hangup`, `calls.transfer` and `calls.monitor` were all drafted
	 * and all dropped, because none of them has a surface: mid-call control is not exposed over HTTP,
	 * and the live feed already rides `cdr.read` by a recorded decision. A permission guarding
	 * nothing is documentation charged to this ceiling.
	 *
	 * `webhooks.*` is two, shaped exactly like `security.*` and by the same argument. `settings.*`
	 * was the candidate and fails the same way twice: `settings.write` is held by the roles that
	 * manage ordinary configuration, and what is being granted is the ability to point a copy of
	 * every call event in the organization at an arbitrary URL — an exfiltration primitive, not a
	 * preference. There is no `webhooks.delete`, because deleting and disabling a subscription stop
	 * the same deliveries and leave nothing behind (the argument `security.delete` lost), and no
	 * separate grant for delivery history, because there is no delivery log to read.
	 *
	 * The instruction the ceiling carries stands unchanged for the next feature: prove the existing
	 * grants cannot express the boundary, raise this number in the same change, and say why.
	 */
	it("stays within the size the collapsed FusionPBX model targets", () => {
		expect(PERMISSIONS.length).toBeGreaterThanOrEqual(60);
		expect(PERMISSIONS.length).toBeLessThanOrEqual(96);
	});

	it("contains no duplicates", () => {
		expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
	});

	it.each([...PERMISSIONS])("matches the dotted permission grammar: %s", (permission) => {
		expect(permission).toMatch(PERMISSION_PATTERN);
	});

	it("only uses scopes from the closed scope set", () => {
		for (const permission of PERMISSIONS) {
			const segments = permission.split(".");
			expect(segments.length).toBeLessThanOrEqual(3);
			if (segments.length === 3) {
				expect(PERMISSION_SCOPES).toContain(segments[2] as never);
			}
		}
	});

	it("keeps every scoped permission paired with an organization-wide counterpart", () => {
		const flat = new Set<string>(PERMISSIONS);
		for (const permission of PERMISSIONS) {
			const segments = permission.split(".");
			if (segments.length === 3) {
				expect(flat.has(`${segments[0]}.${segments[1]}`)).toBe(true);
			}
		}
	});

	it("covers every resource named in the PBX domain inventory", () => {
		const resources = new Set(PERMISSIONS.map((permission) => permission.split(".")[0]));

		for (const resource of [
			"extensions",
			"devices",
			"numbers",
			"trunks",
			"routes",
			"time-conditions",
			"feature-codes",
			"ivr",
			"ring-groups",
			"queues",
			"voicemail",
			"conferences",
			"park-lots",
			"recordings",
			"cdr",
			"audit",
			"security",
			"settings",
			"members",
			"api-keys",
			"provisioning",
			"applications",
			"secrets",
		]) {
			expect(resources).toContain(resource);
		}
	});

	/**
	 * Every CRUD surface `apps/api/src/pbx` exposes must own a read/write/delete trio.
	 *
	 * Three of them borrowed `routes.*` while the registry had no entry of their own, which made
	 * "can edit a dial pattern" and "can move the holiday schedule" the same grant. Naming them is
	 * the fix, and this test is what stops the next slice from borrowing again.
	 */
	it("gives every PBX CRUD resource its own read/write/delete trio", () => {
		const flat = new Set<string>(PERMISSIONS);
		for (const resource of [
			"extensions",
			"devices",
			"numbers",
			"trunks",
			"routes",
			"time-conditions",
			"feature-codes",
			"ring-groups",
			"queues",
			"conferences",
			"park-lots",
		]) {
			for (const action of ["read", "write", "delete"]) {
				expect(flat.has(`${resource}.${action}`)).toBe(true);
			}
		}
	});

	it("recognises registered permissions and rejects anything else", () => {
		expect(isPermission("extensions.read")).toBe(true);
		expect(isPermission("extensions.explode")).toBe(false);
		expect(isPermission("")).toBe(false);
	});
});

describe("PERMISSION_CATALOG", () => {
	const catalogued = PERMISSION_CATALOG.flatMap((group) =>
		group.permissions.map((descriptor) => descriptor.permission),
	);

	it("covers every permission exactly once", () => {
		expect([...catalogued].sort()).toEqual([...PERMISSIONS].sort());
	});

	it("groups each permission under its own resource", () => {
		for (const group of PERMISSION_CATALOG) {
			for (const descriptor of group.permissions) {
				expect(descriptor.permission.startsWith(`${group.resource}.`)).toBe(true);
			}
		}
	});

	it("labels and describes every group and permission", () => {
		for (const group of PERMISSION_CATALOG) {
			expect(group.label.length).toBeGreaterThan(0);
			expect(group.description.length).toBeGreaterThan(0);
			for (const descriptor of group.permissions) {
				expect(descriptor.label.length).toBeGreaterThan(0);
				expect(descriptor.description.length).toBeGreaterThan(0);
			}
		}
	});

	it("declares each resource group once", () => {
		const resources = PERMISSION_CATALOG.map((group) => group.resource);
		expect(new Set(resources).size).toBe(resources.length);
	});
});

const roleTemplateCases: [SystemRoleId, SystemRoleTemplate][] = SYSTEM_ROLE_TEMPLATES.map(
	(template) => [template.id, template],
);

describe("SYSTEM_ROLE_TEMPLATES", () => {
	it("defines exactly the advertised role ids", () => {
		expect(SYSTEM_ROLE_TEMPLATES.map((template) => template.id).sort()).toEqual(
			[...SYSTEM_ROLE_IDS].sort(),
		);
	});

	it.each(roleTemplateCases)("only references registered permissions: %s", (_id, template) => {
		for (const permission of template.permissions) {
			expect(isPermission(permission)).toBe(true);
		}
	});

	it.each(roleTemplateCases)("grants no permission twice: %s", (_id, template) => {
		expect(new Set(template.permissions).size).toBe(template.permissions.length);
	});

	it("gives the owner every permission", () => {
		expect(new Set(getSystemRoleTemplate("owner").permissions).size).toBe(PERMISSIONS.length);
	});

	it("withholds the cross-organization scope from everyone but the owner", () => {
		for (const template of SYSTEM_ROLE_TEMPLATES) {
			if (template.id === "owner") continue;
			expect(template.permissions).not.toContain("settings.write.all" as Permission);
		}
	});

	it("keeps carrier, secret and provisioning-credential access out of non-admin roles", () => {
		const restricted: Permission[] = [
			"trunks.write",
			"secrets.read",
			"secrets.rotate",
			"provisioning.tokens",
		];
		for (const template of SYSTEM_ROLE_TEMPLATES) {
			if (template.id === "owner" || template.id === "admin") continue;
			for (const permission of restricted) {
				expect(template.permissions).not.toContain(permission);
			}
		}
	});

	it("gives end-user roles only own-scoped or read-only permissions", () => {
		for (const roleId of ["user", "agent"] as const) {
			for (const permission of getSystemRoleTemplate(roleId).permissions) {
				const { action, scope } = parsePermission(permission);
				expect(scope === "own" || action === "read" || action === "monitor").toBe(true);
			}
		}
	});

	it("maps every template onto a better-auth membership role", () => {
		for (const template of SYSTEM_ROLE_TEMPLATES) {
			expect(["owner", "admin", "member"]).toContain(template.membershipRole);
		}
	});

	it("nests the role ladder so a broader role never loses a narrower role's grants", () => {
		const user = new Set<string>(getSystemRoleTemplate("user").permissions);
		const agent = new Set<string>(getSystemRoleTemplate("agent").permissions);
		const manager = new Set<string>(getSystemRoleTemplate("manager").permissions);
		const admin = new Set<string>(getSystemRoleTemplate("admin").permissions);

		for (const permission of user) expect(agent.has(permission)).toBe(true);
		for (const permission of agent) expect(manager.has(permission)).toBe(true);
		for (const permission of manager) expect(admin.has(permission)).toBe(true);
	});

	/**
	 * A manager runs the phone system day to day, so every telephony CRUD surface has to be
	 * reachable from that role — otherwise the screens exist and the role that is supposed to use
	 * them 403s.
	 */
	it("lets a manager write every telephony resource the admin UI exposes", () => {
		const manager = new Set<string>(getSystemRoleTemplate("manager").permissions);
		for (const permission of [
			"time-conditions.write",
			"feature-codes.write",
			"queues.write",
			"conferences.write",
			"park-lots.write",
			"ring-groups.write",
			"ivr.write",
		] as Permission[]) {
			expect(manager.has(permission)).toBe(true);
		}
	});

	/** Deleting telephony configuration stays with an administrator. */
	it("withholds delete on the new telephony resources from a manager", () => {
		const manager = new Set<string>(getSystemRoleTemplate("manager").permissions);
		for (const permission of [
			"time-conditions.delete",
			"feature-codes.delete",
			"park-lots.delete",
		] as Permission[]) {
			expect(manager.has(permission)).toBe(false);
		}
	});

	it("throws for an unknown role id", () => {
		expect(() => getSystemRoleTemplate("root" as never)).toThrow(UnknownPermissionError);
	});
});

describe("parsePermission", () => {
	it("splits resource, action and scope", () => {
		expect(parsePermission("extensions.read")).toEqual({
			resource: "extensions",
			action: "read",
		});
		expect(parsePermission("voicemail.listen.own")).toEqual({
			resource: "voicemail",
			action: "listen",
			scope: "own",
		});
		expect(parsePermission("queues.manage-agents")).toEqual({
			resource: "queues",
			action: "manage-agents",
		});
	});

	it("rejects an unregistered permission", () => {
		expect(() => parsePermission("extensions.explode")).toThrow(UnknownPermissionError);
	});
});

describe("buildAccessControlStatements", () => {
	it("reshapes the registry into resource -> actions", () => {
		const statements = buildAccessControlStatements();

		expect(statements.extensions).toContain("read");
		expect(statements.extensions).toContain("read.own");
		expect(statements["ring-groups"]).toEqual(["read", "write", "delete"]);
	});

	it("emits one entry per catalogued resource", () => {
		expect(Object.keys(buildAccessControlStatements()).sort()).toEqual(
			PERMISSION_CATALOG.map((group) => group.resource).sort(),
		);
	});

	it("round-trips every permission", () => {
		const statements = buildAccessControlStatements();
		const rebuilt = Object.entries(statements).flatMap(([resource, actions]) =>
			actions.map((action) => `${resource}.${action}`),
		);

		expect(rebuilt.sort()).toEqual([...PERMISSIONS].sort());
	});
});

describe("hasPermission", () => {
	it("matches an exact grant", () => {
		expect(hasPermission(["extensions.read"], "extensions.read")).toBe(true);
	});

	it("lets an organization-wide grant satisfy its own-scoped variant", () => {
		expect(hasPermission(["voicemail.listen"], "voicemail.listen.own")).toBe(true);
	});

	it("does not let an own-scoped grant satisfy the organization-wide permission", () => {
		expect(hasPermission(["voicemail.listen.own"], "voicemail.listen")).toBe(false);
	});

	it("returns false for an empty grant set", () => {
		expect(hasPermission([], "extensions.read")).toBe(false);
	});

	it("rejects an unregistered requirement", () => {
		expect(() => hasPermission(["extensions.read"], "extensions.explode" as Permission)).toThrow(
			UnknownPermissionError,
		);
	});
});
