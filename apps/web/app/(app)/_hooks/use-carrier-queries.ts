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
	fetchCarrierStatus,
	orderNumber,
	provisionTrunk,
	releaseNumber,
	searchAvailableNumbers,
	type AvailableNumber,
	type CarrierStatus,
	type NumberSearchQuery,
	type OrderNumberBody,
	type ProvisionTrunkBody,
	type TrunkCredentials,
} from "~/lib/carrier/client";
import { pbxErrorCode, pbxToastMessage } from "~/lib/pbx/errors";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization } from "../_context/session-context";
import type { MutationEnvelope, PhoneNumberRow, TrunkRow } from "~/lib/pbx/contracts";

/**
 * Server state for the carrier surface.
 *
 * ## The unconfigured deployment is a normal state, not an error
 *
 * A deployment with no carrier answers 503 `CARRIER_NOT_CONFIGURED` on every carrier endpoint. The
 * hooks here never toast that: it is not something the user did, and a red banner saying "request
 * failed" on a page they just opened is noise. The panels read `useCarrierStatus` and render a
 * callout explaining what an operator needs to set, which is the only actionable thing anyone can
 * do about it.
 *
 * ## Invalidation reaches further than the carrier's own keys
 *
 * Buying a number creates a `phone_number` row, so the order mutation invalidates the whole
 * `phone-numbers` subtree — the list, every page of it, every destination picker reading it, and
 * (because the search key lives under that subtree) the "available numbers" results, so a number
 * that was just bought stops being offered. Provisioning a trunk does the same for `trunks`.
 * Both also invalidate the compile view, because both tables are routing inputs.
 */

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

/** True when the failure is "this deployment has no carrier", which the page explains in place. */
function isCarrierUnconfigured(error: unknown): boolean {
	const code = pbxErrorCode(error);
	return code === "CARRIER_NOT_CONFIGURED" || code === "CARRIER_WEBHOOK_NOT_CONFIGURED";
}

export function useCarrierStatus(): UseQueryResult<CarrierStatus> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.carrierStatus(organizationId),
		queryFn: fetchCarrierStatus,
		enabled: organizationId.length > 0,
	});
}

export interface AvailableNumbersResult {
	readonly query: UseQueryResult<{
		readonly data: readonly AvailableNumber[];
		readonly total: number;
	}>;
	readonly rows: readonly AvailableNumber[];
}

/**
 * The search.
 *
 * `enabled` is the caller's, and it defaults to off: a search is a live call to the carrier that
 * costs a round trip and marks every number it returns as orderable, so it must happen when a user
 * asks for it and not when a tab renders.
 */
export function useAvailableNumbers(
	query: NumberSearchQuery,
	options: { readonly enabled: boolean },
): AvailableNumbersResult {
	const organizationId = useOrganizationId();
	const result = useQuery({
		queryKey: queryKeys.carrierNumberSearch(organizationId, {
			country: query.country,
			areaCode: query.areaCode ?? null,
			contains: query.contains ?? null,
			numberType: query.numberType ?? null,
			limit: query.limit ?? null,
		}),
		queryFn: () => searchAvailableNumbers(query),
		enabled: organizationId.length > 0 && options.enabled,
		placeholderData: (previous) => previous,
	});
	return { query: result, rows: result.data?.data ?? [] };
}

function useInvalidateAfterCarrierWrite(resourceKey: string): () => Promise<void> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return async () => {
		await queryClient.invalidateQueries({
			queryKey: queryKeys.pbxResource(organizationId, resourceKey),
		});
		await queryClient.invalidateQueries({
			queryKey: queryKeys.routingCompile(organizationId),
		});
	};
}

export function useOrderNumber(): UseMutationResult<
	MutationEnvelope<PhoneNumberRow>,
	Error,
	OrderNumberBody
> {
	const invalidate = useInvalidateAfterCarrierWrite("phone-numbers");
	return useMutation({
		mutationFn: (body: OrderNumberBody) => orderNumber(body),
		onSuccess: async (result) => {
			await invalidate();
			toast.success(`${result.data.e164} is yours`, {
				description: "The number is in your list and routing to the destination you chose.",
			});
		},
		onError: (error) => {
			if (isCarrierUnconfigured(error)) {
				return;
			}
			toast.error(pbxToastMessage(error, "Could not order that number"));
		},
	});
}

/**
 * Delete a DID and give it back to the carrier.
 *
 * Separate from `usePbxDelete` because it calls a different endpoint with a different consequence,
 * and the Numbers screen picks between them by looking at `carrierProvider`. Folding them together
 * would make "remove this from the organization but keep the number" — which is what a migration
 * between tenants needs — unexpressible.
 */
export function useReleaseNumber(): UseMutationResult<
	MutationEnvelope<{ readonly id: string }>,
	Error,
	string
> {
	const invalidate = useInvalidateAfterCarrierWrite("phone-numbers");
	return useMutation({
		mutationFn: (id: string) => releaseNumber(id),
		onSuccess: async (result) => {
			await invalidate();
			// A release that the carrier did not confirm still deleted the row, and the warning says
			// the number may still be billed. It is a success with a caveat, not a failure.
			if (result.warnings.length > 0) {
				toast.success("Number removed", {
					description: result.warnings[0]?.message ?? "See the details on screen.",
				});
				return;
			}
			toast.success("Number released", {
				description: "It has been returned to the carrier and will stop being billed.",
			});
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not release that number"));
		},
	});
}

export function useProvisionTrunk(
	trunkId: string,
): UseMutationResult<
	MutationEnvelope<TrunkRow> & { readonly carrier: TrunkCredentials },
	Error,
	ProvisionTrunkBody
> {
	const invalidate = useInvalidateAfterCarrierWrite("trunks");
	return useMutation({
		mutationFn: (body: ProvisionTrunkBody) => provisionTrunk(trunkId, body),
		onSuccess: async (result) => {
			await invalidate();
			toast.success(result.carrier.reprovisioned ? "Trunk re-provisioned" : "Trunk provisioned", {
				description: result.carrier.reprovisioned
					? "The SIP password has been rotated. Update the endpoint before the current registration expires."
					: "The SIP credentials are on screen. This is the only time the password is shown.",
			});
		},
		onError: (error) => {
			if (isCarrierUnconfigured(error)) {
				return;
			}
			toast.error(pbxToastMessage(error, "Could not provision the trunk"));
		},
	});
}
