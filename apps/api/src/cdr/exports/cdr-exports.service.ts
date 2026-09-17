import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { openMediaResponse } from "../../media/media-response";
import { ObjectKeyOutsideRootError } from "../../storage";
import { CdrCursorError, nextCursorFrom } from "../query/cdr-cursor";
import { rangeDays, resolveTimeRange } from "../query/cdr.dto";
import {
	CdrExportPendingLimitException,
	CdrInvalidCursorException,
	CdrLinkExpiredException,
	CdrLinkInvalidException,
	CdrMediaGoneException,
	CdrNotFoundException,
	CdrRangeTooWideException,
	CdrSigningUnavailableException,
} from "../shared/cdr.errors";
import { CDR_DATABASE, CDR_ENV, CDR_EXPORT_STORE } from "../shared/cdr.tokens";
import { csvFileName } from "./cdr-export-csv";
import {
	CDR_EXPORT_MAX_PENDING,
	CDR_EXPORT_MAX_RANGE_DAYS,
	type CdrExportListQuery,
	type CreateCdrExportDto,
} from "./cdr-exports.dto";
import {
	countPendingExportJobs,
	deleteExportJob,
	getExportJob,
	insertExportJob,
	listExportJobs,
} from "./cdr-exports.repository";
import { exportMediaPath, mintExportToken, verifyExportToken } from "./export-token";
import type { MediaResponse } from "../../media/media-response";
import type { ObjectStore } from "../../storage";
import type { CdrEnv } from "../shared/cdr-env";
import type { CdrExportListRow } from "./cdr-exports.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

const logger = getLogger("api.cdr");

/**
 * The request half of CDR export: create a job, watch it, fetch the file, throw it away.
 *
 * ## Why the export is asynchronous at all
 *
 * `cdr.dto.ts` already argued the shape of this feature before it existed. `MAX_RANGE_DAYS` is 92
 * because *"anything larger is a report, not a list, and belongs on the export path where it can
 * be produced asynchronously"*, and `CdrRangeTooWideException` says the same from the other side:
 * *"exports that genuinely need years are a different, asynchronous surface"*. The reason is not
 * politeness about latency. It is that a synchronous export holds one connection out of a small
 * pool for as long as the scan takes, and the request most likely to take minutes is the one most
 * likely to be retried by an impatient user — so the synchronous version's failure mode is a pool
 * exhausted by duplicates of the same expensive query.
 *
 * So: `POST` creates a ROW and returns immediately. The work happens in `CdrExportWorker`, and the
 * client polls `GET :id` or lists.
 *
 * ## The envelopes
 *
 * ```jsonc
 * POST /api/v1/cdr/exports              -> { "data": { …job… } }                        201
 * GET  /api/v1/cdr/exports              -> { "data": [ … ], "nextCursor": "…"|null, "limit": 25 }
 * GET  /api/v1/cdr/exports/:id          -> { "data": { …job… } }
 * POST /api/v1/cdr/exports/:id/download-url
 *                                       -> { "data": { "url", "expiresAt", "expiresInSeconds" } }
 * DELETE /api/v1/cdr/exports/:id        -> { "data": { "id": "…" } }
 * ```
 *
 * `nextCursor` and no `total`, matching `CdrService` and for the reason it records: this area does
 * not count.
 */

export interface CdrExportEnvelope {
	readonly data: CdrExportListRow;
}

export interface CdrExportListEnvelope {
	readonly data: readonly CdrExportListRow[];
	readonly nextCursor: string | null;
	readonly limit: number;
}

export interface CdrExportDownloadLink {
	readonly url: string;
	readonly expiresAt: string;
	readonly expiresInSeconds: number;
}

@Injectable()
export class CdrExportsService {
	constructor(
		@Inject(CDR_ENV) private readonly env: CdrEnv,
		@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient,
		@Inject(CDR_EXPORT_STORE) private readonly store: ObjectStore,
	) {}

	private organizationId(session: AppSession): string {
		return requireActiveOrganizationId(session);
	}

	/**
	 * Creates a job.
	 *
	 * Two refusals, both here rather than in the DTO, and both for the reason `CdrService.range`
	 * gives: they are policies about COST, and the schema's job is shape.
	 *
	 * The window ceiling is {@link CDR_EXPORT_MAX_RANGE_DAYS} rather than the list's 92 — that
	 * difference IS this feature. The pending-job ceiling is the one that is genuinely new: an
	 * export costs a full scan of the window, the worker takes one job at a time, and a client that
	 * can queue a hundred of them has taken the worker away from every other tenant on this
	 * deployment. Five in flight per organization is a fair share and a clear refusal; it is not a
	 * rate limit and does not pretend to be one — a tenant that finishes five may immediately ask
	 * for five more.
	 */
	async create(session: AppSession, body: CreateCdrExportDto): Promise<CdrExportEnvelope> {
		const organizationId = this.organizationId(session);
		const range = resolveTimeRange(body);
		const days = rangeDays(range);
		if (days > CDR_EXPORT_MAX_RANGE_DAYS) {
			throw new CdrRangeTooWideException(CDR_EXPORT_MAX_RANGE_DAYS, days);
		}

		const row = await this.database.withTenantScope(organizationId, async (transaction) => {
			const pending = await countPendingExportJobs(transaction);
			if (pending >= CDR_EXPORT_MAX_PENDING) {
				throw new CdrExportPendingLimitException(CDR_EXPORT_MAX_PENDING);
			}
			return await insertExportJob(transaction, {
				organizationId,
				// `session.user.id` and not the email: the id is stable across a rename, and an email in
				// a row that outlives the account is a personal detail nobody chose to keep.
				requestedBy: session.user.id,
				// Stored as the DTO parsed it, with the resolved window written to its own columns. A
				// re-read of `filters` therefore reproduces the question, and the columns answer "what
				// did this cost" without parsing JSON.
				filters: body as unknown as Readonly<Record<string, unknown>>,
				rangeFrom: range.from,
				rangeTo: range.to,
				expiresAt: new Date(Date.now() + this.env.CDR_EXPORT_TTL_HOURS * 60 * 60 * 1_000),
			});
		});

		logger.info({ organizationId, exportId: row.id, days }, "a CDR export was queued");
		return { data: row };
	}

	async list(session: AppSession, query: CdrExportListQuery): Promise<CdrExportListEnvelope> {
		const organizationId = this.organizationId(session);
		const page = await this.database
			.withTenantScope(
				organizationId,
				async (transaction) => await listExportJobs(transaction, query),
			)
			.catch(rethrowCursorError);

		return {
			data: page.rows,
			// `createdAt` fills the cursor's `startedAt` slot; see the repository's `keysetBefore`.
			nextCursor: nextCursorFrom(
				page.rows.map((row) => ({ id: row.id, startedAt: row.createdAt })),
				query.limit,
				page.fetched,
			),
			limit: query.limit,
		};
	}

	async get(session: AppSession, id: string): Promise<CdrExportEnvelope> {
		const organizationId = this.organizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getExportJob(transaction, id),
		);
		if (row === undefined) {
			throw new CdrNotFoundException("cdr-export", id);
		}
		return { data: row };
	}

	/**
	 * Mints a download link for a finished export.
	 *
	 * The row is read under the tenant's scope BEFORE anything is signed, so the endpoint is not an
	 * existence oracle for another organization's job ids — the same ordering
	 * `RecordingsService.mintDownloadLink` uses and for the same reason.
	 *
	 * A job that has not finished is a 404 on the FILE rather than a 409 on the job: there is no
	 * artefact to link to, the client already knows the status from `GET :id`, and answering "not
	 * yet" with a conflict would make a poll loop look like an error loop.
	 */
	async mintDownloadLink(
		session: AppSession,
		id: string,
	): Promise<{ readonly data: CdrExportDownloadLink }> {
		const organizationId = this.organizationId(session);
		const secret = this.env.CDR_RECORDING_URL_SECRET;
		if (secret === undefined) {
			throw new CdrSigningUnavailableException();
		}

		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getExportJob(transaction, id),
		);
		if (row === undefined) {
			throw new CdrNotFoundException("cdr-export", id);
		}
		if (row.objectKey === null) {
			// Either it has not run yet, or it failed, or its window closed and the file was purged.
			// The job row says which; this endpoint only says there is nothing to fetch.
			throw row.status === "succeeded"
				? new CdrMediaGoneException()
				: new CdrNotFoundException("cdr-export-file", id);
		}

		const ttl = this.env.CDR_RECORDING_URL_TTL_SECONDS;
		const expiresAt = Math.floor(Date.now() / 1000) + ttl;
		return {
			data: {
				url: exportMediaPath(
					mintExportToken({ x: row.id, o: organizationId, e: expiresAt }, secret),
				),
				expiresAt: new Date(expiresAt * 1000).toISOString(),
				expiresInSeconds: ttl,
			},
		};
	}

	/**
	 * Verifies a token and opens the CSV behind it.
	 *
	 * Same order as the recording equivalent — signature, expiry, tenant-scoped row read, object
	 * check, open — because every step before the last is cheap and every one can only narrow. An
	 * anonymous request that is not carrying a genuine token never reaches the filesystem.
	 */
	async openSignedExport(token: string, rangeHeader?: string | undefined): Promise<MediaResponse> {
		const secret = this.env.CDR_RECORDING_URL_SECRET;
		if (secret === undefined) {
			// No key configured means no token can be genuine. Never a fallback to unsigned access.
			throw new CdrLinkInvalidException();
		}
		const verified = verifyExportToken(token, {
			current: secret,
			previous: this.env.CDR_RECORDING_URL_SECRET_PREVIOUS,
		});
		const payload = verified.payload;
		if (!verified.ok || payload === undefined) {
			throw verified.failure === "expired"
				? new CdrLinkExpiredException()
				: new CdrLinkInvalidException();
		}

		const row = await this.database.withTenantScope(
			payload.o,
			async (transaction) => await getExportJob(transaction, payload.x),
		);
		// A token for a row that is not visible in the organization it names is indistinguishable
		// from a forged one, and is answered identically.
		if (row === undefined) {
			throw new CdrLinkInvalidException();
		}
		if (row.objectKey === null) {
			throw new CdrMediaGoneException();
		}

		const objectKey = row.objectKey;
		const stat = await this.store.head(objectKey).catch((cause: unknown) => {
			if (!(cause instanceof ObjectKeyOutsideRootError)) {
				throw cause;
			}
			logger.error(
				{ exportId: row.id, objectKey },
				"a CDR export object key resolves outside the export root",
			);
			throw new CdrLinkInvalidException();
		});
		if (stat === undefined) {
			throw new CdrMediaGoneException();
		}

		return await openMediaResponse(this.store, objectKey, stat.sizeBytes, {
			contentType: "text/csv; charset=utf-8",
			fileName: csvFileName({ from: row.rangeFrom, to: row.rangeTo }),
			// `attachment`, unlike a recording: a CSV rendered inline is a browser showing a wall of
			// quoted text, and the only thing anybody does with this file is save it.
			disposition: "attachment",
			rangeHeader,
		});
	}

	/**
	 * Deletes a job and its file.
	 *
	 * Object first, row second — the same ordering the recording sweep argues for, inverted in
	 * consequence: a row deleted before its object leaves a CSV of the organization's call history
	 * in the bucket that nothing points at and nothing will ever clean up, because the expiry sweep
	 * finds files through their rows. A failed object delete therefore keeps the row, and the
	 * request fails, so the caller can retry rather than silently orphaning a file.
	 */
	async remove(
		session: AppSession,
		id: string,
	): Promise<{ readonly data: { readonly id: string } }> {
		const organizationId = this.organizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getExportJob(transaction, id),
		);
		if (row === undefined) {
			throw new CdrNotFoundException("cdr-export", id);
		}
		if (row.objectKey !== null) {
			// Idempotent on every driver: an object that is already gone is the state we wanted.
			await this.store.delete(row.objectKey);
		}
		await this.database.withTenantScope(
			organizationId,
			async (transaction) => await deleteExportJob(transaction, id),
		);
		return { data: { id } };
	}
}

/** Turns the repository's cursor failure into the area's 400. Everything else propagates. */
function rethrowCursorError(error: unknown): never {
	if (error instanceof CdrCursorError) {
		throw new CdrInvalidCursorException(error.message);
	}
	throw error;
}
