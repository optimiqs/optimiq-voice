import { stat } from "node:fs/promises";
import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { openMediaResponse } from "../../media/media-response";
import { nextCursorFrom } from "../query/cdr-cursor";
import { CdrCursorError } from "../query/cdr-cursor";
import { MAX_RANGE_DAYS, rangeDays, resolveTimeRange } from "../query/cdr.dto";
import { getRecording, listRecordings, recordingCursorKey } from "../query/cdr.repository";
import {
	CdrInvalidCursorException,
	CdrLinkExpiredException,
	CdrLinkInvalidException,
	CdrMediaGoneException,
	CdrNotFoundException,
	CdrRangeTooWideException,
	CdrSigningUnavailableException,
} from "../shared/cdr.errors";
import { CDR_DATABASE, CDR_ENV } from "../shared/cdr.tokens";
import {
	mintRecordingToken,
	recordingMediaPath,
	resolveRecordingObjectPath,
	verifyRecordingToken,
} from "./recording-token";
import type { MediaResponse } from "../../media/media-response";
import type { RecordingListQuery } from "../query/cdr.dto";
import type { RecordingListRow } from "../query/cdr.repository";
import type { CdrEnv } from "../shared/cdr-env";
import type { AppSession } from "@optimiq-voice/auth";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

const logger = getLogger("api.cdr");

export interface RecordingListEnvelope {
	readonly data: readonly RecordingListRow[];
	readonly nextCursor: string | null;
	readonly limit: number;
	readonly range: { readonly from: string; readonly to: string };
}

export interface RecordingDownloadLink {
	readonly url: string;
	readonly expiresAt: string;
	readonly expiresInSeconds: number;
}

/**
 * What the media route answers with.
 *
 * Was `{ stream, contentType, sizeBytes, fileName }` and is now a {@link MediaResponse}, which
 * carries the STATUS and the exact header set as well as the stream. The reason is `Range`: a
 * partial response is a different status, a different `content-length` and an extra
 * `content-range`, and a shape that only carried the stream could not express any of them. See
 * `src/media/http-range.ts` for why seeking did not work before this.
 */
export type ResolvedRecordingMedia = MediaResponse;

/**
 * Recording metadata, and the signed link that reaches its media.
 *
 * ## The two halves are deliberately different endpoints
 *
 * Minting a link is an AUTHENTICATED, permission-gated action (`recordings.download`) that says
 * "this person, in this organization, may listen to this recording for the next few minutes".
 * Following the link is an ANONYMOUS request carrying that decision as a signature.
 *
 * Splitting them is what makes the media usable at all: an `<audio src>` cannot carry a session
 * negotiation, and an integration may post a recording URL into a customer's webhook where the
 * fetcher has no session by definition. The alternative the codebase used to carry was
 * `/api/recordings/:id`, served anonymously with no signature and enumerable by file name. This is
 * the fix its own comment asked for, and that route is now deleted.
 *
 * ## What a token can and cannot do
 *
 * It names ONE recording and ONE organization, for a few minutes. Following it still opens
 * `withTenantScope(organizationId)` and reads the row through the RLS policy, so a token that
 * somehow named a real recording and a foreign organization returns nothing — the signature is not
 * the last line of defence, it is the first.
 */
@Injectable()
export class RecordingsService {
	constructor(
		@Inject(CDR_ENV) private readonly env: CdrEnv,
		@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient,
	) {}

	private organizationId(session: AppSession): string {
		return requireActiveOrganizationId(session);
	}

	async list(session: AppSession, query: RecordingListQuery): Promise<RecordingListEnvelope> {
		const organizationId = this.organizationId(session);
		const range = resolveTimeRange(query);
		const days = rangeDays(range);
		if (days > MAX_RANGE_DAYS) {
			throw new CdrRangeTooWideException(MAX_RANGE_DAYS, days);
		}

		const page = await this.database
			.withTenantScope(
				organizationId,
				async (transaction) => await listRecordings(transaction, query, range),
			)
			.catch((error: unknown) => {
				if (error instanceof CdrCursorError) {
					throw new CdrInvalidCursorException(error.message);
				}
				throw error;
			});

		return {
			data: page.rows,
			nextCursor: nextCursorFrom(page.rows.map(recordingCursorKey), query.limit, page.fetched),
			limit: query.limit,
			range: { from: range.from.toISOString(), to: range.to.toISOString() },
		};
	}

	async get(session: AppSession, id: string): Promise<{ readonly data: RecordingListRow }> {
		const organizationId = this.organizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getRecording(transaction, id),
		);
		if (row === undefined) {
			throw new CdrNotFoundException("recording", id);
		}
		return { data: row };
	}

	/**
	 * Mints a short-lived download link.
	 *
	 * The row is read FIRST, inside the tenant scope. Minting a token for an id without checking it
	 * exists would work — the media route would 404 — but it would also mint a valid token for any
	 * id a caller cared to name, which makes the mint endpoint an oracle for which recordings exist
	 * even though the media behind them is unreachable.
	 */
	async mintDownloadLink(
		session: AppSession,
		id: string,
	): Promise<{ readonly data: RecordingDownloadLink }> {
		const organizationId = this.organizationId(session);
		const secret = this.env.CDR_RECORDING_URL_SECRET;
		if (secret === undefined) {
			throw new CdrSigningUnavailableException();
		}

		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getRecording(transaction, id),
		);
		if (row === undefined) {
			throw new CdrNotFoundException("recording", id);
		}
		if (row.deletedAt !== null) {
			throw new CdrMediaGoneException();
		}

		const ttl = this.env.CDR_RECORDING_URL_TTL_SECONDS;
		const expiresAt = Math.floor(Date.now() / 1000) + ttl;
		const token = mintRecordingToken({ r: row.id, o: organizationId, e: expiresAt }, secret);

		return {
			data: {
				url: recordingMediaPath(token),
				expiresAt: new Date(expiresAt * 1000).toISOString(),
				expiresInSeconds: ttl,
			},
		};
	}

	/**
	 * Verifies a token and opens the object behind it.
	 *
	 * Order is: signature, expiry, tenant-scoped row read, tombstone check, containment check, open.
	 * Every step before the last is cheap and every one of them can only ever narrow, so an
	 * anonymous request that is not carrying a genuine token never reaches the filesystem.
	 */
	async openSignedMedia(
		token: string,
		rangeHeader?: string | undefined,
	): Promise<ResolvedRecordingMedia> {
		const secret = this.env.CDR_RECORDING_URL_SECRET;
		if (secret === undefined) {
			// No key configured means no token can be genuine. Never a fallback to unsigned access.
			throw new CdrLinkInvalidException();
		}
		const verified = verifyRecordingToken(token, {
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
			async (transaction) => await getRecording(transaction, payload.r),
		);
		// A token for a row that is not visible in the organization it names is indistinguishable
		// from a forged one, and is answered identically. See `CdrLinkInvalidException`.
		if (row === undefined) {
			throw new CdrLinkInvalidException();
		}
		if (row.deletedAt !== null) {
			throw new CdrMediaGoneException();
		}

		const path = resolveRecordingObjectPath(this.env.CDR_RECORDING_ROOT, row.objectKey);
		if (path === undefined) {
			logger.error(
				{
					recordingId: row.id,
					objectKey: row.objectKey,
				},
				"a recording object key resolves outside the recording root",
			);
			throw new CdrLinkInvalidException();
		}

		let sizeBytes: number;
		try {
			const info = await stat(path);
			if (!info.isFile()) {
				throw new Error("not a file");
			}
			sizeBytes = info.size;
		} catch {
			// The row says there is media and the object store disagrees. A 410 rather than a 404:
			// the recording existed, and telling the UI that is what lets it say so.
			throw new CdrMediaGoneException();
		}

		return openMediaResponse(path, sizeBytes, {
			contentType: contentTypeFor(row.objectKey),
			fileName: downloadFileName(row),
			rangeHeader,
		});
	}
}

/** Content type from the object key's extension. WAV is what the engine writes today. */
function contentTypeFor(objectKey: string): string {
	const lower = objectKey.toLowerCase();
	if (lower.endsWith(".mp3")) {
		return "audio/mpeg";
	}
	if (lower.endsWith(".ogg") || lower.endsWith(".opus")) {
		return "audio/ogg";
	}
	return "audio/wav";
}

/**
 * A file name a person can find again on their desktop.
 *
 * The object key is `<org>/<call>/<recording>.wav`, which downloads as a UUID and tells nobody
 * anything. Prefixing the date and the kind costs nothing and is the difference between a
 * downloads folder and a pile of hex.
 */
function downloadFileName(row: RecordingListRow): string {
	const stamp = row.createdAt.toISOString().slice(0, 19).replace(/[:T]/gu, "-");
	const extension = row.objectKey.slice(row.objectKey.lastIndexOf(".") + 1) || "wav";
	return `${row.kind}-${stamp}-${row.id.slice(0, 8)}.${extension}`;
}
