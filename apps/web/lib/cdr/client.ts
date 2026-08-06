import { apiFetch } from "../api-client";
import type {
	CallDetail,
	CallLegDetail,
	CallLegRow,
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
