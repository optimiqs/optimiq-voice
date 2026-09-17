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
import { decidePlatformKyc, fetchTraceback, listPlatformKyc } from "~/lib/platform/client";
import { queryKeys } from "~/lib/query-keys";
import type {
	KycDecisionInput,
	PlatformKycEntry,
	PlatformKycListQuery,
	PlatformKycPage,
	TracebackQuery,
	TracebackResult,
} from "~/lib/platform/contracts";

/**
 * The two cross-tenant operator queries.
 *
 * Kept out of `use-pbx-queries.ts` for the reason `lib/platform/` is its own directory: nothing here
 * is scoped to the caller's organization, so none of the organization-keyed invalidation sweeps in
 * that file apply and none of them should reach these.
 */

/** One page of the review queue. Not cached across a decision — see {@link useKycDecision}. */
export function usePlatformKycQueue(query: PlatformKycListQuery): UseQueryResult<PlatformKycPage> {
	return useQuery({
		queryKey: queryKeys.platformKycQueue({ ...query }),
		queryFn: () => listPlatformKyc(query),
	});
}

/**
 * Records a verdict.
 *
 * Invalidates the WHOLE queue subtree rather than one page, because a decision moves a row between
 * filters: approving the file a reviewer is looking at on `?decision=pending` removes it from that
 * page and adds it to another, and a targeted invalidation would leave the page they switch to
 * showing the old verdict.
 */
export function useKycDecision(): UseMutationResult<
	PlatformKycEntry,
	Error,
	{ readonly organizationId: string; readonly input: KycDecisionInput }
> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ organizationId, input }) => await decidePlatformKyc(organizationId, input),
		onSuccess: async (entry) => {
			await queryClient.invalidateQueries({ queryKey: ["platform", "compliance", "kyc"] });
			toast.success("Decision recorded", {
				description: `${entry.organizationName ?? entry.legalEntityName} is now ${entry.decision}. The tenant sees it on their own compliance page.`,
			});
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not record that decision"));
		},
	});
}

/**
 * One traceback.
 *
 * `enabled` is the caller's, and every caller passes it: a traceback is a question somebody types,
 * not something a page asks on mount. Firing one on render would write an audit row for a query
 * nobody made — and every read of this endpoint is audited, which is the whole reason it is allowed
 * to cross tenants at all.
 */
export function useTraceback(
	query: TracebackQuery,
	options: { readonly enabled: boolean },
): UseQueryResult<TracebackResult> {
	return useQuery({
		queryKey: queryKeys.platformTraceback({ ...query }),
		queryFn: () => fetchTraceback(query),
		enabled: options.enabled,
	});
}
