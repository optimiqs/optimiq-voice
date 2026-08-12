import { describe, expect, it } from "bun:test";
import {
	CONFERENCE_TABS,
	conferenceTabHref,
	DIAL_PLAN_TABS,
	dialPlanTabHref,
	isPublicRoute,
	queueTabHref,
	routes,
	ROUTING_TABS,
	routingTabHref,
	safeRedirectTarget,
	signInWithRedirect,
} from "./routes";

describe("isPublicRoute", () => {
	it("covers the auth screens and the invitation landing page", () => {
		expect(isPublicRoute(routes.signIn)).toBe(true);
		expect(isPublicRoute(routes.signUp)).toBe(true);
		expect(isPublicRoute("/accept-invitation/01936c7e-0000-7000-8000-000000000000")).toBe(true);
	});

	it("does not cover the application", () => {
		expect(isPublicRoute(routes.overview)).toBe(false);
		expect(isPublicRoute(routes.extensions)).toBe(false);
		expect(isPublicRoute(routes.members)).toBe(false);
	});

	/** A prefix match must respect segment boundaries or `/sign-in-secretly` becomes public. */
	it("does not treat a longer segment as a match", () => {
		expect(isPublicRoute("/sign-in-secretly")).toBe(false);
		expect(isPublicRoute("/sign-inx")).toBe(false);
	});
});

describe("safeRedirectTarget", () => {
	it("keeps a same-origin absolute path", () => {
		expect(safeRedirectTarget("/settings/members")).toBe("/settings/members");
	});

	/**
	 * Everything below is a real open-redirect vector: an absolute URL, the protocol-relative
	 * `//host` shorthand, a `javascript:` scheme, and the backslash Windows treats as a separator.
	 */
	it("rejects anything that could leave this origin", () => {
		expect(safeRedirectTarget("https://evil.example/steal")).toBe(routes.overview);
		expect(safeRedirectTarget("//evil.example/steal")).toBe(routes.overview);
		expect(safeRedirectTarget("javascript:alert(1)")).toBe(routes.overview);
		expect(safeRedirectTarget("/\\evil.example")).toBe(routes.overview);
		expect(safeRedirectTarget("settings")).toBe(routes.overview);
	});

	it("falls back for an absent value", () => {
		expect(safeRedirectTarget(null)).toBe(routes.overview);
		expect(safeRedirectTarget(undefined)).toBe(routes.overview);
		expect(safeRedirectTarget("")).toBe(routes.overview);
	});
});

describe("signInWithRedirect", () => {
	it("round-trips through safeRedirectTarget", () => {
		const url = signInWithRedirect("/settings/members?tab=pending");
		const target = new URLSearchParams(url.split("?")[1]).get("redirectTo");
		expect(safeRedirectTarget(target)).toBe("/settings/members?tab=pending");
	});

	it("omits the parameter when there is nothing worth returning to", () => {
		expect(signInWithRedirect(routes.overview)).toBe(routes.signIn);
		expect(signInWithRedirect(routes.signIn)).toBe(routes.signIn);
	});
});

describe("queueTabHref", () => {
	/**
	 * The default tab is the bare path, not `?tab=queues`. `nuqs` is configured with
	 * `clearOnDefault`, so a link carrying the default would be rewritten the moment the page loaded
	 * — leaving the user on a URL that differs from the one they were sent.
	 */
	it("leaves the default tab off the URL and names every other one", () => {
		expect(queueTabHref("queues")).toBe(routes.queues);
		expect(queueTabHref("agents")).toBe(`${routes.queues}?tab=agents`);
	});
});

describe("the settings area", () => {
	/**
	 * `/settings/routing` and `/routing` are different pages with different permissions — the first
	 * is the organization's compiled-against defaults (`settings.*`), the second is the four tabs of
	 * rows a call is matched against (`routes.*`). Nesting the settings one under `/settings` is
	 * what makes `getPagePermissions` inherit the right side of that split by ancestry.
	 */
	it("nests every settings tab under the settings page", () => {
		for (const url of [
			routes.members,
			routes.apiKeys,
			routes.notifications,
			routes.routingSettings,
			routes.recordingSettings,
			routes.emergencyAddresses,
			routes.mySettings,
		]) {
			expect(url.startsWith(`${routes.settings}/`)).toBe(true);
		}
	});

	it("keeps the routing settings off the routing page's path", () => {
		expect(routes.routingSettings).toBe("/settings/routing");
		expect(routes.routingSettings.startsWith(`${routes.routing}/`)).toBe(false);
	});

	/**
	 * The same split for recordings: `/recordings` is a cursor-paged ledger gated by
	 * `recordings.read`, and `/settings/recordings` is one policy field gated by `settings.read`.
	 * Nesting the second under the first would make `getPagePermissions` inherit the ledger's
	 * requirement by ancestry, and a role that may set the retention window without reading the
	 * recordings would then be shown a page the API refuses.
	 */
	it("keeps the recording policy off the recordings ledger's path", () => {
		expect(routes.recordingSettings).toBe("/settings/recordings");
		expect(routes.recordingSettings.startsWith(`${routes.recordings}/`)).toBe(false);
	});
});

/**
 * Caller screening is a route of its own, not a routing tab.
 *
 * The API gives it `call-block.*` rather than `routes.*` deliberately — the person maintaining a
 * blocklist is whoever answered the phone, not the administrator who owns the dial plan — and a tab
 * of `/routing` would inherit that page's requirement by ancestry, which is the disagreement
 * `page-permissions.ts` exists to prevent. The same argument paging groups made against being a tab
 * of ring groups.
 */
describe("call blocking", () => {
	it("is a top-level route rather than a segment of the routing page", () => {
		expect(routes.callBlock).toBe("/call-block");
		expect(routes.callBlock.startsWith(`${routes.routing}/`)).toBe(false);
		expect(ROUTING_TABS).not.toContain("call-block" as never);
	});
});

describe("detail routes", () => {
	/**
	 * Nested under the list's path, which is what makes `getPagePermissions` inherit the list's
	 * requirement by ancestry rather than needing a `PAGE_PERMISSIONS` line of its own.
	 */
	it("nests a queue's detail view under the queue list", () => {
		expect(routes.queue("0193f2aa")).toBe(`${routes.queues}/0193f2aa`);
		expect(routes.queue("0193f2aa").startsWith(`${routes.queues}/`)).toBe(true);
	});
});

/**
 * Where the T2 admin block landed, and why each choice is not the other one.
 *
 * Four surfaces arrived at once with four different permissions between them, and the rule this
 * file has applied five times decided each: a page may only be a tab of another page when the two
 * are gated by the SAME grant, because a tab inherits its parent's requirement by ancestry and
 * `PAGE_PERMISSIONS` cannot name one permission and mean two.
 */
describe("the T2 admin block's placement", () => {
	/**
	 * Translations became a Routing TAB because a ruleset rides `routes.*` — it is only meaningful
	 * attached to an outbound route or a trunk, so its power is the power `routes.write` already
	 * grants. Filing it with the dial-plan tables under `dial-plan.*` would have hidden it from the
	 * people who own the routes that carry it.
	 */
	it("makes number translations a routing tab and gives its rules a nested detail route", () => {
		expect(ROUTING_TABS).toContain("translations");
		expect(routingTabHref("translations")).toBe(`${routes.routing}?tab=translations`);
		expect(routes.translationRuleset("0193f2aa").startsWith(`${routes.routing}/`)).toBe(true);
	});

	/**
	 * Call flows went the other way, for the one reason that outranks tidiness here:
	 * `call-flows.toggle` is the receptionist's grant, and the whole feature is that somebody who
	 * owns no part of the dial plan can find this page at five o'clock. As the sixth tab of a page
	 * called "Routing" it would not be findable by that person, and the route requirement could not
	 * let them in without opening the other five tabs.
	 */
	it("gives call flows a route of their own rather than a sixth routing tab", () => {
		expect(routes.callFlows).toBe("/call-flows");
		expect(routes.callFlows.startsWith(`${routes.routing}/`)).toBe(false);
		expect(ROUTING_TABS).not.toContain("call-flows" as never);
	});

	/** A PIN set gates money and has a resource of its own, so it cannot inherit anything else's. */
	it("gives authorisation codes a route of their own, with the codes nested under it", () => {
		expect(routes.pinSets).toBe("/pin-sets");
		expect(routes.pinSet("0193f2aa")).toBe(`${routes.pinSets}/0193f2aa`);
		expect(routes.pinSets.startsWith(`${routes.dialPlan}/`)).toBe(false);
	});

	/**
	 * The four dial-plan tables share one permission family, which is the only thing that makes one
	 * page over four tabs legal here. The default tab is the bare path for the reason every tab
	 * strip in this file is: `nuqs` clears the default, so a link carrying it is rewritten on load.
	 */
	it("puts the four dial-plan tables on one page with the section in the query", () => {
		expect(DIAL_PLAN_TABS).toEqual(["aliases", "streams", "directories", "speed-dials"]);
		expect(dialPlanTabHref("aliases")).toBe(routes.dialPlan);
		expect(dialPlanTabHref("streams")).toBe(`${routes.dialPlan}?tab=streams`);
		// Translations are NOT a fifth tab — different permission, different page.
		expect(DIAL_PLAN_TABS).not.toContain("translations" as never);
	});

	/**
	 * The live conference view is a TAB, not a route and not a detail page.
	 *
	 * A room has no detail page by design — it is one flat row edited in a dialog — and the live view
	 * could not be one anyway: the `conferences` topic's snapshot is the whole claims bucket, so
	 * scoping it to one room would open the same org-wide subscription and discard all but one row.
	 * Both tabs are gated by `conferences.read`, which is what makes one `PAGE_PERMISSIONS` line
	 * enough.
	 */
	it("puts the live conference view on the conferences page with the section in the query", () => {
		expect(CONFERENCE_TABS).toEqual(["rooms", "live"]);
		expect(conferenceTabHref("rooms")).toBe(routes.conferences);
		expect(conferenceTabHref("live")).toBe(`${routes.conferences}?tab=live`);
	});

	/** The quotas are a settings tab, so they inherit nothing from the PBX area's routes. */
	it("nests the limits under the settings area", () => {
		expect(routes.limits).toBe("/settings/limits");
		expect(routes.limits.startsWith(`${routes.settings}/`)).toBe(true);
	});
});
