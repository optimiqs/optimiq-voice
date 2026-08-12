import {
	BlockIcon,
	ConferenceIcon,
	DeviceIcon,
	GaugeIcon,
	HashIcon,
	HistoryIcon,
	KeyIcon,
	LedgerIcon,
	MegaphoneIcon,
	MenuIcon,
	MusicIcon,
	ParkIcon,
	PhoneIcon,
	QueueIcon,
	RecordIcon,
	RouteIcon,
	SettingsIcon,
	ShieldIcon,
	TrunkIcon,
	UsersIcon,
	VoicemailIcon,
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
		items: [{ title: "Dashboard", url: routes.overview, icon: GaugeIcon }],
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
			{ title: "Queues", url: routes.queues, icon: QueueIcon },
		],
	},
	{
		label: "Call features",
		items: [
			{ title: "Voicemail", url: routes.voicemail, icon: VoicemailIcon },
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
			{ title: "Recordings", url: routes.recordings, icon: RecordIcon },
			{ title: "Call history", url: routes.cdr, icon: HistoryIcon },
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
			{ title: "Webhooks", url: routes.webhooks, icon: WebhookIcon },
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
