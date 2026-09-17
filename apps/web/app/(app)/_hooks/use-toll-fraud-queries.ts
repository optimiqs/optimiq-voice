"use client";

import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "~/components/ui/toast";
import { pbxToastMessage } from "~/lib/pbx/errors";
import { queryKeys } from "~/lib/query-keys";
import {
	fetchTollFraudOverrides,
	fetchTollFraudPolicy,
	fetchTollFraudUsage,
	suspendExtensionOutbound,
	writeTollFraudOverride,
	writeTollFraudPolicy,
	type ExtensionTollFraudOverride,
	type TollFraudPolicy,
	type TollFraudUsage,
	type WriteExtensionTollFraudOverride,
	type WriteTollFraudPolicy,
} from "~/lib/toll-fraud/client";
import { useActiveOrganization } from "../_context/session-context";

/**
 * Server state for `/api/v1/toll-fraud`.
 *
 * ## Every write invalidates the whole area, on purpose
 *
 * The three queries are three views of one decision. A ceiling that moves changes the usage panel's
 * ratios; an override that is written changes which extensions are shown as departing from the
 * policy; a suspension changes both. Invalidating the coarse `tollFraud` handle rather than the
 * exact key is what keeps them from disagreeing, and the cost is one extra fetch of a response
 * measured in a few hundred bytes.
 *
 * The usage query is the one refetched on mount rather than trusted: the numbers move because calls
 * happened, and no mutation in this app makes them move.
 */

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

export function useTollFraudPolicy(): UseQueryResult<TollFraudPolicy | null> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.tollFraudPolicy(organizationId),
		queryFn: fetchTollFraudPolicy,
		enabled: organizationId.length > 0,
	});
}

export function useTollFraudUsage(): UseQueryResult<TollFraudUsage> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.tollFraudUsage(organizationId),
		queryFn: fetchTollFraudUsage,
		enabled: organizationId.length > 0,
		refetchOnMount: "always",
	});
}

export function useTollFraudOverrides(): UseQueryResult<readonly ExtensionTollFraudOverride[]> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.tollFraudOverrides(organizationId),
		queryFn: fetchTollFraudOverrides,
		enabled: organizationId.length > 0,
	});
}

export function useSaveTollFraudPolicy(): UseMutationResult<
	TollFraudPolicy,
	Error,
	WriteTollFraudPolicy
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return useMutation({
		mutationFn: writeTollFraudPolicy,
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.tollFraud(organizationId) });
			toast.success("Fraud controls saved", {
				description: "The next international call is placed against these limits.",
			});
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Not saved — the fraud controls are unchanged"));
		},
	});
}

export function useSaveTollFraudOverride(): UseMutationResult<
	ExtensionTollFraudOverride,
	Error,
	{ readonly extensionId: string; readonly values: WriteExtensionTollFraudOverride }
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return useMutation({
		mutationFn: ({ extensionId, values }) => writeTollFraudOverride(extensionId, values),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.tollFraud(organizationId) });
		},
	});
}

export function useSuspendExtensionOutbound(): UseMutationResult<
	ExtensionTollFraudOverride,
	Error,
	{ readonly extensionId: string; readonly suspended: boolean; readonly reason?: string }
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return useMutation({
		mutationFn: ({ extensionId, suspended, reason }) =>
			suspendExtensionOutbound(extensionId, suspended ? { suspended, reason } : { suspended }),
		onSuccess: async (_result, variables) => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.tollFraud(organizationId) });
			toast.success(
				variables.suspended
					? "Outbound calling suspended for this extension"
					: "Outbound calling restored for this extension",
			);
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Not changed — this extension is as it was"));
		},
	});
}
