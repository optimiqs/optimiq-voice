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
		expect(canAccessPage(routes.members, manager)).toBe(true);
		expect(canAccessPage(routes.trunks, manager)).toBe(false);
	});

	it("allows any route it has no opinion about", () => {
		expect(canAccessPage("/some/future/route", [])).toBe(true);
	});
});
