import { describe, expect, it } from "bun:test";
import { canAccessPage, getPagePermissions, matchesPathPattern } from "./page-permissions";
import { resolveRolePermissions } from "./permissions";
import { routes } from "./routes";

describe("matchesPathPattern", () => {
	it("matches exactly, and treats a [param] segment as a wildcard", () => {
		expect(matchesPathPattern("/extensions", "/extensions")).toBe(true);
		expect(matchesPathPattern("/extensions/42", "/extensions/[id]")).toBe(true);
		expect(matchesPathPattern("/extensions", "/extensions/[id]")).toBe(false);
		expect(matchesPathPattern("/extensions/42/lines", "/extensions/[id]")).toBe(false);
	});
});

describe("getPagePermissions", () => {
	it("returns nothing for a route that only needs a session", () => {
		expect(getPagePermissions(routes.overview)).toBeUndefined();
	});

	/**
	 * A nested view must never be less protected than the page it lives under — an exact-match
	 * lookup would quietly leave `/settings/members/pending` open to anyone with a session.
	 */
	it("inherits the nearest declared ancestor", () => {
		expect(getPagePermissions("/settings/members/pending")?.permissions).toEqual(["members.read"]);
	});

	it("prefers the most specific ancestor", () => {
		// `/settings/members` is longer than `/settings`, so members.read wins over settings.read.
		expect(getPagePermissions(routes.members)?.permissions).toEqual(["members.read"]);
	});

	it("ignores a trailing slash", () => {
		expect(getPagePermissions("/extensions/")?.permissions).toEqual([
			"extensions.read",
			"extensions.read.own",
		]);
	});
});

describe("canAccessPage", () => {
	it("lets an owner reach every declared route", () => {
		const owner = resolveRolePermissions("owner");
		for (const url of Object.values(routes)) {
			if (typeof url === "string") {
				expect(canAccessPage(url, owner)).toBe(true);
			}
		}
	});

	it("gives a plain user their own surfaces and nothing else", () => {
		const user = resolveRolePermissions("user");
		expect(canAccessPage(routes.extensions, user)).toBe(true);
		expect(canAccessPage(routes.voicemail, user)).toBe(true);
		expect(canAccessPage(routes.settings, user)).toBe(true);
		expect(canAccessPage(routes.trunks, user)).toBe(false);
		expect(canAccessPage(routes.members, user)).toBe(false);
	});

	it("gives a manager the operational surfaces but not carrier or key management", () => {
		const manager = resolveRolePermissions("manager");
		expect(canAccessPage(routes.ivr, manager)).toBe(true);
		expect(canAccessPage(routes.queues, manager)).toBe(true);
		expect(canAccessPage(routes.parkLots, manager)).toBe(true);
		expect(canAccessPage(routes.members, manager)).toBe(true);
		expect(canAccessPage(routes.trunks, manager)).toBe(false);
	});

	/**
	 * An agent parks calls with `*5`, so the lot list has to be readable to render where a call went
	 * — `park-lots.read` is in the agent template for exactly that reason. Gating the page on
	 * `park-lots.write` instead would hide it from everyone whose job is to use it.
	 */
	it("lets an agent read the queue and park-lot surfaces without being able to change them", () => {
		const agent = resolveRolePermissions("agent");
		expect(canAccessPage(routes.queues, agent)).toBe(true);
		expect(canAccessPage(routes.parkLots, agent)).toBe(true);
		expect(canAccessPage(routes.conferences, agent)).toBe(true);
		expect(agent.includes("queues.write")).toBe(false);
		expect(agent.includes("queues.manage-agents")).toBe(false);
		expect(agent.includes("park-lots.write")).toBe(false);
	});

	/**
	 * A detail view can never be less protected than its list. `/queues/<id>` is not in the map at
	 * all — it inherits `queues.read` from `/queues` by ancestry, which is why nesting it under the
	 * list's path is a decision rather than a convention.
	 */
	it("inherits the queue list's requirement for a queue's detail view", () => {
		expect(getPagePermissions(routes.queue("0193f2aa-0000-7000-8000-000000000001"))).toEqual({
			permissions: ["queues.read"],
		});
		expect(canAccessPage(routes.queue("abc"), resolveRolePermissions("user"))).toBe(false);
		expect(canAccessPage(routes.queue("abc"), resolveRolePermissions("agent"))).toBe(true);
	});

	it("allows any route it has no opinion about", () => {
		expect(canAccessPage("/some/future/route", [])).toBe(true);
	});
});

/**
 * The two settings-cascade screens.
 *
 * Both read `GET …/org-settings/categories/:category`, which `OrgSettingsController` guards with
 * `settings.read`, and both save through a `PATCH` guarded with `settings.write`. This map's whole
 * job is to say what the API says — the failure it exists to prevent is a nav tab that is visible
 * and a page that 403s.
 */
describe("the settings cascade screens", () => {
	it("gates both categories on settings.read", () => {
		expect(getPagePermissions(routes.notifications)?.permissions).toEqual(["settings.read"]);
		expect(getPagePermissions(routes.routingSettings)?.permissions).toEqual(["settings.read"]);
	});

	/**
	 * NOT `routes.read`. A caller with `routes.read` and no settings grant can edit inbound routes
	 * all day and still cannot read this category, so naming `routes.read` here would show them a
	 * tab the API refuses.
	 */
	it("does not borrow the routing page's permissions", () => {
		expect(getPagePermissions(routes.routing)?.permissions).not.toEqual(
			getPagePermissions(routes.routingSettings)?.permissions,
		);
	});

	/**
	 * The read/write split is deliberate: a role that can see the organization's policy but not
	 * change it should SEE it, read-only, rather than be told the page does not exist. The page
	 * gates saving with `RequirePermission permissions={["settings.write"]}`.
	 */
	it("lets a plain user read them and an owner write them", () => {
		const user = resolveRolePermissions("user");
		const owner = resolveRolePermissions("owner");
		expect(canAccessPage(routes.routingSettings, user)).toBe(true);
		expect(user.includes("settings.write")).toBe(false);
		expect(canAccessPage(routes.routingSettings, owner)).toBe(true);
		expect(owner.includes("settings.write")).toBe(true);
	});

	it("refuses a caller with no settings grant at all", () => {
		expect(canAccessPage(routes.routingSettings, ["routes.read", "routes.publish"])).toBe(false);
	});

	/**
	 * The recordings category reads on `settings.read` and writes on `recordings.configure`.
	 *
	 * `CATEGORY_PERMISSIONS` on the server puts the override on the WRITE alone, on the argument
	 * that a screen which cannot show the current window cannot explain what the narrower grant
	 * would change. So the page must be reachable for a role that holds only the read — the manager
	 * template is exactly that role, and the assertion is what stops somebody "tightening" this
	 * entry to `recordings.configure` and hiding the policy from everyone who cannot change it.
	 */
	it("opens the recording policy for a role that may read settings and not configure recordings", () => {
		const manager = resolveRolePermissions("manager");
		expect(getPagePermissions(routes.recordingSettings)?.permissions).toEqual(["settings.read"]);
		expect(canAccessPage(routes.recordingSettings, manager)).toBe(true);
		expect(manager.includes("recordings.configure")).toBe(false);
	});
});

/**
 * The user level of the cascade — the one page under `/settings` a self-service role can open.
 */
describe("my preferences", () => {
	/**
	 * `settings.read.own`, which is exactly what `GET /org-settings/me` is guarded with.
	 *
	 * The direction of `hasPermission` is what makes the choice safe rather than merely tidy: an
	 * UNSCOPED grant covers its scopes, so an administrator holding `settings.read` reaches this
	 * page too and nothing is hidden from them — while a scoped grant never covers the unscoped
	 * requirement, so naming `settings.read` here would shut out a role that holds only the personal
	 * one. The narrower requirement is therefore strictly more permissive in practice, which is the
	 * opposite of how it reads and the reason it is asserted.
	 */
	it("is gated on settings.read.own, which the organization read also satisfies", () => {
		expect(getPagePermissions(routes.mySettings)?.permissions).toEqual(["settings.read.own"]);
		expect(canAccessPage(routes.mySettings, ["settings.read.own"])).toBe(true);
		expect(canAccessPage(routes.mySettings, ["settings.read"])).toBe(true);
		// …and the reverse does not hold, which is why this entry cannot say `settings.read`.
		expect(canAccessPage(routes.settings, ["settings.read.own"])).toBe(false);
		expect(canAccessPage(routes.mySettings, ["cdr.read"])).toBe(false);
	});

	/** Every role that manages nothing still gets its own preferences, which is the point of it. */
	it("is reachable by a plain user, who can also write it", () => {
		const user = resolveRolePermissions("user");
		expect(canAccessPage(routes.mySettings, user)).toBe(true);
		expect(user.includes("settings.write.own")).toBe(true);
	});
});

/**
 * Caller screening, gated by its own resource rather than by the dial plan's.
 *
 * The whole reason `call-block.*` exists as a separate resource is that a receptionist maintaining
 * a blocklist should not need `routes.write`. These assertions hold the map to that: the manager
 * template carries `call-block.read` and `call-block.write` and NOT `call-block.delete`, which is
 * the split the API made because disabling a rule keeps its match history and deleting it destroys
 * that.
 */
describe("call blocking", () => {
	it("is gated on call-block.read alone", () => {
		expect(getPagePermissions(routes.callBlock)?.permissions).toEqual(["call-block.read"]);
		expect(canAccessPage(routes.callBlock, ["call-block.read"])).toBe(true);
		expect(canAccessPage(routes.callBlock, ["routes.read", "routes.write"])).toBe(false);
	});

	it("opens for a manager, who may write a rule but not delete one", () => {
		const manager = resolveRolePermissions("manager");
		expect(canAccessPage(routes.callBlock, manager)).toBe(true);
		expect(manager.includes("call-block.write")).toBe(true);
		expect(manager.includes("call-block.delete")).toBe(false);
	});

	/** A plain user has no screening grant at all, so the nav entry is not shown to them either. */
	it("is closed to a plain user", () => {
		expect(canAccessPage(routes.callBlock, resolveRolePermissions("user"))).toBe(false);
	});
});

/**
 * The T2 admin block's four surfaces, whose permissions diverge more than any other group in this
 * map — which is exactly why each one is asserted rather than left to the owner loop.
 */
describe("the T2 admin block", () => {
	/**
	 * Call flows open for `call-flows.read` and nothing else, and the split that matters is INSIDE
	 * the page: the receptionist template holds `read` and `toggle` and neither `write` nor
	 * `delete`, so this page has to be reachable by somebody who can move the switch and cannot
	 * re-point either branch. Gating it on `call-flows.write` would hide the feature from the only
	 * person who uses it daily.
	 */
	it("opens call flows for a role that may toggle but not edit", () => {
		expect(getPagePermissions(routes.callFlows)?.permissions).toEqual(["call-flows.read"]);
		expect(canAccessPage(routes.callFlows, ["call-flows.read", "call-flows.toggle"])).toBe(true);
		expect(canAccessPage(routes.callFlows, ["routes.read"])).toBe(false);
	});

	/**
	 * The authorisation codes, and their nested detail view.
	 *
	 * `pin-sets.read` is a real grant despite there being no secret to read — what a reader sees is
	 * which routes are gated and by whose codes. The detail view carries no entry of its own and
	 * inherits by ancestry, which is what makes nesting it under the list a decision rather than a
	 * convention.
	 */
	it("gates the PIN sets and inherits that for one set's codes", () => {
		expect(getPagePermissions(routes.pinSets)?.permissions).toEqual(["pin-sets.read"]);
		expect(getPagePermissions(routes.pinSet("0193f2aa"))?.permissions).toEqual(["pin-sets.read"]);
		expect(canAccessPage(routes.pinSet("0193f2aa"), ["pin-sets.read"])).toBe(true);
		expect(canAccessPage(routes.pinSet("0193f2aa"), ["routes.read", "dial-plan.read"])).toBe(false);
	});

	/**
	 * One entry for four tabs, which is only legal because the API guards all four collections with
	 * the same grant. Number translations are deliberately not on this page — they ride `routes.*` —
	 * so a caller holding `dial-plan.read` and nothing else opens this page and NOT the routing one.
	 */
	it("gates the four dial-plan tables on one grant, which translations do not share", () => {
		expect(getPagePermissions(routes.dialPlan)?.permissions).toEqual(["dial-plan.read"]);
		expect(canAccessPage(routes.dialPlan, ["dial-plan.read"])).toBe(true);
		expect(canAccessPage(routes.routing, ["dial-plan.read"])).toBe(false);
		expect(canAccessPage(routes.dialPlan, ["routes.read"])).toBe(false);
	});

	/**
	 * A ruleset's rules live under `/routing`, so they inherit `routes.read` by ancestry — which is
	 * the correct requirement here rather than a convenient one: the server guards a ruleset with
	 * `routes.*` precisely because it is only meaningful attached to a route or a trunk.
	 */
	it("inherits the routing page's requirement for a ruleset's rules", () => {
		expect(getPagePermissions(routes.translationRuleset("0193f2aa"))?.permissions).toEqual([
			"routes.read",
			"time-conditions.read",
			"feature-codes.read",
		]);
	});

	/**
	 * The quotas, and the widest divergence between a permission and its neighbours in the settings
	 * area — which is the API's, not this map's.
	 *
	 * `org-limits.read` is deliberately wide because the usage screen is a SUPPORT tool: "you are at
	 * 48 of 50 extensions" is the answer to a ticket. Naming `settings.read` here would show the tab
	 * to every self-service role — all of them hold it so a preferences screen renders — and 403
	 * them. The write is `owner`-only and is gated inside the page, so a manager sees the ceilings
	 * read-only rather than being told the page does not exist.
	 */
	it("gates the limits on their own read grant, not on settings.read", () => {
		expect(getPagePermissions(routes.limits)?.permissions).toEqual(["org-limits.read"]);

		const user = resolveRolePermissions("user");
		expect(user.includes("settings.read")).toBe(true);
		expect(canAccessPage(routes.limits, user)).toBe(false);

		const manager = resolveRolePermissions("manager");
		expect(canAccessPage(routes.limits, manager)).toBe(true);
		expect(manager.includes("org-limits.write")).toBe(false);

		const owner = resolveRolePermissions("owner");
		expect(owner.includes("org-limits.write")).toBe(true);
	});
});

/**
 * The wallboard and, by ancestry, each queue's operator panel.
 *
 * The placement decision this map records: a monitoring surface is gated by `queues.monitor`, which
 * is neither the grant that reads a queue's configuration nor the one that reads the call ledger.
 * Both other candidates are asserted against, because both are plausible and both are wrong in a
 * direction that costs somebody something — `queues.read` would shut out nobody today but would tie
 * the page to configuration access, and `cdr.read` would hand a supervisor's SLA row the right to
 * read every call the tenant ever made.
 */
describe("the wallboard", () => {
	it("is gated on queues.monitor alone", () => {
		expect(getPagePermissions(routes.wallboard)?.permissions).toEqual(["queues.monitor"]);
		expect(canAccessPage(routes.wallboard, ["queues.monitor"])).toBe(true);
		expect(canAccessPage(routes.wallboard, ["queues.read", "queues.write"])).toBe(false);
		expect(canAccessPage(routes.wallboard, ["cdr.read"])).toBe(false);
	});

	/**
	 * The operator panel has no entry of its own and must not need one: it is nested under the
	 * wallboard precisely so it inherits the same grant, and a nested view that was reachable with
	 * LESS than its parent is the failure an exact-match lookup quietly allows.
	 */
	it("carries its permission down to one queue's operator panel", () => {
		const panel = routes.wallboardQueue("019fd5fb-de54-700b-8826-8cf8ab5199af");

		expect(getPagePermissions(panel)?.permissions).toEqual(["queues.monitor"]);
		expect(canAccessPage(panel, ["queues.monitor"])).toBe(true);
		expect(canAccessPage(panel, [])).toBe(false);
	});

	/**
	 * The role this placement is FOR. An agent holds `queues.monitor` and it opens nothing else in
	 * the app — watching their own queue is the point of a wallboard — while acting on what they see
	 * needs `queues.manage-agents`, which the template does not grant and which the page gates
	 * internally rather than at the door.
	 */
	it("opens for an agent, who may watch the floor and not staff it", () => {
		const agent = resolveRolePermissions("agent");

		expect(canAccessPage(routes.wallboard, agent)).toBe(true);
		expect(agent.includes("queues.monitor")).toBe(true);
		expect(agent.includes("queues.manage-agents")).toBe(false);
	});

	/** A plain user has no queue grant at all, so the nav entry is not shown to them either. */
	it("is closed to a plain user", () => {
		expect(canAccessPage(routes.wallboard, resolveRolePermissions("user"))).toBe(false);
	});
});
