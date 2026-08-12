"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { listAuditLog, listSipAuthEvents } from "~/lib/pbx/client";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization } from "../_context/session-context";
import type {
	AuditCursorEnvelope,
	AuditLogEntryRow,
	AuditLogQueryParams,
	SipAuthEventQueryParams,
	SipAuthEventRow,
} from "~/lib/pbx/contracts";

/**
 * Server state for the two append-only ledgers.
 *
 * ## Why this is not `use-pbx-queries.ts`
 *
 * That file is the generic CRUD machinery: five verbs, an offset page, a `total`, and a coarse
 * invalidation after every write. None of those apply here. `audit_log` and `sip_auth_event` are
 * append-only in the DATABASE — the tenant role holds `SELECT, INSERT` under separate policies
 * rather than one `FOR ALL` — so there is no mutation to invalidate after, and nothing in this app
 * can write a row in either table even by accident.
 *
 * ## Why nothing here invalidates, including the ACL screen's own writes
 *
 * Saving an access rule DOES append an audit entry, inside the transaction of the mutation being
 * recorded. It would be easy to invalidate the change ledger on every PBX write to reflect that,
 * and it would be wrong twice: the ledger's window is resolved at render, so an invalidation would
 * re-resolve it and shift every row under a reader mid-scan, and a cursor into the previous result
 * set means nothing in the next one. A ledger is refreshed when its reader asks for it, which is
 * what the range control and React Query's own refetch already are.
 *
 * ## `placeholderData` is what makes "Older" feel like paging
 *
 * The previous page stays on screen while the next one loads, exactly as the reporting area does.
 * Without it a table collapses to a spinner on every step through a cursor, which reads as a page
 * load rather than as a page turn.
 */

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

export interface LedgerListResult<TRow> {
	readonly query: UseQueryResult<AuditCursorEnvelope<TRow>>;
	readonly rows: readonly TRow[];
	/**
	 * Whether a request is actually outstanding.
	 *
	 * NOT `query.isPending`, which stays true forever for a query that is switched off — React Query
	 * has no data and is not going to fetch any. A screen that held a window the server would refuse
	 * would otherwise show a spinner under the message explaining why nothing was sent, which reads
	 * as "still loading" rather than as "fix the range".
	 */
	readonly isPending: boolean;
	/** `null` means the server said this was the last page. */
	readonly nextCursor: string | null;
	/** The window the SERVER applied after defaulting, which is what the page should say it shows. */
	readonly range: { readonly from: string; readonly to: string } | undefined;
}

/**
 * One page of the change ledger.
 *
 * There is deliberately no `useAuditLogEntry`: a ledger entry IS its detail — the diff, the actor
 * and the request id are all on the list row — so the server offers no `GET /:id` to call and a
 * detail view would be a second tenant-safe query path returning what the table already has.
 */
export function useAuditLog(
	query: AuditLogQueryParams,
	options: { readonly enabled?: boolean } = {},
): LedgerListResult<AuditLogEntryRow> {
	const organizationId = useOrganizationId();
	const result = useQuery({
		queryKey: queryKeys.auditLogList(organizationId, { ...query }),
		queryFn: () => listAuditLog(query),
		enabled: organizationId.length > 0 && options.enabled !== false,
		placeholderData: (previous) => previous,
	});

	return {
		query: result,
		rows: result.data?.data ?? [],
		isPending: result.isPending && result.fetchStatus !== "idle",
		nextCursor: result.data?.nextCursor ?? null,
		range: result.data?.range,
	};
}

/** One page of the authentication-failure ledger. The same envelope, deliberately. */
export function useSipAuthEvents(
	query: SipAuthEventQueryParams,
	options: { readonly enabled?: boolean } = {},
): LedgerListResult<SipAuthEventRow> {
	const organizationId = useOrganizationId();
	const result = useQuery({
		queryKey: queryKeys.sipAuthEventList(organizationId, { ...query }),
		queryFn: () => listSipAuthEvents(query),
		enabled: organizationId.length > 0 && options.enabled !== false,
		placeholderData: (previous) => previous,
	});

	return {
		query: result,
		rows: result.data?.data ?? [],
		isPending: result.isPending && result.fetchStatus !== "idle",
		nextCursor: result.data?.nextCursor ?? null,
		range: result.data?.range,
	};
}
