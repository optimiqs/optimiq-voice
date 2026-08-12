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
	createCdrExport,
	deleteCdrExport,
	deleteRecording,
	fetchQueueStats,
	getCall,
	isSettledExportStatus,
	listCallLegs,
	listCdrExports,
	listRecordings,
	mintCdrExportDownloadUrl,
	mintRecordingDownloadUrl,
	queueStatsParams,
	type CdrExportFilters,
	type CdrExportListQuery,
	type CdrListQuery,
	type QueueStatsQuery,
	type RecordingListQuery,
} from "~/lib/cdr/client";
import { pbxToastMessage } from "~/lib/pbx/errors";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization, usePermission } from "../_context/session-context";
import type {
	CallDetail,
	CallLegRow,
	CdrExportDownloadLink,
	CdrExportRow,
	CursorEnvelope,
	QueueStatsEnvelope,
	QueueStatsRow,
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
 * ## What invalidates, and what deliberately does not
 *
 * There is no mutation against `call_legs` and there cannot be: it is append-only by privilege, so
 * nothing in this file can invalidate the call list. The download mints deliberately do not touch
 * the cache either — no row changed, only a short-lived URL was created.
 *
 * The two things that DO write are a recording delete (which tombstones a row this app renders) and
 * the export lifecycle (whose jobs this app creates and removes). Each invalidates its own subtree
 * and nothing else: queuing an export must not evict the page of history somebody is reading.
 *
 * ## The two polled queries in the app, and why they poll differently
 *
 * Both exceptions to `lib/query-client.ts`'s `staleTime: Infinity` are here, and neither could be
 * a live topic: an export finishes in another process with no event to say so, and a service level
 * is an aggregate over a window that moves on its own.
 *
 * `useCdrExportList`'s interval is a FUNCTION of the data and returns `false` once every job is
 * terminal, so its poll is bounded by the WORK. `useQueueStats` polls at a fixed interval for as
 * long as the page is open, because a wallboard is never "done" — it is bounded by the SCREEN, and
 * that is exactly the trade a wallboard is asking for.
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

/**
 * How often the wallboard's service level is re-asked.
 *
 * Thirty seconds, and the choice is a compromise between two real costs. The query is a grouped
 * aggregate over a partitioned ledger — cheap on a partial index, not free — and the number it
 * produces moves only when calls END, so a five-second poll would run it six times to show the same
 * percentage. Half a minute is also about as long as a supervisor will watch a stale SLA tile
 * before distrusting the whole screen.
 *
 * It is a POLL rather than a live topic because there is no event for "the service level changed":
 * it is an aggregate over a window, and the window itself moves.
 */
export const QUEUE_STATS_REFETCH_MS = 30_000;

export interface QueueStatsResult {
	readonly query: UseQueryResult<QueueStatsEnvelope>;
	readonly rows: readonly QueueStatsRow[];
	/** Keyed by queue id, so a per-queue tile is a lookup rather than a scan per render. */
	readonly byQueueId: ReadonlyMap<string, QueueStatsRow>;
	/** The window and the target the SERVER applied, which is what the page should say it shows. */
	readonly range: { readonly from: string; readonly to: string } | undefined;
	readonly slaSeconds: number | undefined;
}

/**
 * Queue service level over a window.
 *
 * `enabled` on `queues.monitor` rather than on `cdr.read`: that is what the endpoint is guarded
 * with, and asking without it would put a red line on every agent console for a request that can
 * only 403. An agent HOLDS `queues.monitor`, which is the intended shape — seeing how their own
 * queue is doing is the point of a wallboard, and it is strictly less than the `queues.read` they
 * already have.
 *
 * `placeholderData: previous` for the reason the list has it: changing the target or the window is
 * a new cache entry, and a wallboard that blanked its numbers every time somebody moved the SLA
 * control would flash on a screen people are watching from across a room.
 */
export function useQueueStats(
	query: QueueStatsQuery,
	options: { readonly enabled?: boolean } = {},
): QueueStatsResult {
	const organizationId = useOrganizationId();
	const permitted = usePermission("queues.monitor");
	const params = queueStatsParams(query);

	const result = useQuery({
		queryKey: queryKeys.queueStats(organizationId, params),
		queryFn: () => fetchQueueStats(query),
		enabled: organizationId.length > 0 && permitted && (options.enabled ?? true),
		placeholderData: (previous) => previous,
		refetchInterval: QUEUE_STATS_REFETCH_MS,
	});

	const rows = result.data?.data ?? [];
	return {
		query: result,
		rows,
		byQueueId: new Map(rows.map((row) => [row.queueId, row])),
		range: result.data?.range,
		slaSeconds: result.data?.slaSeconds,
	};
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

/**
 * Deletes a recording's media.
 *
 * The one mutation in this file that DOES invalidate, and the only write the reporting area has
 * against a row it renders: the object goes and the row survives as a tombstone with `deletedAt`
 * set, which the recordings list shows. Patching the row optimistically would be guessing at a
 * timestamp the server writes, so the list is refetched instead.
 */
export function useDeleteRecording(): UseMutationResult<{ readonly id: string }, Error, string> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return useMutation({
		mutationFn: (id: string) => deleteRecording(id),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.recordings(organizationId),
			});
			toast.success("Recording deleted", {
				description:
					"The audio is gone. The row stays as a record that a recording existed and was removed.",
			});
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not delete this recording"));
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

/**
 * How often an unsettled export job is re-read.
 *
 * Three seconds. The work is a full scan of a window that may be a year wide, so a shorter interval
 * would be a request per second answering "still running"; a much longer one makes a small export —
 * most of them — look stuck for longer than it took. The poll STOPS the moment every job on the
 * page is terminal, which is the property that matters more than the number.
 */
const EXPORT_POLL_MS = 3_000;

export interface CdrExportListResult {
	readonly query: UseQueryResult<CursorEnvelope<CdrExportRow>>;
	readonly rows: readonly CdrExportRow[];
	readonly nextCursor: string | null;
	/** Whether anything on this page is still moving — what a "working" indicator reads. */
	readonly pending: boolean;
}

/**
 * The export jobs, polled while any of them is unsettled.
 *
 * ## Why polling, in an app whose `staleTime` is `Infinity`
 *
 * Every other cache entry here is invalidated by an EVENT: a mutation this app made, or a frame on
 * the live socket. An export finishes because a worker in another process finished it, and there is
 * no topic in `LIVE_TOPIC_KINDS` that carries that — so there is nothing to invalidate on, and a
 * user staring at "Queued" until they press reload is the alternative. `refetchInterval` is a
 * function rather than a number precisely so this is bounded: it consults the DATA and returns
 * `false` once every job on the page is `succeeded` or `failed`, so a page of finished exports
 * costs nothing and a tab left open overnight does not.
 *
 * `isSettledExportStatus` is the shared predicate rather than an inline comparison here, so the
 * poll's stopping condition and anything that renders a spinner cannot disagree.
 */
export function useCdrExportList(query: CdrExportListQuery = {}): CdrExportListResult {
	const organizationId = useOrganizationId();
	const result = useQuery({
		queryKey: queryKeys.cdrExportList(organizationId, { ...query }),
		queryFn: () => listCdrExports(query),
		enabled: organizationId.length > 0,
		placeholderData: (previous) => previous,
		refetchInterval: (fetched) => {
			const rows = fetched.state.data?.data;
			if (rows === undefined) {
				return false;
			}
			return rows.some((row) => !isSettledExportStatus(row.status)) ? EXPORT_POLL_MS : false;
		},
	});

	const rows = result.data?.data ?? [];
	return {
		query: result,
		rows,
		nextCursor: result.data?.nextCursor ?? null,
		pending: rows.some((row) => !isSettledExportStatus(row.status)),
	};
}

/**
 * Queues an export.
 *
 * Invalidates the job list so the new row appears — which also restarts the poll, because the list
 * now holds something unsettled. The toast says "queued" rather than "exported": the server
 * answered `202`, the file does not exist yet, and it may never exist if the job hits the row cap.
 */
export function useCreateCdrExport(): UseMutationResult<
	CdrExportRow,
	Error,
	CdrExportFilters & { readonly label?: string | undefined }
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return useMutation({
		mutationFn: (body: CdrExportFilters & { readonly label?: string | undefined }) =>
			createCdrExport(body),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.cdrExports(organizationId),
			});
			toast.success("Export queued", {
				description: "It runs in the background. The list below shows when the file is ready.",
			});
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not queue this export"));
		},
	});
}

/** Mints a download URL. Never cached, for the reason {@link useRecordingDownloadUrl} is not. */
export function useCdrExportDownloadUrl(): UseMutationResult<CdrExportDownloadLink, Error, string> {
	return useMutation({
		mutationFn: (id: string) => mintCdrExportDownloadUrl(id),
	});
}

/** Deletes a job and its file. Rides `cdr.export`; there is no separate delete grant. */
export function useDeleteCdrExport(): UseMutationResult<{ readonly id: string }, Error, string> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();
	return useMutation({
		mutationFn: (id: string) => deleteCdrExport(id),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.cdrExports(organizationId),
			});
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not delete this export"));
		},
	});
}
