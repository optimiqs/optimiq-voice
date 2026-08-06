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
