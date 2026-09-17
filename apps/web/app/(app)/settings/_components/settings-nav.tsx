"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { focusRing } from "~/components/ui/focus-ring";
import { cn } from "~/lib/cn";
import { canAccessPage } from "~/lib/page-permissions";
import { routes } from "~/lib/routes";
import { useAppSession } from "../../_context/session-context";

/**
 * The order is organization-first, person-last.
 *
 * "My preferences" is deliberately at the end rather than at the front: for the administrators who
 * see the whole bar it is the least-used tab, and for a self-service user holding only
 * `settings.read.own` it is the ONLY tab — so its position is invisible to exactly the people it
 * would inconvenience.
 */
const TABS = [
	{ title: "General", url: routes.settings },
	{ title: "Members", url: routes.members },
	{ title: "Branding", url: routes.branding },
	{ title: "API keys", url: routes.apiKeys },
	{ title: "Notifications", url: routes.notifications },
	{ title: "Routing", url: routes.routingSettings },
	{ title: "Recordings", url: routes.recordingSettings },
	/**
	 * The quotas. Gated by `org-limits.read` rather than `settings.read`, which is the only tab here
	 * whose permission is not a settings grant — see `page-permissions.ts` for why the API made it
	 * wide, and why naming `settings.read` would have shown it to every self-service role.
	 */
	{ title: "Limits", url: routes.limits },
	{ title: "Emergency", url: routes.emergencyAddresses },
	/**
	 * Messaging registration — the entry point for five screens, not one.
	 *
	 * One tab rather than five, because the settings bar is already ten entries wide and because the
	 * four others (brand, campaigns, toll-free, opt-outs) are steps in ONE task: getting this
	 * organization's numbers accepted by the carriers. The sub-navigation for them lives on the
	 * page, where the order they must be done in can be shown.
	 */
	{ title: "Messaging", url: routes.messagingNumbers },
	{ title: "My preferences", url: routes.mySettings },
] as const;

/**
 * Sub-navigation for the settings area, gated by the same route map as the sidebar. A tab the
 * caller cannot open is not shown rather than shown and rejected.
 */
export function SettingsNav() {
	const pathname = usePathname();
	const { permissions } = useAppSession();
	const granted = new Set<string>(permissions);
	const tabs = TABS.filter((tab) => canAccessPage(tab.url, granted));

	return (
		<nav aria-label="Settings" className="border-b border-border">
			<ul className="-mb-px flex gap-1">
				{tabs.map((tab) => {
					/**
					 * A tab stays current on its own descendants — `/settings/messaging/brand` is still
					 * the Messaging tab. `/settings` itself is matched exactly, because it is a prefix of
					 * every other tab and a `startsWith` check would light "General" up on all of them.
					 */
					const active =
						pathname === tab.url ||
						(tab.url !== routes.settings && pathname.startsWith(`${tab.url}/`));
					return (
						<li key={tab.url}>
							<Link
								href={tab.url}
								aria-current={active ? "page" : undefined}
								className={cn(
									"inline-flex border-b-2 px-3 py-2 text-sm transition-colors duration-[--motion-fast]",
									active
										? "border-primary font-medium text-foreground"
										: "border-transparent text-muted-foreground hover:text-foreground",
									focusRing,
								)}
							>
								{tab.title}
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
