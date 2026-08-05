"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { toast } from "~/components/ui/toast";
import { apiKey, authErrorMessage } from "~/lib/auth-client";
import { queryKeys } from "~/lib/query-keys";

/**
 * API keys, scoped to the active organization.
 *
 * The server sets `references: "organization"` (`packages/auth/src/auth.ts`), so a key belongs to
 * the tenant rather than to whoever happened to create it — a departing administrator does not
 * take the integrations with them.
 *
 * `organizationId` is therefore passed EXPLICITLY on every call, and its absence is not a
 * harmless default: `/api-key/list` without it returns the caller's USER-owned keys instead of
 * the organization's (`@better-auth/api-key` dist/index.mjs:1277), so the page would look
 * permanently empty while keys existed. `/api-key/create` without it rejects with a 400.
 */

export interface ApiKeySummary {
	readonly id: string;
	readonly name: string | null;
	readonly start: string | null;
	readonly prefix: string | null;
	readonly enabled: boolean;
	readonly createdAt: Date | string;
	readonly expiresAt: Date | string | null;
	readonly lastRequest: Date | string | null;
}

export function useApiKeys(organizationId: string | undefined): UseQueryResult<ApiKeySummary[]> {
	return useQuery({
		queryKey: queryKeys.apiKeys(organizationId ?? ""),
		queryFn: async () => {
			const result = await apiKey.list({
				query: { organizationId: organizationId as string },
			});
			if (result.error) {
				throw new Error(authErrorMessage(result.error));
			}
			// `list` answers a paged envelope, not a bare array.
			return (result.data?.apiKeys ?? []) as ApiKeySummary[];
		},
		enabled: Boolean(organizationId),
	});
}

/** Days → milliseconds. better-auth takes `expiresIn` as a duration, not a date. */
const DAY_MS = 24 * 60 * 60 * 1000;

export function useCreateApiKey(organizationId: string | undefined) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async ({ name, expiresInDays }: { name: string; expiresInDays: number | null }) => {
			const result = await apiKey.create({
				name: name.trim(),
				organizationId: organizationId as string,
				...(expiresInDays === null ? {} : { expiresIn: expiresInDays * DAY_MS }),
			});
			if (result.error) {
				throw new Error(authErrorMessage(result.error));
			}
			return result.data;
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(organizationId ?? "") });
		},
		onError: (error: Error) => toast.error(error.message),
	});
}

export function useRevokeApiKey(organizationId: string | undefined) {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (keyId: string) => {
			const result = await apiKey.delete({ keyId });
			if (result.error) {
				throw new Error(authErrorMessage(result.error));
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(organizationId ?? "") });
			toast.success("API key revoked");
		},
		onError: (error: Error) => toast.error(error.message),
	});
}
