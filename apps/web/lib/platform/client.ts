/**
 * `/api/v1/platform/*` — the operator surface, as fetches.
 *
 * Same-origin through the Next rewrite like every other call in this app, so the session cookie
 * rides along and nothing here handles a token. What is different is the scope: these endpoints
 * answer across tenants, every one of them writes an audit row server-side, and the two permissions
 * that open them are held by the platform operator and by nobody inside a customer organization.
 */

import { API_BASE_PATH, apiFetch } from "../api-client";
import type {
	KycDecisionInput,
	PlatformKycEntry,
	PlatformKycListQuery,
	PlatformKycPage,
	TracebackQuery,
	TracebackResult,
} from "./contracts";

/**
 * Builds the query string, omitting everything the caller did not set.
 *
 * The same rule and the same reason as `cdrSearchParams`: an omitted parameter and an empty one are
 * different requests to a coercing DTO, and the parameter set is the React Query cache key, so
 * `decision=` and no `decision` have to be one cache entry rather than two.
 */
export function platformSearchParams(query: Record<string, unknown>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}
		params.set(key, String(value));
	}
	return params.toString();
}

// ---------------------------------------------------------------------------------------------
// KYC review queue
// ---------------------------------------------------------------------------------------------

/** One page of the review queue, oldest-waiting first. `compliance.review`. */
export async function listPlatformKyc(query: PlatformKycListQuery): Promise<PlatformKycPage> {
	return await apiFetch<PlatformKycPage>(
		`/platform/compliance/kyc?${platformSearchParams({ ...query })}`,
	);
}

/**
 * Records a verdict on one organization's file.
 *
 * A `POST` to a sub-resource rather than a `PATCH` of the file, because a verdict is an event: the
 * columns it writes are the reviewer's and are not columns anybody edits. `reviewedBy` is not sent
 * and cannot be — the DTO is strict and would refuse it — because the acting operator is read from
 * the session.
 */
export async function decidePlatformKyc(
	organizationId: string,
	input: KycDecisionInput,
): Promise<PlatformKycEntry> {
	const { data } = await apiFetch<{ data: PlatformKycEntry }>(
		`/platform/compliance/kyc/${organizationId}/decision`,
		{ method: "POST", body: JSON.stringify(input) },
	);
	return data;
}

// ---------------------------------------------------------------------------------------------
// Traceback
// ---------------------------------------------------------------------------------------------

/** The legs matching one traceback. `compliance.traceback`. */
export async function fetchTraceback(query: TracebackQuery): Promise<TracebackResult> {
	return await apiFetch<TracebackResult>(
		`/platform/traceback?${platformSearchParams({ ...query })}`,
	);
}

/**
 * The URL of the same answer as a CSV.
 *
 * A plain URL rather than a minted, signed one — the two existing download paths in this app
 * (a CDR export, a recording) mint because the object lives in a bucket the browser cannot reach.
 * There is no object here: the endpoint renders the file in the request from the same query, on the
 * same cookie, and answers `content-disposition: attachment`. So the download is a navigation to a
 * route the caller is already entitled to, and adding a mint step would be a second endpoint
 * protecting nothing the first does not.
 *
 * Prefixed with {@link API_BASE_PATH} by hand because this is the one place in the app that needs a
 * URL rather than a response — `apiFetch` is what normally owns that prefix.
 */
export function tracebackCsvHref(query: TracebackQuery): string {
	return `${API_BASE_PATH}/platform/traceback/export.csv?${platformSearchParams({ ...query })}`;
}
