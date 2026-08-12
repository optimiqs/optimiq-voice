import { describe, expect, it } from "bun:test";
import {
	isPublicRoute,
	queueTabHref,
	routes,
	ROUTING_TABS,
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
