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
	RETIRED_PERMISSIONS,
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
	/**
	 * Raised from 96 to 97 by supervision — `calls.supervise` — with the proof the instruction above
	 * demands, and it is the least arguable one this registry has recorded.
	 *
	 * Every other grant in the registry is a power over CONFIGURATION or over RECORDS. This is a
	 * power over a PERSON: it lets one member listen to another member's live conversation with an
	 * outside party while it is happening, and tells neither of them. No existing grant expresses
	 * that, and the two that were drafted to carry it are both actively wrong:
	 *
	 * `queues.monitor` is the wallboard — aggregate depth, agent states, longest wait — and it is
	 * deliberately an AGENT-level grant, because an agent who cannot see their own queue cannot work
	 * it. Riding supervision on it would give every agent in every tenant the ability to listen to
	 * every other agent, through a permission granted so a number could render on a screen.
	 *
	 * `recordings.listen` is after the fact, and — more to the point — a recording is an ARTEFACT the
	 * subject can discover: it has a row, it is announced by the tenant's recording policy, and it
	 * can be asked for. A monitor session leaves the subject nothing at all. That is the difference
	 * the registry had no way to say before this entry.
	 *
	 * ONE and not three. `calls.whisper` and `calls.barge` were drafted and dropped: a monitor
	 * session is a media tap that is already attached, so the holder moves between the three modes
	 * by pressing a digit. A permission a holder escalates past by pressing `2` is a distinction a
	 * reviewer cannot act on, and the consent boundary is crossed by the first mode anyway. It is the
	 * same argument `security.delete` and `webhooks.delete` lost.
	 *
	 * The instruction stands unchanged for whatever comes next.
	 */
	/**
	 * And 97 to 100 by paging groups — `paging-groups.read` / `.write` / `.delete`.
	 *
	 * Recorded honestly: those three arrived in the same wave as `calls.supervise` but from the
	 * paging work, not from this one, so the argument for them belongs beside their entries in
	 * `permissions.ts` and beside the resource they guard. What is asserted here is only the budget.
	 *
	 * The budget spends easily on this one. A paging group is a CRUD resource with a table, a
	 * controller and a delete that destroys configuration somebody may need — the same shape as
	 * `ring-groups.*` sitting immediately above it in the registry, which is why the trio is a trio
	 * and why the test below ("gives every PBX CRUD resource its own read/write/delete trio") is the
	 * one that would have caught it borrowing `ring-groups.*` instead. Borrowing is what the trio
	 * test exists to stop: a ring group rings desks in turn and a paging group opens all of their
	 * speakers at once, and making "may edit a hunt group" and "may broadcast into every office"
	 * the same grant would be exactly the collapse this registry was built to undo.
	 *
	 * The instruction stands unchanged for whatever comes next.
	 */
	/**
	 * And 101 to 108 by the T2 admin block — the largest single wave the registry has taken, and the
	 * one where the ceiling did most of its work.
	 *
	 * Ten features arrived. A trio each would have been thirty permissions and would have put the
	 * registry back inside sight of the ~940-entry model it replaced, so the budget was spent by
	 * asking of each feature whether it has a power profile of its own:
	 *
	 * - `call-flows.*` (4) — a resource, plus a `toggle` that is genuinely a different job from
	 *   `write`. The toggle also gates the time-condition override, because forcing a condition open
	 *   and flipping a flow to night are one act on two tables.
	 * - `pin-sets.*` (3) — a resource, because the blast radius is money. The same argument
	 *   `numbers.order` and `calls.originate` each made.
	 * - `dial-plan.*` (3) — FOUR tables under one resource (aliases, streams, speed dials,
	 *   directories), because no role plausibly edits one and not the others.
	 * - `org-limits.*` (2) — read wide, write owner-only, and honestly in the wrong place until W14.
	 *
	 * And three features spent nothing at all: number translations ride `routes.*` (they only exist
	 * attached to a route or a trunk, and their power is a route's power), phrases ride
	 * `recordings.*` (a phrase IS a prompt row), and the time-condition override rides
	 * `call-flows.toggle` as above.
	 *
	 * The ceiling moves from 100 to 112 rather than to 108: a wave that lands exactly on the ceiling
	 * has not been budgeted, it has been rounded to. Four spare is what the previous ceiling left and
	 * is what this one leaves.
	 *
	 * The instruction stands unchanged for whatever comes next.
	 */
	it("stays within the size the collapsed FusionPBX model targets", () => {
		expect(PERMISSIONS.length).toBeGreaterThanOrEqual(60);
		expect(PERMISSIONS.length).toBeLessThanOrEqual(112);
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
			"paging-groups",
			"call-flows",
			"pin-sets",
			"dial-plan",
			"org-limits",
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
			"call-block",
		]) {
			expect(resources).toContain(resource);
		}
	});

	/**
	 * The retired entries stay retired until the endpoint they describe arrives with them.
	 *
	 * `applications` and `secrets` used to be in the inventory above, which is why this test is
	 * the shape it is rather than a shorter one: they were removed from the list of resources this
	 * registry must cover in the same change that removed the permissions, and a list that only
	 * says what must be present cannot say that. `RETIRED_PERMISSIONS` carries the reason for each
	 * one; this asserts the reason is still being honoured.
	 *
	 * A re-added entry is not a failure of judgement, it is a failure of SEQUENCING: the rule the
	 * registry header states is that a permission and the `@RequirePermissions` that checks it land
	 * together. Bringing one back means deleting it from `RETIRED_PERMISSIONS` in the same commit
	 * that adds the guard, which is a diff a reviewer can see.
	 */
	it("does not re-declare a permission that was retired for guarding nothing", () => {
		const declared = new Set<string>(PERMISSIONS);
		for (const retired of RETIRED_PERMISSIONS) {
			expect(declared.has(retired), `${retired} is retired and must not be re-declared`).toBe(
				false,
			);
		}
	});

	it("retires nothing twice and names each retirement once", () => {
		expect(new Set(RETIRED_PERMISSIONS).size).toBe(RETIRED_PERMISSIONS.length);
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
			"paging-groups",
			"queues",
			"conferences",
			"park-lots",
			// The T2 admin block's three CRUD resources. `org-limits` is absent on purpose: there is
			// no delete, because a limit is cleared by nulling the column rather than by removing the
			// one row an organization has.
			"call-flows",
			"pin-sets",
			"dial-plan",
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

	/**
	 * The second owner-only grant, and the reason `ADMIN_PERMISSIONS` stopped being a one-exclusion
	 * filter.
	 *
	 * A quota an administrator can raise is not a quota. This is not a real control-plane boundary —
	 * an owner can still raise their own cap — and it is not pretending to be one; it is the narrowest
	 * boundary this model can express until the reseller hierarchy gives limits a platform-operator
	 * home. Asserted separately from `settings.write.all` so that a later wave moving it does so
	 * deliberately.
	 */
	it("withholds the limit-raising grant from everyone but the owner", () => {
		for (const template of SYSTEM_ROLE_TEMPLATES) {
			if (template.id === "owner") continue;
			expect(template.permissions).not.toContain("org-limits.write" as Permission);
		}
	});

	/**
	 * `secrets.read` and `secrets.rotate` used to head this list and have been retired — the table
	 * they guarded went with the legacy platform, so they checked nothing (see
	 * `RETIRED_PERMISSIONS`). What survives is the list's actual subject: the grants that reach a
	 * CREDENTIAL. `provisioning.tokens` issues the per-device secret a phone authenticates its
	 * config pull with, and `trunks.write` sets the carrier password's handle. Neither belongs to a
	 * role that runs the phone system day to day.
	 */
	it("keeps carrier and provisioning-credential access out of non-admin roles", () => {
		const restricted: Permission[] = ["trunks.write", "provisioning.tokens"];
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
			"paging-groups.write",
			"ivr.write",
			"call-flows.write",
			"dial-plan.write",
		] as Permission[]) {
			expect(manager.has(permission)).toBe(true);
		}
	});

	/**
	 * The supervision boundary, pinned where somebody widening a role will trip over it.
	 *
	 * `queues.monitor` and `calls.supervise` read like neighbours on a supervisor's screen and are
	 * not: the first is aggregate queue STATE and is an agent-level grant on purpose, the second is
	 * the audio of a live conversation neither party knows is being listened to. The defence for the
	 * second is an audit row that names one person, which stops being a defence the moment the grant
	 * reaches the broadest role an organization hands out. So the assertion is two-sided.
	 */
	it("keeps live-call supervision at manager and above while leaving the wallboard with agents", () => {
		const agent = new Set<string>(getSystemRoleTemplate("agent").permissions);
		const manager = new Set<string>(getSystemRoleTemplate("manager").permissions);

		expect(agent.has("queues.monitor")).toBe(true);
		expect(agent.has("calls.supervise")).toBe(false);
		expect(manager.has("calls.supervise")).toBe(true);
		expect(new Set<string>(getSystemRoleTemplate("user").permissions).has("calls.supervise")).toBe(
			false,
		);
	});

	/** Deleting telephony configuration stays with an administrator. */
	it("withholds delete on the new telephony resources from a manager", () => {
		const manager = new Set<string>(getSystemRoleTemplate("manager").permissions);
		for (const permission of [
			"time-conditions.delete",
			"feature-codes.delete",
			"park-lots.delete",
			"call-flows.delete",
			"dial-plan.delete",
			"pin-sets.delete",
			// Not a delete, and here anyway: adding a code to a PIN set decides who may spend the
			// tenant's money internationally, which is the same class of grant as `trunks.write`.
			"pin-sets.write",
			// The quota an administrator is not supposed to be able to raise. `owner` only.
			"org-limits.write",
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
