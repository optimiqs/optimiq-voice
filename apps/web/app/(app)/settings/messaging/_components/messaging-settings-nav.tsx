"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { focusRing } from "~/components/ui/focus-ring";
import { cn } from "~/lib/cn";
import { routes } from "~/lib/routes";

/**
 * Sub-navigation for the five registration screens.
 *
 * The order is the order the work must be done in, not alphabetical and not by importance: a
 * number has to exist before a brand can be filed against the organization, a brand before a
 * campaign, a campaign before a local number can be assigned to one — and toll-free is the branch
 * that skips all three. The suppression list is last because it is the only screen here that is
 * about a person rather than about a registration.
 *
 * Every tab is gated by `messaging.read`, inherited by ancestry from `/settings/messaging` — see
 * `page-permissions.ts` — so there is nothing to filter here. Unlike the settings bar above it,
 * this strip either appears whole or not at all.
 */
const TABS = [
	{ title: "Numbers", url: routes.messagingNumbers },
	{ title: "Brand", url: routes.messagingBrand },
	{ title: "Campaigns", url: routes.messagingCampaigns },
	{ title: "Toll-free", url: routes.messagingTollFree },
	{ title: "Opt-outs", url: routes.messagingOptOuts },
] as const;

export function MessagingSettingsNav() {
	const pathname = usePathname();

	return (
		<nav aria-label="Messaging registration" className="flex flex-wrap gap-1">
			{TABS.map((tab) => {
				const active = pathname === tab.url;
				return (
					<Link
						key={tab.url}
						href={tab.url}
						aria-current={active ? "page" : undefined}
						className={cn(
							"rounded-field px-3 py-1.5 text-sm transition-colors duration-[--motion-fast]",
							active
								? "bg-accent font-medium text-accent-foreground"
								: "text-muted-foreground hover:bg-hover hover:text-foreground",
							focusRing,
						)}
					>
						{tab.title}
					</Link>
				);
			})}
		</nav>
	);
}
