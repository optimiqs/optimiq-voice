import { apiFetch } from "../api-client";
import type {
	CallDetail,
	CallLegDetail,
	CallLegRow,
	CdrExportDownloadLink,
	CdrExportRow,
	CdrExportStatus,
	CursorEnvelope,
	RecordingDownloadLink,
	RecordingRow,
} from "./contracts";

/** The API's own ceiling. Asking for more is a 400, so the page-size control stops here. */
export const MAX_CDR_LIMIT = 100;
export const DEFAULT_CDR_LIMIT = 25;
/** Matches `MAX_RANGE_DAYS` in `apps/api/src/cdr/query/cdr.dto.ts`. */
export const MAX_RANGE_DAYS = 92;

export interface CdrListQuery {
	readonly from?: string | undefined;
	readonly to?: string | undefined;
	readonly direction?: string | undefined;
	readonly disposition?: string | undefined;
	readonly hangupCause?: string | undefined;
	readonly leg?: string | undefined;
	readonly extension?: string | undefined;
	readonly did?: string | undefined;
	readonly recorded?: boolean | undefined;
	readonly search?: string | undefined;
	readonly limit?: number | undefined;
	readonly cursor?: string | undefined;
}

export interface RecordingListQuery {
	readonly from?: string | undefined;
	readonly to?: string | undefined;
	readonly kind?: string | undefined;
	readonly callId?: string | undefined;
	readonly search?: string | undefined;
	readonly limit?: number | undefined;
	readonly cursor?: string | undefined;
}

/**
 * Builds the query string, omitting everything the caller did not set.
 *
 * Omitting rather than sending empty values matters twice over: the server DEFAULTS an absent
 * range to the last 24 hours (so `from=` would be a parse error rather than "no filter"), and the
 * parameter set is the React Query cache key — sending `direction=` and omitting `direction` have
 * to be one cache entry, not two.
 */
export function cdrSearchParams(query: Record<string, unknown>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}
		params.set(key, String(value));
	}
	return params.toString();
}

export async function listCallLegs(query: CdrListQuery): Promise<CursorEnvelope<CallLegRow>> {
	return await apiFetch<CursorEnvelope<CallLegRow>>(`/cdr?${cdrSearchParams({ ...query })}`);
}

export async function getCallLeg(
	id: string,
	options: { readonly startedAt?: string; readonly from?: string; readonly to?: string } = {},
): Promise<CallLegDetail> {
	const { data } = await apiFetch<{ data: CallLegDetail }>(
		`/cdr/${id}?${cdrSearchParams({ ...options })}`,
	);
	return data;
}

/**
 * Every leg of one call.
 *
 * The range is passed through from the list the user was looking at, so expanding a row cannot
 * fail to find the legs it just rendered — the server bounds this lookup by the same window, and a
 * default 24-hour bound would miss the B-legs of a call the user found by widening to a month.
 */
export async function getCall(
	callId: string,
	options: { readonly from?: string; readonly to?: string } = {},
): Promise<CallDetail> {
	const { data } = await apiFetch<{ data: CallDetail }>(
		`/cdr/calls/${callId}?${cdrSearchParams({ ...options })}`,
	);
	return data;
}

export async function listRecordings(
	query: RecordingListQuery,
): Promise<CursorEnvelope<RecordingRow>> {
	return await apiFetch<CursorEnvelope<RecordingRow>>(
		`/recordings?${cdrSearchParams({ ...query })}`,
	);
}

/**
 * Mints a signed, expiring URL for one recording's media.
 *
 * `POST` because it CREATES a credential with a lifetime — a `GET` would be prefetched and cached
 * as though it were idempotent, which it is not in the way that matters. The returned URL is
 * anonymous by design: it is what an `<audio>` element can actually fetch.
 */
export async function mintRecordingDownloadUrl(id: string): Promise<RecordingDownloadLink> {
	const { data } = await apiFetch<{ data: RecordingDownloadLink }>(
		`/recordings/${id}/download-url`,
		{ method: "POST", body: JSON.stringify({}) },
	);
	return data;
}

/**
 * Deletes a recording: the object goes and the row is kept as a tombstone.
 *
 * `recordings.delete`, which is a different grant from `recordings.download` — one lets you hear a
 * conversation and the other destroys the only copy of it. The row survives with `deletedAt` set,
 * so "was there a recording of that call, and what happened to it" stays answerable; the recordings
 * list renders that state rather than hiding the row.
 *
 * Idempotent it is not: a second delete of an already-purged recording is a 410, which is the
 * honest answer to "remove the media" when there is none.
 */
export async function deleteRecording(id: string): Promise<{ readonly id: string }> {
	const { data } = await apiFetch<{ data: { id: string } }>(`/recordings/${id}`, {
		method: "DELETE",
	});
	return data;
}

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

/**
 * The most rows one export may contain, mirroring `CDR_EXPORT_MAX_ROWS` in
 * `apps/api/src/cdr/exports/cdr-exports.dto.ts`.
 *
 * A job that REACHES this cap fails with `failureReason: "too-many-rows"`; it does not truncate.
 * That is the sentence the export dialog exists to say, because the alternative outcome is the bad
 * one: a truncated CSV is a plausible-looking file with no marker saying where it stopped, and
 * somebody will total a column in it.
 *
 * Overridable per deployment through the `CDR_EXPORT_MAX_ROWS` environment variable, so this is the
 * default rather than a guarantee — which is why the copy says "about" and the server is what
 * actually refuses.
 */
export const CDR_EXPORT_MAX_ROWS = 100_000;

/**
 * The widest window one export may cover, mirroring `CDR_EXPORT_MAX_RANGE_DAYS`.
 *
 * A year plus a day, and deliberately far wider than {@link MAX_RANGE_DAYS} — that difference IS
 * this feature. The list's 92 days is what a person waits on in a request; this path exists so a
 * wider question can be asked at all.
 */
export const CDR_EXPORT_MAX_RANGE_DAYS = 366;

/** Exports one organization may have in flight at once, mirroring `CDR_EXPORT_MAX_PENDING`. */
export const CDR_EXPORT_MAX_PENDING = 5;

/** The filters an export carries: the list query, minus the two fields that describe a PAGE. */
export type CdrExportFilters = Omit<CdrListQuery, "limit" | "cursor">;

export interface CdrExportListQuery {
	readonly status?: CdrExportStatus | undefined;
	readonly limit?: number | undefined;
	readonly cursor?: string | undefined;
}

/**
 * Whether a job has stopped moving.
 *
 * The one place this app decides when to stop polling, so the poll loop and anything that renders a
 * spinner cannot disagree about what "done" means. Both terminal states count: a client that only
 * stopped on `succeeded` would poll a failed job forever, which is the exact shape of bug that
 * makes a background tab expensive.
 */
export function isSettledExportStatus(status: CdrExportStatus): boolean {
	return status === "succeeded" || status === "failed";
}

/**
 * The filters a job was created with, as label/value pairs a dialog can list.
 *
 * Reads `filters` DEFENSIVELY and by name, because the blob is whatever the server's DTO accepted
 * when the job was made: a job created by a later build may carry a filter this one has never heard
 * of, and a job created by an earlier one may be missing several. Unknown keys are passed through
 * with their own name rather than dropped — "there was a filter and this build cannot label it" is
 * a better answer than silently showing an export as unfiltered when it was not.
 *
 * The resolved window is deliberately NOT included: it lives in `rangeFrom`/`rangeTo` as real
 * columns and every caller renders it separately, so repeating `from`/`to` here would show the same
 * fact twice and let the two disagree after a defaulted range.
 */
const FILTER_LABELS: Readonly<Record<string, string>> = {
	direction: "Direction",
	disposition: "Outcome",
	hangupCause: "Cause",
	leg: "Leg",
	extension: "Number",
	did: "DID",
	recorded: "Recorded only",
	search: "Search",
};

export function describeExportFilters(
	filters: Readonly<Record<string, unknown>>,
): readonly { readonly label: string; readonly value: string }[] {
	const described: { label: string; value: string }[] = [];
	for (const [name, value] of Object.entries(filters)) {
		if (name === "from" || name === "to" || name === "label") {
			continue;
		}
		if (value === undefined || value === null || value === "") {
			continue;
		}
		described.push({ label: FILTER_LABELS[name] ?? name, value: String(value) });
	}
	return described;
}

/**
 * Queues an export.
 *
 * Answers `202 Accepted` rather than `201`, and the distinction is the client's business: what
 * exists after this call is a REQUEST, and the file may never exist at all — the job can fail on
 * the row cap. So the caller polls rather than fetches, and the returned row is a starting state
 * rather than a result.
 *
 * A refusal is an `ApiError` like any other: too wide a window and too many jobs already in flight
 * are both policy 4xx that carry a message the dialog renders.
 */
export async function createCdrExport(
	body: CdrExportFilters & { readonly label?: string | undefined },
): Promise<CdrExportRow> {
	const payload: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(body)) {
		// Omitting rather than sending empty, for the reason `cdrSearchParams` gives: the server
		// DEFAULTS an absent range, and `from: ""` is a parse failure rather than "no filter".
		if (value === undefined || value === null || value === "") {
			continue;
		}
		payload[name] = value;
	}
	const { data } = await apiFetch<{ data: CdrExportRow }>("/cdr/exports", {
		method: "POST",
		body: JSON.stringify(payload),
	});
	return data;
}

export async function listCdrExports(
	query: CdrExportListQuery = {},
): Promise<CursorEnvelope<CdrExportRow>> {
	return await apiFetch<CursorEnvelope<CdrExportRow>>(
		`/cdr/exports?${cdrSearchParams({ ...query })}`,
	);
}

/**
 * Mints a download link for a finished export.
 *
 * `POST` for the reason {@link mintRecordingDownloadUrl} is: it creates a credential with a
 * lifetime. Never cached — a URL minted at page load and clicked twenty minutes later is a 410 that
 * reads as "the export is broken".
 */
export async function mintCdrExportDownloadUrl(id: string): Promise<CdrExportDownloadLink> {
	const { data } = await apiFetch<{ data: CdrExportDownloadLink }>(
		`/cdr/exports/${id}/download-url`,
		{ method: "POST", body: JSON.stringify({}) },
	);
	return data;
}

/** Deletes a job and its file. Rides `cdr.export` — there is no separate delete grant. */
export async function deleteCdrExport(id: string): Promise<{ readonly id: string }> {
	const { data } = await apiFetch<{ data: { id: string } }>(`/cdr/exports/${id}`, {
		method: "DELETE",
	});
	return data;
}
