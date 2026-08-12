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
	/**
	 * The in-browser softphone — the user's own extension, registered over sipd's WSS transport.
	 *
	 * Session-only in `page-permissions.ts` (no entry): the gate is not a permission but a fact — the
	 * caller holds an extension — which the page resolves from `GET /api/v1/me/softphone` and the
	 * docked widget hides itself on. A `softphone.*` grant would be the wrong tool: every user with a
	 * seat is entitled to their own line, and none of the existing roles model "may use a phone".
	 */
	softphone: "/softphone",
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
	/**
	 * Shared line appearances — one line on several handsets, seized as one.
	 *
	 * Its own route beside paging and ring groups rather than a tab of one, on the precedent
	 * {@link routes.pagingGroups} sets: the three are gated by different permissions
	 * (`shared-lines.*` against `paging-groups.*` against `ring-groups.*`), and a shared page would
	 * need a `PAGE_PERMISSIONS` entry that named one of them and hid the others. A shared line is also
	 * a different SHAPE — a named line with an ordered list of appearances, each a button on a
	 * handset — even though it lives next to the two group screens it resembles.
	 */
	sharedLines: "/shared-lines",
	/**
	 * Call flows — the day/night switch.
	 *
	 * Its own route rather than a tab of `/routing`, on the precedent {@link routes.pagingGroups} and
	 * {@link routes.callBlock} both set: the two are gated by different permissions
	 * (`call-flows.*` against `routes.*`), and `/routing`'s entry is already `mode: "any"` over three
	 * grants — adding a fourth would make the page reachable for somebody holding only
	 * `call-flows.read` and then show them four tabs the API refuses.
	 *
	 * The permission split is what makes the separate route load-bearing rather than tidy:
	 * `call-flows.toggle` is the receptionist's grant, and the whole point of the feature is that
	 * somebody who owns no part of the dial plan can reach this page at five o'clock.
	 */
	callFlows: "/call-flows",
	/**
	 * Outbound authorisation codes.
	 *
	 * `pin-sets.*` is a resource of its own — the server's argument is that the blast radius is money,
	 * and the same grant that adds a code removes one — so it cannot be a tab of `/routing` (gated by
	 * `routes.*`) or of `/dial-plan` (gated by `dial-plan.*`) without a `PAGE_PERMISSIONS` entry that
	 * named one permission and hid the other. The rule this file has applied five times now.
	 */
	pinSets: "/pin-sets",
	/**
	 * The four named dial-plan building blocks, on one page with the section in `?tab=`.
	 *
	 * Named destinations, audio streams, speed dials and dial-by-name directories are four tables
	 * under ONE permission family, and the permission registry argues at length why: none of the four
	 * has a power profile of its own, and there is no role that plausibly edits one and not the
	 * others. Four sidebar entries would be four ways to say "the things routing points at".
	 *
	 * Number translations are deliberately NOT here. They ride `routes.*` rather than `dial-plan.*`,
	 * because a ruleset is only meaningful attached to an outbound route or a trunk — so they are a
	 * tab of `/routing`, beside the routes that carry them, and not a fifth tab of this page under a
	 * permission that would hide them from the people who own them.
	 */
	dialPlan: "/dial-plan",
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
	/**
	 * The wallboard — every queue's line and service level, on one screen.
	 *
	 * Under "Insight" beside `/cdr` and `/recordings` rather than as a tab of `/queues`, and the
	 * split is by AUDIENCE rather than by subject. `/queues` is configuration gated by `queues.read`
	 * and `queues.write`: what a queue does, who staffs it, where it overflows. This is gated by
	 * `queues.monitor` alone — "watch live queue and agent state" — which the `agent` template holds
	 * and which grants nothing about the dial plan. A tab of `/queues` would have needed a
	 * `PAGE_PERMISSIONS` entry naming one of the two and hiding the other, the rule this file has
	 * applied six times now.
	 *
	 * "Insight" is also where the shape belongs: like `/cdr`, it is a windowed read-only surface over
	 * the call ledger with no row anybody can edit. What it adds is a live half, which is why it is
	 * not simply another ledger screen.
	 */
	wallboard: "/wallboard",
	/**
	 * One queue's operator panel: the line as callers stand in it, and the agents who could take
	 * them.
	 *
	 * Nested under the wallboard so it inherits `queues.monitor` by ancestry, and NOT under
	 * `/queues/<id>`, which is the queue's configuration page and is gated by `queues.read`. The two
	 * pages are about the same queue and answer different questions — "how is this queue set up" and
	 * "what is happening in it right now" — and the second is the one somebody opens with a customer
	 * on hold.
	 */
	wallboardQueue: (id: string) => `/wallboard/${id}`,
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
	/**
	 * White-label branding — product name, logo, primary/accent colours, support address and custom
	 * domain, applied as `--role-*` theme overrides across the app.
	 *
	 * A settings tab because it IS organization-wide policy of the same shape every other tab holds.
	 * Read is gated by `settings.read` and the save by `branding.write` — the W14 backend minted
	 * `branding.write` but no `branding.read`, the same read-wide / write-narrow split
	 * `recordings.configure` uses. The colour/name/logo endpoints themselves are the remaining wire-up
	 * seam (`lib/branding/client.ts`).
	 */
	branding: "/settings/branding",
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
	 * The organization's quotas.
	 *
	 * A settings tab and not a route of its own, because it is organization-wide policy of exactly
	 * the shape every other tab here holds — and because `org-limits.read` is deliberately WIDE (a
	 * manager fielding "why did creating an extension fail" needs the answer) while
	 * `org-limits.write` is held by `owner` alone. That asymmetry is gated inside the page rather
	 * than by this route: a role that can see the ceilings and not move them should see them.
	 */
	limits: "/settings/limits",
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
	/**
	 * A shared line's appearances — another entity with a child collection, and it earns a page for
	 * the reason the others do: the appearances are an ORDERED list with a reorder handle, and the
	 * ordinal is the button index a phone lights, which a dialog inside a dialog cannot hold. Nested
	 * under the list's path so it inherits `shared-lines.read` by ancestry.
	 */
	sharedLine: (id: string) => `/shared-lines/${id}`,
	queue: (id: string) => `/queues/${id}`,
	timeCondition: (id: string) => `/routing/time-conditions/${id}`,
	/**
	 * A ruleset's rules, nested under `/routing` exactly as a time condition's are.
	 *
	 * The sixth entity with a child collection, and it earns a page for the reason the other five do:
	 * the rules are an ORDERED pipeline with a drag handle, which a dialog inside a dialog cannot
	 * hold. Nested under `/routing` so it inherits that page's requirement by ancestry, which is the
	 * right answer here — a ruleset is gated by `routes.read`, and `/routing`'s entry lists it.
	 */
	translationRuleset: (id: string) => `/routing/translation-rulesets/${id}`,
	/**
	 * A PIN set's codes.
	 *
	 * Under `/pin-sets/<id>` so it inherits `pin-sets.read` by ancestry. A page rather than a dialog
	 * because the codes are an ordered collection AND because setting one is a second verb with its
	 * own endpoint — a dialog over a list would be a dialog that opens a dialog to type a secret into.
	 */
	pinSet: (id: string) => `/pin-sets/${id}`,
	/**
	 * One phrase and its ordered steps.
	 *
	 * The seventh entity with a child collection, and it earns a page for the reason the other six do:
	 * the steps are an ordered sequence with a reorder endpoint, which a dialog inside a dialog cannot
	 * hold. Nested under `/media` so the phrase's editor is where the audio it names lives.
	 *
	 * It is the one detail route in this file that does NOT simply inherit its parent's requirement,
	 * and `page-permissions.ts` declares it explicitly for that reason: `/media` is gated by
	 * `settings.read` because that is what the prompt and hold-music endpoints ask for, and the
	 * phrases endpoints ask for `recordings.read` instead. Inheriting would have shown this page to
	 * every self-service role — they all hold `settings.read` so a preferences screen renders — and
	 * then 403'd them.
	 */
	phrase: (id: string) => `/media/phrases/${id}`,

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
	"translations",
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
 * The Media page's three sections.
 *
 * Hold music, the prompt library and phrases are three views of ONE subject — the tenant's stored
 * audio — so two or three sidebar entries would be two or three ways to say "audio"; the tab lives
 * in `?tab=` so "here is the class I mean" is a link, the same as every other list's filter state.
 *
 * They are nevertheless different SHAPES rather than three lists of the same thing: a hold-music
 * class is a container with files under it, a prompt is a file an IVR can be pointed at, and a
 * phrase is an ordered sequence of those files with no audio of its own. The split is the API's,
 * not a display choice.
 *
 * ## The phrases tab does NOT share the other two's permission, and that is why it gates itself
 *
 * Hold music and prompts are `settings.*`, which is what `PAGE_PERMISSIONS` names for this route.
 * Phrases are `recordings.*` — the server's decision, argued in `phrases.controller.ts`: a phrase is
 * a media-library row, so it rides the library's grants rather than minting a `phrases.*` trio.
 *
 * Everywhere else in this file that difference has forced a route of its own, and here it does not,
 * because the two grants come apart in the harmless direction. `recordings.read` is an
 * administrator's grant and `settings.read` is held by every self-service role, so the tab is
 * visible to people the phrases API refuses — and `phrases-panel.tsx` answers with an explanation
 * rather than a list, exactly as `/numbers`' order tab does for `numbers.order`. Nobody who holds
 * `recordings.read` is shut out, which is the failure a shared page can actually cause.
 *
 * A phrase's own page is the other half of that and is NOT allowed to inherit — see
 * {@link routes.phrase} and its `PAGE_PERMISSIONS` entry.
 */
export const MEDIA_TABS = ["hold-music", "prompts", "phrases"] as const;

export type MediaTab = (typeof MEDIA_TABS)[number];

export function mediaTabHref(tab: MediaTab): string {
	return tab === "hold-music" ? routes.mediaLibrary : `${routes.mediaLibrary}?tab=${tab}`;
}

/**
 * The Dial plan page's four sections.
 *
 * Four tables, one permission family, one page. The order is the order somebody meets them while
 * building routing: a named destination is the thing they point routes at, a stream and a directory
 * are places a call can land, and a speed dial is a shortcut they add last.
 */
export const DIAL_PLAN_TABS = ["aliases", "streams", "directories", "speed-dials"] as const;

export type DialPlanTab = (typeof DIAL_PLAN_TABS)[number];

export function dialPlanTabHref(tab: DialPlanTab): string {
	return tab === "aliases" ? routes.dialPlan : `${routes.dialPlan}?tab=${tab}`;
}

/**
 * The Conferences page's two sections: the rooms, and the meetings happening in them.
 *
 * ## Why a tab and not a detail page
 *
 * A conference room has no detail page, deliberately — `conferences-screen.tsx` argues it: a room is
 * one flat row edited in a dialog, because a call ENDS UP in a conference rather than passing
 * through one, so there is no timeout branch and no child collection to give a page to.
 *
 * The live view could not be a room's page even if one existed. It is fed by the `conferences` live
 * topic, whose snapshot is the whole `conference-claims` bucket — every running meeting in the
 * organization, in one frame. Scoping that to one room would mean opening the same org-wide
 * subscription and discarding all but one row, and would leave a moderator with no way to see that
 * two other rooms are running without visiting each configured room in turn.
 *
 * ## Why not a second route
 *
 * Both sections are gated by `conferences.read` — the moderation routes declare it as their floor
 * and make the real `conferences.moderate` decision in the service — so a second route would be a
 * second `PAGE_PERMISSIONS` line saying exactly what this one says. The `?tab=` keeps "look at the
 * meeting that is running" a link, which is the thing somebody pastes into a chat when a room needs
 * a moderator.
 */
export const CONFERENCE_TABS = ["rooms", "live"] as const;

export type ConferenceTab = (typeof CONFERENCE_TABS)[number];

export function conferenceTabHref(tab: ConferenceTab): string {
	return tab === "rooms" ? routes.conferences : `${routes.conferences}?tab=${tab}`;
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
