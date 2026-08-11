"use client";

import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "~/components/ui/toast";
import {
	fetchSettingCategory,
	NOTIFICATIONS_CATEGORY,
	patchSettingCategory,
	ROUTING_CATEGORY,
	toNotificationSettings,
	toRoutingSettings,
	type NotificationSettings,
	type RoutingSettings,
	type SettingCategoryMutation,
} from "~/lib/org-settings/client";
import { pbxToastMessage } from "~/lib/pbx/errors";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization } from "../_context/session-context";

/**
 * Server state for the settings cascade.
 *
 * ## Why the invalidation reaches the compile view
 *
 * `affectsRouting("org_setting")` is true: the compiler reads eight names in the `routing`
 * category, so a settings save recompiles the tenant's artifact and republishes it. The
 * `notifications` category does not change routing in practice, but the WRITE goes through the
 * same repository and produces the same recompile, so invalidating the compile view is the honest
 * thing to do — a stale "last compiled" timestamp after a save is a lie the user cannot debug.
 */

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

export function useNotificationSettings(): UseQueryResult<NotificationSettings> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.orgSettingsCategory(organizationId, NOTIFICATIONS_CATEGORY),
		queryFn: async () =>
			toNotificationSettings((await fetchSettingCategory(NOTIFICATIONS_CATEGORY)).data),
		enabled: organizationId.length > 0,
	});
}

export function useSaveNotificationSettings(): UseMutationResult<
	SettingCategoryMutation,
	Error,
	Readonly<Record<string, unknown>>
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return useMutation({
		mutationFn: (patch: Readonly<Record<string, unknown>>) =>
			patchSettingCategory(NOTIFICATIONS_CATEGORY, patch),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.orgSettingsCategory(organizationId, NOTIFICATIONS_CATEGORY),
			});
			await queryClient.invalidateQueries({
				queryKey: queryKeys.routingCompile(organizationId),
			});
			toast.success("Notification settings saved");
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not save these settings"));
		},
	});
}

export function useRoutingSettings(): UseQueryResult<RoutingSettings> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.orgSettingsCategory(organizationId, ROUTING_CATEGORY),
		queryFn: async () => toRoutingSettings((await fetchSettingCategory(ROUTING_CATEGORY)).data),
		enabled: organizationId.length > 0,
	});
}

/**
 * Saving the `routing` category, which really does recompile.
 *
 * The invalidation is the same pair as the notifications save, but here it is not a courtesy: the
 * compiler reads all eight of these names, so the write republishes the tenant's artifact before
 * the response comes back. The toast says so — a save that changes what happens to the next live
 * call and reads "Saved" is a surprise the user finds out about from a phone.
 *
 * A save that the compiler REFUSES is rolled back by the API rather than stored, and arrives here
 * as an error; `pbxToastMessage` unwraps the diagnostic. Nothing changed in that case, which is
 * why the message says "not saved" rather than "saved with problems".
 */
export function useSaveRoutingSettings(): UseMutationResult<
	SettingCategoryMutation,
	Error,
	Readonly<Record<string, unknown>>
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return useMutation({
		mutationFn: (patch: Readonly<Record<string, unknown>>) =>
			patchSettingCategory(ROUTING_CATEGORY, patch),
		onSuccess: async (result) => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.orgSettingsCategory(organizationId, ROUTING_CATEGORY),
			});
			await queryClient.invalidateQueries({
				queryKey: queryKeys.routingCompile(organizationId),
			});
			toast.success("Routing settings saved", {
				description:
					result.written.length > 0
						? "Routing was recompiled and republished — this is live on the next call."
						: "Nothing had changed, so nothing was written.",
			});
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Not saved — these settings were rolled back"));
		},
	});
}
