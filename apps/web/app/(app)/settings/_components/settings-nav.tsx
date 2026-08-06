"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { focusRing } from "~/components/ui/focus-ring";
import { cn } from "~/lib/cn";
import { canAccessPage } from "~/lib/page-permissions";
import { routes } from "~/lib/routes";
import { useAppSession } from "../../_context/session-context";

const TABS = [
	{ title: "General", url: routes.settings },
	{ title: "Members", url: routes.members },
	{ title: "API keys", url: routes.apiKeys },
	{ title: "Notifications", url: routes.notifications },
	{ title: "Emergency", url: routes.emergencyAddresses },
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
					const active = pathname === tab.url;
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
