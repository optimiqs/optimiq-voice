"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BuildingIcon, CheckIcon, ChevronDownIcon, PlusIcon } from "~/components/ui/icons";
import {
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	MenuTrigger,
} from "~/components/ui/menu";
import { toast } from "~/components/ui/toast";
import { authErrorMessage, organization } from "~/lib/auth-client";
import { cn } from "~/lib/cn";
import { roleLabel } from "~/lib/permissions";
import { useAppSession } from "../_context/session-context";
import { useMyOrganizations } from "../_hooks/use-organization-queries";
import { CreateOrganizationDialog } from "./create-organization-dialog";

/**
 * Switches the session's active organization.
 *
 * The active organization is a claim on the SESSION, not client state: `activeOrganizationId` is
 * what drives row-level security in the API. So switching is a server call, and on success the
 * entire query cache is cleared rather than selectively invalidated — every cached list belongs
 * to the organization it was fetched under, and showing one tenant's extensions under another's
 * name for even a frame is the worst bug this app could have.
 */
export function OrganizationSwitcher() {
	const queryClient = useQueryClient();
	const session = useAppSession();
	const { data: organizations = [] } = useMyOrganizations();
	const [createOpen, setCreateOpen] = useState(false);

	const active = session.activeOrganization;

	const switchOrganization = useMutation({
		mutationFn: async (organizationId: string) => {
			const result = await organization.setActive({ organizationId });
			if (result.error) {
				throw new Error(authErrorMessage(result.error));
			}
		},
		onSuccess: async () => {
			await queryClient.cancelQueries();
			queryClient.clear();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	return (
		<>
			<Menu>
				<MenuTrigger
					className={cn(
						"flex w-full items-center gap-2 rounded-field px-2 py-2 text-left transition-colors duration-[--motion-fast]",
						"hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
					)}
				>
					<span
						aria-hidden="true"
						className="flex size-7 shrink-0 items-center justify-center rounded-field bg-primary text-xs font-semibold text-primary-foreground"
					>
						{(active?.name ?? "?").slice(0, 1).toUpperCase()}
					</span>
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate text-sm font-medium text-foreground">
							{active?.name ?? "No organization"}
						</span>
						<span className="truncate text-xs text-muted-foreground">
							{active ? roleLabel(active.role) : "Create one to get started"}
						</span>
					</span>
					<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
				</MenuTrigger>

				<MenuContent className="w-60">
					<MenuLabel>Organizations</MenuLabel>
					{organizations.map((item) => (
						<MenuItem
							key={item.id}
							disabled={switchOrganization.isPending}
							onClick={() => {
								if (item.id !== active?.id) {
									switchOrganization.mutate(item.id);
								}
							}}
						>
							<BuildingIcon />
							<span className="min-w-0 flex-1 truncate">{item.name}</span>
							{item.id === active?.id ? <CheckIcon className="text-primary!" /> : null}
						</MenuItem>
					))}
					{organizations.length === 0 ? (
						<p className="px-2 py-1.5 text-sm text-muted-foreground">You have no organizations.</p>
					) : null}
					<MenuSeparator />
					<MenuItem onClick={() => setCreateOpen(true)}>
						<PlusIcon />
						New organization
					</MenuItem>
				</MenuContent>
			</Menu>

			<CreateOrganizationDialog open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
}
