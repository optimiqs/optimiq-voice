import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";

/**
 * `staleTime: Infinity` is deliberate. A PBX admin surface is driven by server events, not by
 * polling: the P2 WebSocket fan-out will invalidate the affected keys the moment the backend
 * publishes, and until then a cached list is exactly as fresh as the last thing that changed it.
 * Refetch-on-focus would only add load and flicker.
 *
 * Retrying a 4xx is always wrong — a 401 will still be a 401, and a 403 re-asks a question the
 * permission guard has already answered.
 */
const MAX_RETRIES = 2;

export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: Number.POSITIVE_INFINITY,
				gcTime: 10 * 60 * 1000,
				refetchOnWindowFocus: false,
				refetchOnReconnect: false,
				retry: (failureCount, error) => {
					if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
						return false;
					}
					return failureCount < MAX_RETRIES;
				},
			},
			mutations: {
				retry: false,
			},
		},
	});
}
