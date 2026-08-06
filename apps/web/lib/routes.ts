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
	queues: "/queues",
	voicemail: "/voicemail",
	conferences: "/conferences",
	parkLots: "/park-lots",
	recordings: "/recordings",
	cdr: "/cdr",
	mediaLibrary: "/media",
	settings: "/settings",
	members: "/settings/members",
	apiKeys: "/settings/api-keys",
	emergencyAddresses: "/settings/emergency-addresses",
	/** The `notifications` category of the settings cascade — voicemail-to-email and its from-name. */
	notifications: "/settings/notifications",

	/**
	 * Detail views, for the four entities that own a child collection.
	 *
	 * Everything else is edited in a dialog over its list, because everything else is one flat row
	 * — a route for a form with no sub-resource is a page load the user pays for and a back button
	 * that leaves the list. An IVR menu's options, a ring group's members, a time condition's rules
	 * and a queue's tiers are collections with their own targets, which a dialog inside a dialog
	 * cannot hold.
	 *
	 * They are nested under their list's path so `getPagePermissions` inherits the parent's
	 * requirement by ancestry — `/ivr/<id>` needs `ivr.read` without `PAGE_PERMISSIONS` naming it.
	 */
	ivrMenu: (id: string) => `/ivr/${id}`,
	ringGroup: (id: string) => `/ring-groups/${id}`,
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
