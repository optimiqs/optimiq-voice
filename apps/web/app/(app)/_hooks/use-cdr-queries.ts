"use client";

import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import {
	getCall,
	listCallLegs,
	listRecordings,
	mintRecordingDownloadUrl,
	type CdrListQuery,
	type RecordingListQuery,
} from "~/lib/cdr/client";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization } from "../_context/session-context";
import type {
	CallDetail,
	CallLegRow,
	CursorEnvelope,
	RecordingDownloadLink,
	RecordingRow,
} from "~/lib/cdr/contracts";

/**
 * Server state for the reporting area.
 *
 * ## `placeholderData` and why the range is part of the key
 *
 * Paging keeps the previous page on screen while the next one loads (`placeholderData: previous`),
 * which is what stops a table from collapsing to a spinner on every "Next". The whole query object
 * — including the resolved time range — is the cache key, so changing the range is a NEW query
 * rather than a refetch of the old one: two different windows are two different answers and must
 * never share an entry.
 *
 * ## Nothing here invalidates
 *
 * There is no mutation against `call_legs` and there cannot be: it is append-only by privilege.
 * The one mutation in this file mints a download credential and deliberately does NOT touch the
 * cache — the recording row did not change, only a short-lived URL was created.
 */

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

export interface CdrListResult {
	readonly query: UseQueryResult<CursorEnvelope<CallLegRow>>;
	readonly rows: readonly CallLegRow[];
	readonly nextCursor: string | null;
	/** The window the SERVER applied, which is what the page should say it is showing. */
	readonly range: { readonly from: string; readonly to: string } | undefined;
}

export function useCdrList(query: CdrListQuery): CdrListResult {
	const organizationId = useOrganizationId();
	const result = useQuery({
		queryKey: queryKeys.cdrList(organizationId, { ...query }),
		queryFn: () => listCallLegs(query),
		enabled: organizationId.length > 0,
		placeholderData: (previous) => previous,
	});

	return {
		query: result,
		rows: result.data?.data ?? [],
		nextCursor: result.data?.nextCursor ?? null,
		range: result.data?.range,
	};
}

/**
 * Every leg of one call.
 *
 * Only runs when a row is expanded (`enabled` on the call id), so the list costs one request no
 * matter how many rows it holds. The range travels with it for the reason `client.ts` records: the
 * server bounds this lookup too, and defaulting it to 24 hours would hide the legs of a call the
 * user found by widening the window.
 */
export function useCdrCall(
	callId: string | undefined,
	range: { readonly from?: string; readonly to?: string },
): UseQueryResult<CallDetail> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.cdrCall(organizationId, callId ?? ""),
		queryFn: () => getCall(callId as string, range),
		enabled: organizationId.length > 0 && Boolean(callId),
	});
}

export interface RecordingListResult {
	readonly query: UseQueryResult<CursorEnvelope<RecordingRow>>;
	readonly rows: readonly RecordingRow[];
	readonly nextCursor: string | null;
}

export function useRecordingList(query: RecordingListQuery): RecordingListResult {
	const organizationId = useOrganizationId();
	const result = useQuery({
		queryKey: queryKeys.recordingList(organizationId, { ...query }),
		queryFn: () => listRecordings(query),
		enabled: organizationId.length > 0,
		placeholderData: (previous) => previous,
	});

	return {
		query: result,
		rows: result.data?.data ?? [],
		nextCursor: result.data?.nextCursor ?? null,
	};
}

/**
 * Mints a playback/download URL.
 *
 * A mutation rather than a query, and never cached: the URL expires in minutes, so a cached one is
 * a link that works until it silently does not. Every play or download asks for a fresh one, which
 * costs one request and removes a whole class of "it worked ten minutes ago" reports.
 */
export function useRecordingDownloadUrl(): UseMutationResult<RecordingDownloadLink, Error, string> {
	return useMutation({
		mutationFn: (id: string) => mintRecordingDownloadUrl(id),
	});
}
