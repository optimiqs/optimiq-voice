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
	fetchOwnSettings,
	fetchSettingCategory,
	NOTIFICATIONS_CATEGORY,
	patchOwnCategory,
	patchSettingCategory,
	RECORDINGS_CATEGORY,
	ROUTING_CATEGORY,
	toNotificationSettings,
	toOwnNotificationSettings,
	toRecordingSettings,
	toRoutingSettings,
	type NotificationSettings,
	type OwnNotificationSettings,
	type RecordingSettings,
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

/**
 * The `recordings` category — one setting, and the only category with a permission override.
 *
 * Reading is `settings.read` like every other category; WRITING is `recordings.configure`, which
 * the service checks against `CATEGORY_PERMISSIONS` rather than the controller's `settings.write`
 * floor. That split is deliberate on the server's side and is why the page renders read-only for a
 * role that lacks the narrower grant: `settings.write` is held by everyone who manages ordinary
 * tenant configuration, and shortening an organization's evidence window is not that.
 */
export function useRecordingSettings(): UseQueryResult<RecordingSettings> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.orgSettingsCategory(organizationId, RECORDINGS_CATEGORY),
		queryFn: async () =>
			toRecordingSettings((await fetchSettingCategory(RECORDINGS_CATEGORY)).data),
		enabled: organizationId.length > 0,
	});
}

/**
 * Saving the retention window.
 *
 * The compile view is invalidated for the same reason the notifications save invalidates it: the
 * write goes through the same repository and produces the same recompile, and a stale "last
 * compiled" after a save is a lie the user cannot debug. Nothing in the compiled artifact depends
 * on this value.
 *
 * The toast says what a new window does NOT do, and that matters more than confirming the save:
 * `retention_until` is stamped when a recording is WRITTEN, so a change here reaches recordings
 * made after it and never re-stamps the ones already in the table. Somebody who shortens the window
 * expecting last year's audio to start disappearing has to be told otherwise at the moment they
 * press the button, not when they go looking for it.
 */
export function useSaveRecordingSettings(): UseMutationResult<
	SettingCategoryMutation,
	Error,
	Readonly<Record<string, unknown>>
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return useMutation({
		mutationFn: (patch: Readonly<Record<string, unknown>>) =>
			patchSettingCategory(RECORDINGS_CATEGORY, patch),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.orgSettingsCategory(organizationId, RECORDINGS_CATEGORY),
			});
			await queryClient.invalidateQueries({
				queryKey: queryKeys.routingCompile(organizationId),
			});
			toast.success("Recording policy saved", {
				description:
					"It applies to recordings made from now on. Existing recordings keep the window they were stamped with.",
			});
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not save the recording policy"));
		},
	});
}

/**
 * The caller's own preferences — the third level of the cascade, over `user_setting`.
 *
 * NOT scoped by category in the key, because the endpoint is not: `GET …/me` answers with every
 * user-scoped category at once, so there is one cache entry and one request no matter how many
 * categories eventually have a user level. It is filed under the settings subtree all the same, so
 * an organization switch takes it — a cached copy of the previous tenant's preferences is exactly
 * what that sweep exists for.
 */
export function useOwnSettings(): UseQueryResult<OwnNotificationSettings> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.ownSettings(organizationId),
		queryFn: async () => toOwnNotificationSettings((await fetchOwnSettings()).data),
		enabled: organizationId.length > 0,
	});
}

/**
 * Saving one category of the caller's own preferences.
 *
 * Whose row is written is not negotiable and is not a parameter: the server writes
 * `userId: session.user.id` and takes no user id from anywhere, so there is nothing to send and
 * nothing to get wrong. `settings.write.own` on the route is a floor; own-ness is structural.
 *
 * The ORGANIZATION's category cache is deliberately NOT invalidated. A `user_setting` row changes
 * what is in force for one person and leaves `org_setting` untouched, so evicting the org category
 * would refetch a value that cannot have changed — and would do it on a screen most of whose users
 * do not hold `settings.read` and would meet a 403 for their trouble.
 */
export function useSaveOwnSettings(): UseMutationResult<
	SettingCategoryMutation,
	Error,
	Readonly<Record<string, unknown>>
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return useMutation({
		mutationFn: (patch: Readonly<Record<string, unknown>>) =>
			patchOwnCategory(NOTIFICATIONS_CATEGORY, patch),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.ownSettings(organizationId),
			});
			toast.success("Your preferences were saved");
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not save your preferences"));
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
