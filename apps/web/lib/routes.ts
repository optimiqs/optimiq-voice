/**
 * Every route the app links to, in one place.
 *
 * `typedRoutes` is on in `next.config.ts`, so a path that does not exist fails the build — but
 * only if it is written as a literal. Centralizing them means a rename is one edit, and the
 * middleware and the client guard cannot disagree about what "public" means.
 */

export const routes = {
	signIn: "/sign-in",
	signUp: "/sign-up",
	forgotPassword: "/forgot-password",
	resetPassword: "/reset-password",
	verifyEmail: "/verify-email",
	twoFactor: "/two-factor",
	acceptInvitation: (invitationId: string) => `/accept-invitation/${invitationId}`,

	overview: "/",
	extensions: "/extensions",
	devices: "/devices",
	numbers: "/numbers",
	trunks: "/trunks",
	routing: "/routing",
	ivr: "/ivr",
	ringGroups: "/ring-groups",
	/**
	 * Paging groups — one-way announcements and talkback intercom to a set of handsets.
	 *
	 * Its own route beside ring groups rather than a tab of one, because the two are gated by
	 * different permissions (`paging-groups.*` against `ring-groups.*`) and a shared page would need
	 * a `PAGE_PERMISSIONS` entry that named one of them and hid the other.
	 */
	pagingGroups: "/paging-groups",
	queues: "/queues",
	voicemail: "/voicemail",
	conferences: "/conferences",
	parkLots: "/park-lots",
	/**
	 * Caller screening — the allow/deny list.
	 *
	 * Its own route rather than a fifth tab of `/routing`, on exactly the precedent
	 * {@link routes.pagingGroups} sets: the two are gated by different permissions
	 * (`call-block.*` against `routes.*`), and a shared page would need a `PAGE_PERMISSIONS` entry
	 * that named one of them and hid the other. `/routing`'s entry is already `mode: "any"` over
	 * three grants, so adding a fourth would make the page reachable for a receptionist holding only
	 * `call-block.read` and then show them four tabs the API refuses.
	 *
	 * The permission split is the API's and it is deliberate: `CallBlockController` argues that the
	 * person who maintains a blocklist is whoever answered the phone, not the administrator who owns
	 * the outbound routing table — so the screen has to be reachable without the dial plan, which a
	 * tab of the dial plan cannot be.
	 */
	callBlock: "/call-block",
	recordings: "/recordings",
	cdr: "/cdr",
	mediaLibrary: "/media",
	/**
	 * The change ledger.
	 *
	 * A top-level route under "Insight" rather than a tab of `/settings`, and the shape is what
	 * decides it: `/settings` is a stack of FORMS gated by `settings.read`, and this is a windowed,
	 * cursor-paged, read-only table gated by `audit.read` — the same surface as `/cdr` and
	 * `/recordings`, which is exactly where the app already puts append-only ledgers. Filing it as a
	 * settings tab would have put a table nobody can edit behind a nav label that means "things you
	 * change", and given it a `PAGE_PERMISSIONS` entry that disagreed with every one of its siblings.
	 */
	auditLog: "/audit-log",
	/**
	 * SIP security: the network allowlist, and the log of what it refused.
	 *
	 * Its own route rather than a settings tab, for the reason `sip-acl.controller.ts` gives for its
	 * own permission: `settings.read` is held by every self-service role so a user's preferences
	 * screen renders, and the list of networks that may register phones or terminate calls is not a
	 * preference. A tab in the settings bar would have been visible to everyone who can see their
	 * own notification preferences.
	 */
	security: "/security",
	/** Outbound webhook subscriptions — the integrator surface, gated by `webhooks.*`. */
	webhooks: "/webhooks",
	settings: "/settings",
	members: "/settings/members",
	apiKeys: "/settings/api-keys",
	emergencyAddresses: "/settings/emergency-addresses",
	/** The `notifications` category of the settings cascade — voicemail-to-email and its from-name. */
	notifications: "/settings/notifications",
	/**
	 * The `routing` category of the settings cascade — the eight names the routing compiler reads.
	 *
	 * Under `/settings`, not under `/routing`, even though the compiler is what consumes them.
	 * `/routing` is the four tabs of ROWS a call is matched against and is gated by `routes.*`;
	 * these are organization-wide defaults gated by `settings.*`, exactly like every other tab of
	 * the settings area. Putting them on `/routing` would have meant a fifth tab with a different
	 * permission from the other four.
	 */
	routingSettings: "/settings/routing",
	/**
	 * The `recordings` category of the settings cascade — how long recorded calls are kept.
	 *
	 * Under `/settings` beside the other categories rather than as a panel on `/recordings`, on the
	 * same reasoning that put the routing category here: `/recordings` is a windowed, cursor-paged
	 * ledger gated by `recordings.read`, and this is one organization-wide policy field. They read
	 * as the same subject and are not the same shape, and a settings form living on a ledger page
	 * would be the only one in the app that did.
	 */
	recordingSettings: "/settings/recordings",
	/**
	 * The caller's own preferences — the user level of the settings cascade.
	 *
	 * A settings tab and not a route of its own, because it IS the settings area seen from one
	 * person's end: same layout, same sub-navigation, same cascade, one level down. It is
	 * nevertheless the only entry under `/settings` gated by a `.own` permission, which is what
	 * makes it visible to a self-service user who can open nothing else in that area — see
	 * `page-permissions.ts`.
	 */
	mySettings: "/settings/me",

	/**
	 * Detail views, for the five entities that own a child collection.
	 *
	 * Everything else is edited in a dialog over its list, because everything else is one flat row
	 * — a route for a form with no sub-resource is a page load the user pays for and a back button
	 * that leaves the list. An IVR menu's options, a ring group's members, a paging group's
	 * handsets, a time condition's rules and a queue's tiers are collections with their own
	 * targets, which a dialog inside a dialog cannot hold.
	 *
	 * They are nested under their list's path so `getPagePermissions` inherits the parent's
	 * requirement by ancestry — `/ivr/<id>` needs `ivr.read` without `PAGE_PERMISSIONS` naming it.
	 */
	ivrMenu: (id: string) => `/ivr/${id}`,
	ringGroup: (id: string) => `/ring-groups/${id}`,
	pagingGroup: (id: string) => `/paging-groups/${id}`,
	queue: (id: string) => `/queues/${id}`,
	timeCondition: (id: string) => `/routing/time-conditions/${id}`,

	/**
	 * A trunk's detail page, which the four above do not have a reason to exist for.
	 *
	 * Its reason is carrier provisioning: the SIP credentials a provision returns are shown once
	 * and are the kind of thing an admin copies into a phone system while reading them, which a
	 * dialog over a list — dismissable by a click anywhere outside it — is the wrong container for.
	 * It inherits `trunks.read` by ancestry, so `PAGE_PERMISSIONS` needs no entry.
	 */
	trunk: (id: string) => `/trunks/${id}`,
} as const;

/**
 * The Queues page's two sections.
 *
 * Agents are a TOP-LEVEL resource (`/api/v1/queue-agents`) because `queue_agent` carries no queue —
 * one agent serves several queues through a tier. So they cannot live on a queue's own page, and a
 * second sidebar entry called "Queue agents" would be a second way to say "queues". One page with
 * the section in the URL keeps both views linkable, and both are gated by `queues.read`.
 */
export const QUEUE_TABS = ["queues", "agents"] as const;

export type QueueTab = (typeof QUEUE_TABS)[number];

export function queueTabHref(tab: QueueTab): string {
	return tab === "queues" ? routes.queues : `${routes.queues}?tab=${tab}`;
}

/**
 * The Routing page's sections, as query state.
 *
 * Inbound routes, outbound routes, time conditions and feature codes are four views of ONE
 * subject — how a call is routed — and all four are gated by `routes.*`. Four sidebar entries
 * would be four ways to say "routing"; four tabs on one page with the section in the URL keeps
 * every view linkable without inventing four routes and four permission entries that would all
 * have to say the same thing.
 */
export const ROUTING_TABS = [
	"inbound",
	"outbound",
	"time-conditions",
	"feature-codes",
	"tools",
] as const;

export type RoutingTab = (typeof ROUTING_TABS)[number];

export function routingTabHref(tab: RoutingTab): string {
	return tab === "inbound" ? routes.routing : `${routes.routing}?tab=${tab}`;
}

/**
 * The Devices page's two sections.
 *
 * A device profile is not something an administrator sets out to manage — it is something they
 * reach for while managing devices, and it is gated by the same `devices.*` grants because editing
 * one edits the configuration of every phone that uses it. So a second sidebar entry would be a
 * second way to say "phones", and a second route would need a `PAGE_PERMISSIONS` line duplicating
 * `devices.read`. The tab lives in `?tab=` so a support conversation about a profile is a link.
 */
export const DEVICE_TABS = ["devices", "profiles"] as const;

export type DeviceTab = (typeof DEVICE_TABS)[number];

export function deviceTabHref(tab: DeviceTab): string {
	return tab === "devices" ? routes.devices : `${routes.devices}?tab=${tab}`;
}

/**
 * The Numbers page's two sections.
 *
 * Buying a number and listing the numbers you own are two views of one subject, and both are about
 * DIDs — so a second sidebar entry called "Order numbers" would be a second way to say "numbers",
 * and a second route would need a `PAGE_PERMISSIONS` line duplicating `numbers.read`. The tab lives
 * in `?tab=` so "here is the search I ran" is a link, the same as every list's filter state.
 *
 * The `order` tab is rendered for everyone with `numbers.read` and its controls are gated on
 * `numbers.order` — hiding the tab entirely from a manager would leave them unable to see that
 * ordering exists, which is worse than showing them a panel that explains they cannot use it.
 */
export const NUMBER_TABS = ["numbers", "order"] as const;

export type NumberTab = (typeof NUMBER_TABS)[number];

export function numberTabHref(tab: NumberTab): string {
	return tab === "numbers" ? routes.numbers : `${routes.numbers}?tab=${tab}`;
}

/**
 * The Security page's two sections.
 *
 * The rules and the refusals are two views of ONE subject — who may reach the SIP edge — and both
 * are gated by `security.read`. Two sidebar entries would be two ways to say "SIP security", and
 * the second one would need a `PAGE_PERMISSIONS` line repeating the first one's permission.
 *
 * They belong together for a stronger reason than shared permissions, though: the attack log is how
 * an administrator finds out a rule is wrong, and the rule list is where they fix it. Splitting them
 * across two routes would put the question and the answer one navigation apart.
 */
export const SECURITY_TABS = ["access-rules", "auth-failures"] as const;

export type SecurityTab = (typeof SECURITY_TABS)[number];

export function securityTabHref(tab: SecurityTab): string {
	return tab === "access-rules" ? routes.security : `${routes.security}?tab=${tab}`;
}

/**
 * The Media page's two sections.
 *
 * Hold music and the prompt library are two views of ONE subject — the tenant's stored audio — and
 * both are gated by the same `settings.*` grants, because both are organization-wide configuration
 * every call feature draws on. Two sidebar entries would be two ways to say "audio"; the tab lives
 * in `?tab=` so "here is the class I mean" is a link, the same as every other list's filter state.
 *
 * They are nevertheless different SHAPES rather than two lists of the same thing: a hold-music
 * class is a container with files under it, and a prompt is a file an IVR can be pointed at. The
 * split is the API's (`moh_class` is a routing input; `prompt` is not), not a display choice.
 */
export const MEDIA_TABS = ["hold-music", "prompts"] as const;

export type MediaTab = (typeof MEDIA_TABS)[number];

export function mediaTabHref(tab: MediaTab): string {
	return tab === "hold-music" ? routes.mediaLibrary : `${routes.mediaLibrary}?tab=${tab}`;
}

/**
 * Prefixes reachable without a session.
 *
 * `/accept-invitation` is here on purpose: the invitation email is opened by someone who may have
 * no account at all, so the page must render and route them to sign-up rather than bounce them to
 * a sign-in screen that loses the invitation id.
 */
export const PUBLIC_ROUTE_PREFIXES: readonly string[] = [
	routes.signIn,
	routes.signUp,
	routes.forgotPassword,
	routes.resetPassword,
	routes.verifyEmail,
	routes.twoFactor,
	"/accept-invitation",
];

export function isPublicRoute(pathname: string): boolean {
	return PUBLIC_ROUTE_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

/** Builds a sign-in URL that returns the user to where they were headed. */
export function signInWithRedirect(pathname: string): string {
	if (pathname === routes.overview || isPublicRoute(pathname)) {
		return routes.signIn;
	}
	return `${routes.signIn}?redirectTo=${encodeURIComponent(pathname)}`;
}

/**
 * Only same-origin absolute paths may be followed after sign-in. Anything else — a protocol,
 * a `//host` shorthand, a backslash Windows treats as a separator — is an open-redirect vector
 * handed to us straight from the query string.
 */
export function safeRedirectTarget(value: string | null | undefined): string {
	if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
		return routes.overview;
	}
	return value;
}
