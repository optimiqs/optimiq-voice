import {
	BlockIcon,
	BlocksIcon,
	BuildingIcon,
	ConferenceIcon,
	DeviceIcon,
	GaugeIcon,
	HashIcon,
	HistoryIcon,
	KeyIcon,
	KeypadIcon,
	LedgerIcon,
	MegaphoneIcon,
	MenuIcon,
	MessageIcon,
	MusicIcon,
	ParkIcon,
	PhoneIcon,
	QueueIcon,
	RecordIcon,
	RouteIcon,
	SettingsIcon,
	ShieldIcon,
	SwitchIcon,
	TrunkIcon,
	UsersIcon,
	VoicemailIcon,
	WallboardIcon,
	WebhookIcon,
} from "~/components/ui/icons";
import { routes } from "~/lib/routes";
import type { ComponentType, SVGProps } from "react";

/**
 * The sidebar, declared as data.
 *
 * Nav items carry NO permission field on purpose. Visibility is resolved from
 * `lib/page-permissions.ts` by URL, so the entry a user can see and the page they can open are
 * answered by the same map. The alternative — a `permissions` array here and another in the route
 * guard — is two sources of truth that drift the first time one is edited alone.
 *
 * The order is the delivery order from the master plan §5: inventory, then routing, then call
 * features, then the reporting surfaces, then tenancy.
 */

export type NavIcon = ComponentType<SVGProps<SVGSVGElement>>;

export interface NavItem {
	readonly title: string;
	readonly url: string;
	readonly icon: NavIcon;
	/** Shown on modules that have no backend yet, so an empty page is not read as a broken one. */
	readonly comingSoon?: boolean;
}

export interface NavSection {
	readonly label: string;
	readonly items: readonly NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
	{
		label: "Overview",
		items: [
			{ title: "Dashboard", url: routes.overview, icon: GaugeIcon },
			{ title: "Softphone", url: routes.softphone, icon: KeypadIcon },
		],
	},
	{
		label: "Telephony",
		items: [
			{ title: "Extensions", url: routes.extensions, icon: PhoneIcon },
			{ title: "Devices", url: routes.devices, icon: DeviceIcon },
			{ title: "Numbers", url: routes.numbers, icon: HashIcon },
			{ title: "Trunks", url: routes.trunks, icon: TrunkIcon },
		],
	},
	{
		label: "Routing",
		items: [
			{ title: "Routing", url: routes.routing, icon: RouteIcon },
			/**
			 * Immediately after Routing, because a call flow is the thing an administrator reaches for
			 * the moment after they have built a time condition and discovered it cannot be overruled.
			 *
			 * It is nevertheless a separate entry rather than a Routing tab, and the reason is who opens
			 * it: `call-flows.toggle` is the receptionist's grant, and the whole feature is that
			 * somebody who owns no part of the dial plan can find this page at five o'clock. Buried as
			 * the sixth tab of a page called "Routing" it would not be findable by that person, and
			 * `PAGE_PERMISSIONS` could not let them in without opening the other five tabs too.
			 */
			{ title: "Call flows", url: routes.callFlows, icon: SwitchIcon },
			/**
			 * The four named building blocks routing points at, on one page.
			 *
			 * Under "Routing" rather than "Call features" because that is what somebody is doing when
			 * they reach for one: they are wiring a DID or an IVR option and they need a target that
			 * outlives the row pointing at it.
			 */
			{ title: "Dial plan", url: routes.dialPlan, icon: BlocksIcon },
			/**
			 * Outbound authorisation codes, last in this section because they are the least-visited and
			 * because they belong beside the outbound routes they gate rather than beside the features
			 * a front desk uses. Whoever manages these is whoever is named when the bill arrives.
			 */
			{ title: "Authorisation codes", url: routes.pinSets, icon: KeypadIcon },
			{ title: "IVR menus", url: routes.ivr, icon: MenuIcon },
			{ title: "Ring groups", url: routes.ringGroups, icon: UsersIcon },
			/**
			 * Beside ring groups, because the two answer the same question — "this set of handsets" —
			 * and an administrator building one has usually just looked at the other.
			 *
			 * They are nevertheless opposite in the only way that matters at the handset: a ring group
			 * RINGS and waits to be answered, a paging group auto-answers and speaks. That is why it is
			 * a separate entry rather than a tab, and why it carries a megaphone rather than the group
			 * glyph ring groups use.
			 */
			{ title: "Paging groups", url: routes.pagingGroups, icon: MegaphoneIcon },
			/**
			 * Beside the two group screens it resembles, because an administrator building a shared line
			 * has usually just looked at a ring group — both are "this set of handsets".
			 *
			 * It is nevertheless a separate entry rather than a tab, and for a sharper reason than the
			 * others: a ring group REACHES people and is done at the answer, a paging group SPEAKS at
			 * them, and a shared line is a shared RESOURCE whose whole point is the state it keeps after
			 * the answer. Three different things wearing a similar list, gated by three different grants.
			 */
			{ title: "Shared lines", url: routes.sharedLines, icon: PhoneIcon },
			{ title: "Queues", url: routes.queues, icon: QueueIcon },
		],
	},
	{
		label: "Call features",
		items: [
			{ title: "Voicemail", url: routes.voicemail, icon: VoicemailIcon },
			/**
			 * Messaging, beside voicemail rather than under "Insight" or "Organization".
			 *
			 * These sections are a claim about WHO does something. Voicemail and messaging are the two
			 * places where a message from outside is waiting for somebody in this organization to
			 * answer it, and whoever is working through one is the same person working through the
			 * other. It carries `messaging.read`, which the agent template holds — so for an agent this
			 * section has exactly two entries in it, and both are theirs.
			 *
			 * The REGISTRATION screens are not here. They are `/settings/messaging` on
			 * `messaging.manage`, which is the split between reading a thread and filing a company's
			 * EIN with a carrier.
			 */
			{ title: "Messaging", url: routes.messaging, icon: MessageIcon },
			{ title: "Conferences", url: routes.conferences, icon: ConferenceIcon },
			{ title: "Park lots", url: routes.parkLots, icon: ParkIcon },
			/**
			 * Caller screening, under "Call features" rather than under "Routing".
			 *
			 * A blocklist IS a routing input — `call_block_rule` is in `ROUTING_TABLE_TO_ENTITY` and a
			 * save recompiles the artifact — so "Routing" is the defensible-looking choice and it is
			 * the wrong one. These sections are a claim about WHO does something, not about which
			 * table feeds the compiler: "Routing" is the dial plan an administrator owns, and
			 * `CallBlockController` is explicit that the person who maintains a screening list is
			 * whoever answered the phone. Filing it beside voicemail and park lots puts it with the
			 * other things the front desk uses, which is where whoever is adding this morning's
			 * nuisance number will look for it.
			 */
			{ title: "Call blocking", url: routes.callBlock, icon: BlockIcon },
			/**
			 * Hold music and the prompt library, on one page with the section in `?tab=`.
			 *
			 * Under "Call features" rather than "Organization" because that is what an admin is doing
			 * when they reach for it: they are building an IVR or a queue and they need the audio it
			 * plays. It is guarded by `settings.read` all the same — see `page-permissions.ts` for why
			 * the permission and the section disagree, and why the permission is the one that matters.
			 */
			{ title: "Media", url: routes.mediaLibrary, icon: MusicIcon },
		],
	},
	{
		label: "Insight",
		items: [
			/**
			 * The wallboard, FIRST in this section and the only entry in it that is about now rather
			 * than about what already happened.
			 *
			 * Under "Insight" beside call history rather than under "Routing" beside Queues, because
			 * these sections are a claim about what somebody is DOING: "Routing" is where an
			 * administrator configures a queue, and this is where a supervisor watches one. It is also
			 * the only entry here reachable on `queues.monitor` — which the `agent` template holds and
			 * which opens nothing else in the app — so for an agent this section has exactly one item
			 * in it, and it is the right one.
			 */
			{ title: "Wallboard", url: routes.wallboard, icon: WallboardIcon },
			{ title: "Recordings", url: routes.recordings, icon: RecordIcon },
			{ title: "Call history", url: routes.cdr, icon: HistoryIcon },
			{ title: "Reports", url: routes.reports, icon: GaugeIcon },
			/**
			 * The change ledger, alongside the other two read-only ledgers rather than in the settings
			 * area.
			 *
			 * "Insight" is where this app puts the append-only tables — a defaulted window, exact
			 * filters, a keyset cursor and no total — and the audit log is that surface exactly. It is
			 * gated by `audit.read` all the same, which no other entry in this section asks for; see
			 * `page-permissions.ts` for why the permission and the section disagree, and why the
			 * permission is the one that matters.
			 */
			{ title: "Audit log", url: routes.auditLog, icon: LedgerIcon },
		],
	},
	{
		label: "Organization",
		items: [
			{ title: "Settings", url: routes.settings, icon: SettingsIcon },
			{ title: "Members", url: routes.members, icon: UsersIcon },
			{ title: "API keys", url: routes.apiKeys, icon: KeyIcon },
			/**
			 * SIP security and webhooks sit beside members and API keys, and the grouping is a claim
			 * about privilege rather than about subject matter: all four decide who or what may reach
			 * this tenant. An access rule opens the platform to a network, an API key issues a
			 * credential, and a webhook sends the tenant's call metadata somewhere else.
			 *
			 * Both are last because they are the least-used entries in the section, and neither is
			 * something an administrator sets out to do daily.
			 */
			{ title: "Security", url: routes.security, icon: ShieldIcon },
			/**
			 * Carrier compliance — who this organization is, and which caller IDs it may present.
			 *
			 * In this section rather than under "Insight", because it is not a report: the KYC record
			 * and the verified caller ID list are things an administrator MAINTAINS, and the two
			 * policies beside them decide what happens to a live outbound call. It sits beside Security
			 * on the same claim the comment above makes — both are about who this tenant is allowed to
			 * be on somebody else's network.
			 */
			{ title: "Compliance", url: routes.compliance, icon: BuildingIcon },
			{ title: "Webhooks", url: routes.webhooks, icon: WebhookIcon },
		],
	},
	/**
	 * The PLATFORM operator's two screens, in a section of their own and last.
	 *
	 * Every other section here is about this tenant. These two are not: they read and write across
	 * tenants on `compliance.review` and `compliance.traceback`, both owner-only, so for every
	 * customer role `canAccessPage` answers false for both items and `sidebar.tsx` drops the whole
	 * section — a section with no reachable items is filtered out, which is why no permission field
	 * is needed here and why an operator-only heading does not leak the feature's existence.
	 *
	 * Its own section rather than joining "Organization" because the label is the honest warning: an
	 * operator glancing at the sidebar should be able to tell which of these screens leaves the
	 * organization they have selected, and "Organization" would say the opposite.
	 */
	{
		label: "Platform",
		items: [
			{ title: "KYC review", url: routes.platformKyc, icon: BuildingIcon },
			{ title: "Traceback", url: routes.platformTraceback, icon: LedgerIcon },
		],
	},
];

/**
 * Whether a nav item should be marked current.
 *
 * The dashboard is matched exactly — `/` is a prefix of everything, so a `startsWith` check would
 * light it up on every page. Every other entry also matches its descendants so a detail view keeps
 * its section highlighted.
 */
export function isNavItemActive(pathname: string, url: string): boolean {
	if (url === routes.overview) {
		return pathname === routes.overview;
	}
	return pathname === url || pathname.startsWith(`${url}/`);
}
