import {
	and,
	count,
	desc,
	eq,
	faxMessage,
	faxServer,
	ilike,
	or,
	phoneNumber,
	sql,
} from "@optimiq-voice/pbx-db";
import type { Pagination } from "../shared/pagination";
import type { FaxMessageListQuery, FaxServerListQuery } from "./fax.dto";
import type { FaxMessageStatus, PbxDatabaseTransaction, SQL } from "@optimiq-voice/pbx-db";

/**
 * Data access for fax servers and their inbox/outbox.
 *
 * Free functions taking a transaction, like `cdr-exports.repository.ts`: the tenant is established by
 * `withTenantScope` before any of these run and none of them takes an organization id, so RLS is the
 * only filter and there is no place for a query to be wrong about a tenant. The exception is
 * {@link claimNextSend}, which runs on the admin connection and says so.
 */

const SERVER_COLUMNS = {
	id: faxServer.id,
	name: faxServer.name,
	extensionNumber: faxServer.extensionNumber,
	phoneNumberId: faxServer.phoneNumberId,
	headerText: faxServer.headerText,
	emailToAddress: faxServer.emailToAddress,
	emailFromAddress: faxServer.emailFromAddress,
	retryAttempts: faxServer.retryAttempts,
	retryBackoffSeconds: faxServer.retryBackoffSeconds,
	enabled: faxServer.enabled,
	createdAt: faxServer.createdAt,
	updatedAt: faxServer.updatedAt,
} as const;

const MESSAGE_COLUMNS = {
	id: faxMessage.id,
	faxServerId: faxMessage.faxServerId,
	direction: faxMessage.direction,
	status: faxMessage.status,
	fromE164: faxMessage.fromE164,
	toE164: faxMessage.toE164,
	pages: faxMessage.pages,
	objectKey: faxMessage.objectKey,
	telnyxFaxId: faxMessage.telnyxFaxId,
	errorReason: faxMessage.errorReason,
	attempts: faxMessage.attempts,
	completedAt: faxMessage.completedAt,
	createdAt: faxMessage.createdAt,
	updatedAt: faxMessage.updatedAt,
} as const;

export type FaxServerRow = {
	[K in keyof typeof SERVER_COLUMNS]: (typeof SERVER_COLUMNS)[K]["_"]["notNull"] extends true
		? (typeof SERVER_COLUMNS)[K]["_"]["data"]
		: (typeof SERVER_COLUMNS)[K]["_"]["data"] | null;
};

export type FaxMessageRow = {
	[K in keyof typeof MESSAGE_COLUMNS]: (typeof MESSAGE_COLUMNS)[K]["_"]["notNull"] extends true
		? (typeof MESSAGE_COLUMNS)[K]["_"]["data"]
		: (typeof MESSAGE_COLUMNS)[K]["_"]["data"] | null;
};

// --------------------------------------------------------------------------------------------
// Fax servers
// --------------------------------------------------------------------------------------------

export async function listFaxServers(
	transaction: PbxDatabaseTransaction,
	query: FaxServerListQuery,
	pagination: Pagination,
): Promise<{ readonly rows: readonly FaxServerRow[]; readonly total: number }> {
	const filters: SQL[] = [];
	if (query.search !== undefined) {
		filters.push(
			or(
				ilike(faxServer.name, `%${query.search}%`),
				ilike(faxServer.extensionNumber, `%${query.search}%`),
			) as SQL,
		);
	}
	if (query.enabled !== undefined) {
		filters.push(eq(faxServer.enabled, query.enabled) as SQL);
	}
	const where = filters.length === 0 ? undefined : and(...filters);

	const rows = await transaction
		.select(SERVER_COLUMNS)
		.from(faxServer)
		.where(where)
		.orderBy(desc(faxServer.createdAt), desc(faxServer.id))
		.limit(pagination.limit)
		.offset(pagination.offset);

	const totals = await transaction.select({ value: count() }).from(faxServer).where(where);
	return { rows, total: Number(totals[0]?.value ?? 0) };
}

export async function getFaxServer(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<FaxServerRow | undefined> {
	const rows = await transaction
		.select(SERVER_COLUMNS)
		.from(faxServer)
		.where(eq(faxServer.id, id))
		.limit(1);
	return rows[0];
}

/** The DID's E.164 for a bound server, read together so a send knows its `from` without a second call. */
export async function getFaxServerWithNumber(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<{ readonly server: FaxServerRow; readonly fromE164: string | null } | undefined> {
	const rows = await transaction
		.select({ ...SERVER_COLUMNS, fromE164: phoneNumber.e164 })
		.from(faxServer)
		.leftJoin(phoneNumber, eq(faxServer.phoneNumberId, phoneNumber.id))
		.where(eq(faxServer.id, id))
		.limit(1);
	const row = rows[0];
	if (row === undefined) {
		return undefined;
	}
	const { fromE164, ...server } = row;
	return { server: server as FaxServerRow, fromE164 };
}

export interface NewFaxServer {
	readonly organizationId: string;
	readonly name: string;
	readonly extensionNumber: string | null;
	readonly phoneNumberId: string | null;
	readonly headerText: string | null;
	readonly emailToAddress: string | null;
	readonly emailFromAddress: string | null;
	readonly retryAttempts?: number;
	readonly retryBackoffSeconds?: number;
	readonly enabled?: boolean;
}

export async function insertFaxServer(
	transaction: PbxDatabaseTransaction,
	values: NewFaxServer,
): Promise<FaxServerRow> {
	const rows = await transaction
		.insert(faxServer)
		.values({
			organizationId: values.organizationId,
			name: values.name,
			extensionNumber: values.extensionNumber,
			phoneNumberId: values.phoneNumberId,
			headerText: values.headerText,
			emailToAddress: values.emailToAddress,
			emailFromAddress: values.emailFromAddress,
			...(values.retryAttempts === undefined ? {} : { retryAttempts: values.retryAttempts }),
			...(values.retryBackoffSeconds === undefined
				? {}
				: { retryBackoffSeconds: values.retryBackoffSeconds }),
			...(values.enabled === undefined ? {} : { enabled: values.enabled }),
		})
		.returning(SERVER_COLUMNS);
	const row = rows[0];
	if (row === undefined) {
		throw new Error("the fax server insert returned no row");
	}
	return row;
}

export async function updateFaxServer(
	transaction: PbxDatabaseTransaction,
	id: string,
	values: Partial<Omit<NewFaxServer, "organizationId">>,
): Promise<FaxServerRow | undefined> {
	const rows = await transaction
		.update(faxServer)
		.set({ ...values, updatedAt: new Date() })
		.where(eq(faxServer.id, id))
		.returning(SERVER_COLUMNS);
	return rows[0];
}

export async function deleteFaxServer(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<boolean> {
	const rows = await transaction
		.delete(faxServer)
		.where(eq(faxServer.id, id))
		.returning({ id: faxServer.id });
	return rows.length > 0;
}

/** The fax server bound to a DID, found by the DID's E.164 — the inbound routing lookup. */
export async function findServerByDidE164(
	transaction: PbxDatabaseTransaction,
	e164: string,
): Promise<FaxServerRow | undefined> {
	const rows = await transaction
		.select(SERVER_COLUMNS)
		.from(faxServer)
		.innerJoin(phoneNumber, eq(faxServer.phoneNumberId, phoneNumber.id))
		.where(and(eq(phoneNumber.e164, e164), eq(faxServer.enabled, true)))
		.limit(1);
	return rows[0];
}

// --------------------------------------------------------------------------------------------
// Fax messages
// --------------------------------------------------------------------------------------------

export async function listFaxMessages(
	transaction: PbxDatabaseTransaction,
	serverId: string | undefined,
	query: FaxMessageListQuery,
	pagination: Pagination,
): Promise<{ readonly rows: readonly FaxMessageRow[]; readonly total: number }> {
	const filters: SQL[] = [];
	if (serverId !== undefined) {
		filters.push(eq(faxMessage.faxServerId, serverId) as SQL);
	}
	if (query.direction !== undefined) {
		filters.push(eq(faxMessage.direction, query.direction) as SQL);
	}
	if (query.status !== undefined) {
		filters.push(eq(faxMessage.status, query.status) as SQL);
	}
	const where = filters.length === 0 ? undefined : and(...filters);

	const rows = await transaction
		.select(MESSAGE_COLUMNS)
		.from(faxMessage)
		.where(where)
		.orderBy(desc(faxMessage.createdAt), desc(faxMessage.id))
		.limit(pagination.limit)
		.offset(pagination.offset);

	const totals = await transaction.select({ value: count() }).from(faxMessage).where(where);
	return { rows, total: Number(totals[0]?.value ?? 0) };
}

export async function getFaxMessage(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<FaxMessageRow | undefined> {
	const rows = await transaction
		.select(MESSAGE_COLUMNS)
		.from(faxMessage)
		.where(eq(faxMessage.id, id))
		.limit(1);
	return rows[0];
}

export async function deleteFaxMessage(
	transaction: PbxDatabaseTransaction,
	id: string,
): Promise<boolean> {
	const rows = await transaction
		.delete(faxMessage)
		.where(eq(faxMessage.id, id))
		.returning({ id: faxMessage.id });
	return rows.length > 0;
}

export interface NewOutboundFax {
	readonly organizationId: string;
	readonly faxServerId: string;
	readonly fromE164: string;
	readonly toE164: string;
	readonly sourceMediaUrl: string;
}

export async function insertOutboundFax(
	transaction: PbxDatabaseTransaction,
	values: NewOutboundFax,
): Promise<FaxMessageRow> {
	const rows = await transaction
		.insert(faxMessage)
		.values({
			organizationId: values.organizationId,
			faxServerId: values.faxServerId,
			direction: "outbound",
			status: "queued",
			fromE164: values.fromE164,
			toE164: values.toE164,
			sourceMediaUrl: values.sourceMediaUrl,
		})
		.returning(MESSAGE_COLUMNS);
	const row = rows[0];
	if (row === undefined) {
		throw new Error("the outbound fax insert returned no row");
	}
	return row;
}

export interface NewInboundFax {
	readonly organizationId: string;
	readonly faxServerId: string;
	readonly fromE164: string;
	readonly toE164: string;
	readonly telnyxFaxId: string;
	readonly pages: number | null;
}

/**
 * Files a received fax, idempotently on the carrier fax id.
 *
 * `onConflictDoNothing` on the `(organization_id, telnyx_fax_id)` unique index is the redelivery
 * guard: Telnyx redelivers webhooks, and a `fax.received` that arrives twice must file one document,
 * not two. Returns the row on a fresh insert and `undefined` on a conflict, so the caller downloads
 * the media exactly once.
 */
export async function insertInboundFax(
	transaction: PbxDatabaseTransaction,
	values: NewInboundFax,
): Promise<FaxMessageRow | undefined> {
	const rows = await transaction
		.insert(faxMessage)
		.values({
			organizationId: values.organizationId,
			faxServerId: values.faxServerId,
			direction: "inbound",
			status: "received",
			fromE164: values.fromE164,
			toE164: values.toE164,
			telnyxFaxId: values.telnyxFaxId,
			pages: values.pages,
			completedAt: new Date(),
		})
		.onConflictDoNothing({
			target: [faxMessage.organizationId, faxMessage.telnyxFaxId],
			// The unique index is partial (`where telnyx_fax_id is not null`); Postgres requires the
			// same predicate on the conflict target or it finds no matching index and errors.
			where: sql`${faxMessage.telnyxFaxId} is not null`,
		})
		.returning(MESSAGE_COLUMNS);
	return rows[0];
}

/** Sets an inbound row's stored document key once its media has been downloaded. */
export async function setFaxObjectKey(
	transaction: PbxDatabaseTransaction,
	id: string,
	objectKey: string,
): Promise<void> {
	await transaction
		.update(faxMessage)
		.set({ objectKey, updatedAt: new Date() })
		.where(eq(faxMessage.id, id));
}

/** Applies an outbound lifecycle webhook to the row it correlates to, by carrier fax id. */
export async function applyOutboundStatus(
	transaction: PbxDatabaseTransaction,
	messageId: string,
	values: {
		readonly status: FaxMessageStatus;
		readonly telnyxFaxId?: string;
		readonly pages?: number | null;
		readonly errorReason?: string | null;
		readonly terminal: boolean;
	},
): Promise<void> {
	await transaction
		.update(faxMessage)
		.set({
			status: values.status,
			...(values.telnyxFaxId === undefined ? {} : { telnyxFaxId: values.telnyxFaxId }),
			...(values.pages === undefined ? {} : { pages: values.pages }),
			...(values.errorReason === undefined ? {} : { errorReason: values.errorReason }),
			...(values.terminal ? { completedAt: new Date() } : {}),
			updatedAt: new Date(),
		})
		.where(eq(faxMessage.id, messageId));
}

/** Finds an outbound row by the carrier fax id, so a webhook can correlate without the client_state. */
export async function findOutboundByTelnyxId(
	transaction: PbxDatabaseTransaction,
	telnyxFaxId: string,
): Promise<FaxMessageRow | undefined> {
	const rows = await transaction
		.select(MESSAGE_COLUMNS)
		.from(faxMessage)
		.where(and(eq(faxMessage.telnyxFaxId, telnyxFaxId), eq(faxMessage.direction, "outbound")))
		.limit(1);
	return rows[0];
}

// --------------------------------------------------------------------------------------------
// The send worker's half
// --------------------------------------------------------------------------------------------

export interface ClaimableFax {
	readonly id: string;
	readonly organizationId: string;
	readonly faxServerId: string;
	readonly fromE164: string;
	readonly toE164: string;
	readonly sourceMediaUrl: string | null;
	readonly attempts: number;
}

interface ClaimedFaxRow {
	readonly id: string;
	readonly organization_id: string;
	readonly fax_server_id: string;
	readonly from_e164: string;
	readonly to_e164: string;
	readonly source_media_url: string | null;
	readonly attempts: number;
}

/**
 * Takes the oldest queued outbound fax, anywhere, and marks it `sending` — in one committed
 * statement, exactly like `claimNextExportJob`. Untenanted: "which fax anywhere is owed a send" is
 * not a tenant's question, and the row that comes back carries its `organization_id` for everything
 * after. `skip locked` stops two replicas taking the same row; the predicate is restated in the
 * outer `where` so a stale sub-select snapshot cannot mis-update. The lease (`claimed_at` vs
 * `leaseCutoff`) is what reclaims a row a crashed worker left in `sending`.
 */
export async function claimNextSend(
	executor: { execute(query: SQL): Promise<unknown> },
	leaseCutoff: Date,
): Promise<ClaimableFax | undefined> {
	const claim = sql`
		update ${faxMessage}
		set status = 'sending',
		    claimed_at = now(),
		    attempts = ${faxMessage.attempts} + 1,
		    updated_at = now()
		where ${faxMessage.id} = (
			select ${faxMessage.id}
			from ${faxMessage}
			where direction = 'outbound'
			  and (
				status = 'queued'
				or (status = 'sending' and claimed_at is not null and claimed_at <= ${leaseCutoff.toISOString()}::timestamptz)
			  )
			order by ${faxMessage.createdAt} asc
			limit 1
			for update skip locked
		)
		  and direction = 'outbound'
		  and (
			status = 'queued'
			or (status = 'sending' and claimed_at is not null and claimed_at <= ${leaseCutoff.toISOString()}::timestamptz)
		  )
		returning ${faxMessage.id} as id,
		          ${faxMessage.organizationId} as organization_id,
		          ${faxMessage.faxServerId} as fax_server_id,
		          ${faxMessage.fromE164} as from_e164,
		          ${faxMessage.toE164} as to_e164,
		          ${faxMessage.sourceMediaUrl} as source_media_url,
		          ${faxMessage.attempts} as attempts
	`;
	const claimed = rowsOf<ClaimedFaxRow>(await executor.execute(claim))[0];
	if (claimed === undefined) {
		return undefined;
	}
	return {
		id: claimed.id,
		organizationId: claimed.organization_id,
		faxServerId: claimed.fax_server_id,
		fromE164: claimed.from_e164,
		toE164: claimed.to_e164,
		sourceMediaUrl: claimed.source_media_url,
		attempts: claimed.attempts,
	};
}

/** Stamps the carrier fax id on a row whose send the carrier accepted. Stays `sending`. */
export async function markSent(
	transaction: PbxDatabaseTransaction,
	id: string,
	telnyxFaxId: string,
): Promise<void> {
	await transaction
		.update(faxMessage)
		.set({ telnyxFaxId, claimedAt: null, updatedAt: new Date() })
		.where(eq(faxMessage.id, id));
}

/** Releases a claim so the lease offers the row again — the retry path for a transient send failure. */
export async function releaseSend(transaction: PbxDatabaseTransaction, id: string): Promise<void> {
	await transaction
		.update(faxMessage)
		.set({ status: "queued", claimedAt: null, updatedAt: new Date() })
		.where(eq(faxMessage.id, id));
}

/** Terminally fails a send after its attempts are spent. */
export async function failSend(
	transaction: PbxDatabaseTransaction,
	id: string,
	reason: string,
): Promise<void> {
	await transaction
		.update(faxMessage)
		.set({
			status: "failed",
			claimedAt: null,
			completedAt: new Date(),
			errorReason: reason.slice(0, 500),
			updatedAt: new Date(),
		})
		.where(eq(faxMessage.id, id));
}

// --------------------------------------------------------------------------------------------
// Untenanted discovery — for the carrier webhook, which arrives with no session organization
// --------------------------------------------------------------------------------------------

/**
 * The fax server bound to a DID, found across every tenant by the DID's E.164. Runs on `adminDb`
 * (which bypasses RLS, the same reach the projection sweeper and transcription back-fill use) because
 * an inbound webhook carries no organization — the server row is what supplies it. Returns the id,
 * its organization and the fax-to-email address so the caller can file and notify in one scope.
 */
export async function findServerByDidE164Admin(
	executor: { execute(query: SQL): Promise<unknown> },
	e164: string,
): Promise<
	| {
			readonly id: string;
			readonly organizationId: string;
			readonly emailToAddress: string | null;
	  }
	| undefined
> {
	const query = sql`
		select ${faxServer.id} as id,
		       ${faxServer.organizationId} as organization_id,
		       ${faxServer.emailToAddress} as email_to_address
		from ${faxServer}
		join ${phoneNumber} on ${phoneNumber.id} = ${faxServer.phoneNumberId}
		where ${phoneNumber.e164} = ${e164}
		  and ${faxServer.enabled} = true
		limit 1
	`;
	const row = rowsOf<{
		readonly id: string;
		readonly organization_id: string;
		readonly email_to_address: string | null;
	}>(await executor.execute(query))[0];
	if (row === undefined) {
		return undefined;
	}
	return { id: row.id, organizationId: row.organization_id, emailToAddress: row.email_to_address };
}

/** The organization owning an outbound fax row, by its id — the webhook's `client_state` correlation. */
export async function findMessageOrgById(
	executor: { execute(query: SQL): Promise<unknown> },
	id: string,
): Promise<{ readonly id: string; readonly organizationId: string } | undefined> {
	const query = sql`
		select ${faxMessage.id} as id, ${faxMessage.organizationId} as organization_id
		from ${faxMessage}
		where ${faxMessage.id} = ${id}
		limit 1
	`;
	const row = rowsOf<{ readonly id: string; readonly organization_id: string }>(
		await executor.execute(query),
	)[0];
	return row === undefined ? undefined : { id: row.id, organizationId: row.organization_id };
}

/** The organization and row owning an outbound fax by its carrier fax id — the fallback correlation. */
export async function findOutboundOrgByTelnyxId(
	executor: { execute(query: SQL): Promise<unknown> },
	telnyxFaxId: string,
): Promise<{ readonly id: string; readonly organizationId: string } | undefined> {
	const query = sql`
		select ${faxMessage.id} as id, ${faxMessage.organizationId} as organization_id
		from ${faxMessage}
		where ${faxMessage.telnyxFaxId} = ${telnyxFaxId}
		  and ${faxMessage.direction} = 'outbound'
		limit 1
	`;
	const row = rowsOf<{ readonly id: string; readonly organization_id: string }>(
		await executor.execute(query),
	)[0];
	return row === undefined ? undefined : { id: row.id, organizationId: row.organization_id };
}

/**
 * Drizzle's `execute` returns the driver's shape: postgres.js yields an array, `pg` yields
 * `{ rows }`. Normalized here so the claim works under either adapter, exactly as the CDR export
 * repository does.
 */
function rowsOf<T>(result: unknown): readonly T[] {
	if (Array.isArray(result)) {
		return result as readonly T[];
	}
	if (typeof result === "object" && result !== null && "rows" in result) {
		return ((result as { readonly rows?: readonly T[] }).rows ?? []) as readonly T[];
	}
	return [];
}
