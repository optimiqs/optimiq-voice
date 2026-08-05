import { useQuery } from "@tanstack/react-query";
import { type ListCallsRequest as ResourceListRequest } from "@optimiq-voice/types";
import { useOptimiqVoice } from "~/core/sdk/hooks/use-optimiq-voice";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";

/**
 * Constant query key used to cache and track the list of calls.
 * Should be used consistently to avoid query duplication and cache mismatch.
 */
export const COLLECTION_QUERY_KEY = ["collection:calls"];

/**
 * Hook to fetch the list of calls using the Optimiq Voice SDK.
 *
 * This hook uses React Query's `useQuery` to:
 * - Fetch the call list from the backend.
 * - Automatically manage loading and error states.
 * - Cache the data for performance and offline support.
 *
 * @param params - Optional parameters to filter or paginate the list of calls.
 * @returns A React Query object containing call data and query metadata.
 */
export const useCalls = (params?: ResourceListRequest) => {
	const { sdk } = useOptimiqVoice();
	const workspaceId = useWorkspaceId();

	const { data, ...rest } = useQuery({
		queryKey: [...COLLECTION_QUERY_KEY, workspaceId, params],
		queryFn: async () => await sdk.calls.listCalls({ ...params }),
	});

	return {
		data: data?.items || [],
		nextPageToken: data?.nextPageToken,
		...rest,
	};
};
