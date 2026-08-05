"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { ChevronDownIcon, LogOutIcon, SettingsIcon } from "~/components/ui/icons";
import {
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	MenuTrigger,
} from "~/components/ui/menu";
import { signOut } from "~/lib/auth-client";
import { cn } from "~/lib/cn";
import { roleLabel } from "~/lib/permissions";
import { routes } from "~/lib/routes";
import { useAppSession } from "../_context/session-context";

export function UserMenu() {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { resolvedTheme, setTheme } = useTheme();
	const session = useAppSession();

	/**
	 * Clearing the cache before navigating is not tidiness — a `staleTime: Infinity` cache would
	 * otherwise still hold this organization's data when the next person signs in on the same
	 * machine, and React Query would serve it before any refetch.
	 */
	async function handleSignOut() {
		await signOut();
		await queryClient.cancelQueries();
		queryClient.clear();
		router.replace(routes.signIn);
	}

	return (
		<Menu>
			<MenuTrigger
				className={cn(
					"flex w-full items-center gap-2 rounded-field px-2 py-2 text-left transition-colors duration-[--motion-fast]",
					"hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
				)}
			>
				<span
					aria-hidden="true"
					className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground"
				>
					{session.user.name.slice(0, 1).toUpperCase()}
				</span>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-sm font-medium text-foreground">{session.user.name}</span>
					<span className="truncate text-xs text-muted-foreground">{session.user.email}</span>
				</span>
				<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
			</MenuTrigger>

			<MenuContent className="w-56" align="end">
				<MenuLabel>
					{session.role
						? `Signed in as ${roleLabel(session.role)}`
						: "No role in this organization"}
				</MenuLabel>
				<MenuSeparator />
				<MenuItem onClick={() => router.push(routes.settings)}>
					<SettingsIcon />
					Organization settings
				</MenuItem>
				<MenuItem
					onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
					closeOnClick={false}
				>
					{resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
				</MenuItem>
				<MenuSeparator />
				<MenuItem onClick={() => void handleSignOut()}>
					<LogOutIcon />
					Sign out
				</MenuItem>
			</MenuContent>
		</Menu>
	);
}
