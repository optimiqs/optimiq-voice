"use client";

import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "~/components/ui/toast";
import { fetchBranding, updateBranding } from "~/lib/branding/client";
import { DEFAULT_BRANDING, type Branding } from "~/lib/branding/contracts";
import { pbxToastMessage } from "~/lib/pbx/errors";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization } from "../_context/session-context";

/**
 * Server state for the organization's white-label branding.
 *
 * The read is `placeholderData: DEFAULT_BRANDING` so the theme and the shell always have a brand to
 * render — the default one — from the very first paint, and a resolved tenant brand simply replaces
 * it. That is what lets `BrandingProvider` apply the theme without a loading flash, and what makes a
 * still-being-built backend degrade to the default app rather than a blank one.
 */

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

export function useBranding(): UseQueryResult<Branding> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.branding(organizationId),
		queryFn: fetchBranding,
		enabled: organizationId.length > 0,
		placeholderData: DEFAULT_BRANDING,
		// Branding changes rarely and a failed read must not spin — one retry, then the default stands.
		retry: 1,
	});
}

export function useSaveBranding(): UseMutationResult<Branding, Error, Partial<Branding>> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return useMutation({
		mutationFn: (patch: Partial<Branding>) => updateBranding(patch),
		onSuccess: async (result) => {
			// Seed the cache with the resolved result so the theme updates the instant the save lands,
			// then invalidate to reconcile with the server's own read.
			queryClient.setQueryData(queryKeys.branding(organizationId), result);
			await queryClient.invalidateQueries({ queryKey: queryKeys.branding(organizationId) });
			toast.success("Branding saved", {
				description: "The new colours and name apply across the app immediately.",
			});
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not save branding"));
		},
	});
}
