import {
	ConferenceIcon,
	DeviceIcon,
	GaugeIcon,
	HashIcon,
	HistoryIcon,
	KeyIcon,
	MenuIcon,
	ParkIcon,
	PhoneIcon,
	QueueIcon,
	RecordIcon,
	RouteIcon,
	SettingsIcon,
	TrunkIcon,
	UsersIcon,
	VoicemailIcon,
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
			{ title: "Devices", url: routes.devices, icon: DeviceIcon, comingSoon: true },
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
			{ title: "Queues", url: routes.queues, icon: QueueIcon },
		],
	},
	{
		label: "Call features",
		items: [
			{ title: "Voicemail", url: routes.voicemail, icon: VoicemailIcon },
			{ title: "Conferences", url: routes.conferences, icon: ConferenceIcon },
			{ title: "Park lots", url: routes.parkLots, icon: ParkIcon },
		],
	},
	{
		label: "Insight",
		items: [
			{ title: "Recordings", url: routes.recordings, icon: RecordIcon, comingSoon: true },
			{ title: "Call history", url: routes.cdr, icon: HistoryIcon, comingSoon: true },
		],
	},
	{
		label: "Organization",
		items: [
			{ title: "Settings", url: routes.settings, icon: SettingsIcon },
			{ title: "Members", url: routes.members, icon: UsersIcon },
			{ title: "API keys", url: routes.apiKeys, icon: KeyIcon },
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
