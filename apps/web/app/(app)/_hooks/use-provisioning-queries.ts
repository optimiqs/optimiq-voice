"use client";

import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "~/components/ui/toast";
import { pbxErrorCode, pbxToastMessage } from "~/lib/pbx/errors";
import {
	createDevice,
	fetchProvisioningCatalog,
	PROVISIONING_RESOURCES,
	regenerateProvisioningToken,
} from "~/lib/provisioning/client";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization } from "../_context/session-context";
import type { ProvisionedDeviceEnvelope, ProvisioningCatalog } from "~/lib/provisioning/contracts";

/**
 * The two provisioning operations the generic PBX hooks cannot express.
 *
 * Everything else — list, get, patch, delete, the nested lines and keys — goes through
 * `use-pbx-queries.ts` with a `PROVISIONING_RESOURCES` descriptor, because on the wire those ARE
 * PBX resources. What is here is the pair whose responses carry a credential, and that difference
 * is worth a different hook rather than a widened generic: a caller who forgets to handle
 * `provisioning.token` should not typecheck.
 */

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

/**
 * The vendor catalogue.
 *
 * `staleTime: Infinity` and no retry, exactly like the feature-code parameter fields: it describes
 * the deployment's environment, which does not change while a tab is open. The one thing it can be
 * is FORBIDDEN, for a caller without `devices.read`, and the screen treats that as "no catalogue"
 * rather than as an error worth a toast.
 */
export function useProvisioningCatalog(): UseQueryResult<ProvisioningCatalog> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.provisioningCatalog(organizationId),
		queryFn: fetchProvisioningCatalog,
		enabled: organizationId.length > 0,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
}

function useInvalidateDevices(): () => Promise<void> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return async () => {
		await queryClient.invalidateQueries({
			queryKey: queryKeys.pbxResource(organizationId, PROVISIONING_RESOURCES.devices.key),
		});
	};
}

/**
 * Creates a device and hands back the provisioning URL.
 *
 * The token exists in this response and nowhere else — not in the database, not in a later read.
 * The caller is expected to put it on screen behind a "shown once" banner, which is why the
 * mutation's success toast says the device was created and deliberately does NOT mention the URL:
 * a toast disappears, and a credential that disappears is one the administrator will ask for again.
 */
export function useCreateDevice(): UseMutationResult<
	ProvisionedDeviceEnvelope,
	Error,
	Record<string, unknown>
> {
	const invalidate = useInvalidateDevices();
	return useMutation({
		mutationFn: (values: Record<string, unknown>) => createDevice(values),
		onSuccess: async () => {
			await invalidate();
			toast.success("Device created");
		},
		onError: (error) => {
			// A validation failure is already attached to the control that caused it; a toast would be
			// a second copy of the same sentence that then disappears.
			if (pbxErrorCode(error) !== "PBX_INVALID_BODY") {
				toast.error(pbxToastMessage(error, "Could not create the device"));
			}
		},
	});
}

/**
 * Rotates a device's provisioning token.
 *
 * The previous URL stops resolving at the instant this returns — a single UPDATE, so there is no
 * window in which both work and none in which neither does. The confirmation dialog says so before
 * the click, because a phone provisioned from the old URL will not fetch a new configuration until
 * somebody re-enters the new one.
 */
export function useRegenerateProvisioningToken(
	deviceId: string,
): UseMutationResult<ProvisionedDeviceEnvelope, Error, { readonly expiresInDays?: number }> {
	const invalidate = useInvalidateDevices();
	return useMutation({
		mutationFn: (body: { readonly expiresInDays?: number }) =>
			regenerateProvisioningToken(deviceId, body),
		onSuccess: async () => {
			await invalidate();
			toast.success("Provisioning URL rotated");
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not rotate the provisioning URL"));
		},
	});
}
