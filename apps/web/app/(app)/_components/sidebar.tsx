"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "~/components/ui/badge";
import { focusRingInset } from "~/components/ui/focus-ring";
import { cn } from "~/lib/cn";
import { canAccessPage } from "~/lib/page-permissions";
import { useAppSession } from "../_context/session-context";
import { isNavItemActive, NAV_SECTIONS, type NavItem } from "./nav-config";
import { OrganizationSwitcher } from "./organization-switcher";
import { UserMenu } from "./user-menu";

/**
 * The application sidebar.
 *
 * Every entry is filtered through `canAccessPage`, the same function the route guard uses — so
 * a visible link always leads somewhere the caller can actually open. A section whose items are
 * all filtered out disappears with its heading rather than leaving a label over nothing.
 */
export function Sidebar() {
	const pathname = usePathname();
	const { permissions } = useAppSession();
	const granted = new Set<string>(permissions);

	const sections = NAV_SECTIONS.map((section) => ({
		...section,
		items: section.items.filter((item) => canAccessPage(item.url, granted)),
	})).filter((section) => section.items.length > 0);

	return (
		<nav
			aria-label="Main"
			className="flex h-full w-60 shrink-0 flex-col gap-4 border-r border-border bg-sidebar px-3 py-4"
		>
			<OrganizationSwitcher />

			<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
				{sections.map((section) => (
					<div key={section.label} className="flex flex-col gap-1">
						<h2 className="px-2 text-[0.6875rem] font-medium tracking-wider text-subtle-foreground uppercase">
							{section.label}
						</h2>
						<ul className="flex flex-col gap-0.5">
							{section.items.map((item) => (
								<li key={item.url}>
									<SidebarLink item={item} active={isNavItemActive(pathname, item.url)} />
								</li>
							))}
						</ul>
					</div>
				))}
			</div>

			<UserMenu />
		</nav>
	);
}

function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
	const Icon = item.icon;

	return (
		<Link
			href={item.url}
			aria-current={active ? "page" : undefined}
			className={cn(
				"group flex items-center gap-2.5 rounded-field px-2 py-1.5 text-sm transition-colors duration-[--motion-fast] ease-[--ease-standard]",
				/*
				 * Hover and selected must not look alike: hover is a lighter, transient wash, selected
				 * is the persistent accent. Using one for both makes a hovered row read as the current
				 * page every time the pointer crosses the sidebar.
				 */
				active
					? "bg-accent font-medium text-accent-foreground"
					: "text-muted-foreground hover:bg-hover hover:text-foreground",
				focusRingInset,
			)}
		>
			<Icon className="size-4 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{item.title}</span>
			{item.comingSoon ? (
				<Badge tone="neutral" className="shrink-0 text-[0.625rem]">
					Soon
				</Badge>
			) : null}
		</Link>
	);
}
