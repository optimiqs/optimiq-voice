import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { openMediaResponse } from "../../media/media-response";
import { normalizePagination, paged } from "../shared/pagination";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { faxMediaPath, mintFaxMediaToken, verifyFaxMediaToken } from "./fax-media-token";
import {
	FaxLinkExpiredException,
	FaxLinkInvalidException,
	FaxMediaGoneException,
	FaxNotFoundException,
	FaxNotSendableException,
	FaxSigningUnavailableException,
} from "./fax.errors";
import {
	deleteFaxMessage,
	deleteFaxServer,
	getFaxMessage,
	getFaxServer,
	getFaxServerWithNumber,
	insertFaxServer,
	insertOutboundFax,
	listFaxMessages,
	listFaxServers,
	updateFaxServer,
} from "./fax.repository";
import { FAX_ENV, FAX_STORE } from "./fax.tokens";
import type { MediaResponse } from "../../media/media-response";
import type { ObjectStore } from "../../storage";
import type { FaxEnv } from "./fax-env";
import type {
	CreateFaxServerDto,
	FaxMessageListQuery,
	FaxServerListQuery,
	SendFaxDto,
	UpdateFaxServerDto,
} from "./fax.dto";
import type { FaxMessageRow, FaxServerRow } from "./fax.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * Fax servers, their inbox/outbox, and the enqueue side of the send queue.
 *
 * A bespoke service rather than one built on `PbxResourceService`, for the reason `CdrExportsService`
 * is bespoke: fax is not a routing destination (it is carrier-edge, so it does not participate in
 * compile-on-write), it owns a document store and a background worker, and the message rows are a
 * ledger rather than a CRUD resource. Everything runs inside `withTenantScope`, so RLS is the filter.
 */
@Injectable()
export class FaxService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(FAX_ENV) private readonly env: FaxEnv,
		@Inject(FAX_STORE) private readonly store: ObjectStore,
	) {}

	async listServers(session: AppSession, query: FaxServerListQuery) {
		const organizationId = requireActiveOrganizationId(session);
		const pagination = normalizePagination(query);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const { rows, total } = await listFaxServers(transaction, query, pagination);
			return paged(rows, total, pagination);
		});
	}

	async getServer(session: AppSession, id: string): Promise<FaxServerRow> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getFaxServer(transaction, id),
		);
		if (row === undefined) {
			throw new FaxNotFoundException("server");
		}
		return row;
	}

	async createServer(session: AppSession, dto: CreateFaxServerDto): Promise<FaxServerRow> {
		const organizationId = requireActiveOrganizationId(session);
		return await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await insertFaxServer(transaction, {
					organizationId,
					name: dto.name,
					extensionNumber: dto.extensionNumber ?? null,
					phoneNumberId: dto.phoneNumberId ?? null,
					headerText: dto.headerText ?? null,
					emailToAddress: dto.emailToAddress ?? null,
					emailFromAddress: dto.emailFromAddress ?? null,
					...(dto.retryAttempts === undefined ? {} : { retryAttempts: dto.retryAttempts }),
					...(dto.retryBackoffSeconds === undefined
						? {}
						: { retryBackoffSeconds: dto.retryBackoffSeconds }),
					...(dto.enabled === undefined ? {} : { enabled: dto.enabled }),
				}),
		);
	}

	async updateServer(
		session: AppSession,
		id: string,
		dto: UpdateFaxServerDto,
	): Promise<FaxServerRow> {
		const organizationId = requireActiveOrganizationId(session);
		// `null` unbinds a nullable field; `undefined` leaves it. Both are meaningful, so the mapping
		// is explicit rather than a spread that would drop the nulls.
		const patch: Record<string, unknown> = {};
		if (dto.name !== undefined) patch.name = dto.name;
		if (dto.extensionNumber !== undefined) patch.extensionNumber = dto.extensionNumber;
		if (dto.phoneNumberId !== undefined) patch.phoneNumberId = dto.phoneNumberId;
		if (dto.headerText !== undefined) patch.headerText = dto.headerText;
		if (dto.emailToAddress !== undefined) patch.emailToAddress = dto.emailToAddress;
		if (dto.emailFromAddress !== undefined) patch.emailFromAddress = dto.emailFromAddress;
		if (dto.retryAttempts !== undefined) patch.retryAttempts = dto.retryAttempts;
		if (dto.retryBackoffSeconds !== undefined) patch.retryBackoffSeconds = dto.retryBackoffSeconds;
		if (dto.enabled !== undefined) patch.enabled = dto.enabled;

		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await updateFaxServer(transaction, id, patch),
		);
		if (row === undefined) {
			throw new FaxNotFoundException("server");
		}
		return row;
	}

	async removeServer(session: AppSession, id: string): Promise<{ readonly deleted: true }> {
		const organizationId = requireActiveOrganizationId(session);
		const deleted = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await deleteFaxServer(transaction, id),
		);
		if (!deleted) {
			throw new FaxNotFoundException("server");
		}
		return { deleted: true };
	}

	async listMessages(
		session: AppSession,
		serverId: string | undefined,
		query: FaxMessageListQuery,
	) {
		const organizationId = requireActiveOrganizationId(session);
		const pagination = normalizePagination(query);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			// A server filter is proven to belong to the tenant first, so a cross-tenant id returns a
			// 404 rather than an empty page that reads as "this server has no faxes".
			if (serverId !== undefined && (await getFaxServer(transaction, serverId)) === undefined) {
				throw new FaxNotFoundException("server");
			}
			const { rows, total } = await listFaxMessages(transaction, serverId, query, pagination);
			return paged(rows, total, pagination);
		});
	}

	async getMessage(session: AppSession, id: string): Promise<FaxMessageRow> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getFaxMessage(transaction, id),
		);
		if (row === undefined) {
			throw new FaxNotFoundException("message");
		}
		return row;
	}

	async removeMessage(session: AppSession, id: string): Promise<{ readonly deleted: true }> {
		const organizationId = requireActiveOrganizationId(session);
		const removed = await this.database.withTenantScope(organizationId, async (transaction) => {
			const row = await getFaxMessage(transaction, id);
			if (row === undefined) {
				return { deleted: false, objectKey: null as string | null };
			}
			await deleteFaxMessage(transaction, id);
			return { deleted: true, objectKey: row.objectKey };
		});
		if (!removed.deleted) {
			throw new FaxNotFoundException("message");
		}
		// The document is forgotten after the row, best-effort: a store that refuses the delete leaves
		// an orphan the retention story would sweep, never a dangling row.
		if (removed.objectKey !== null) {
			await this.store.delete(removed.objectKey).catch((error: unknown) => {
				logger.warn(
					{ faxId: id, err: String(error) },
					"a deleted fax's document could not be removed",
				);
			});
		}
		return { deleted: true };
	}

	/**
	 * Queues an outbound fax. The row is the queue — the send worker polls the column, so this returns
	 * as soon as the row is durable, exactly like the CDR export create.
	 */
	async send(session: AppSession, serverId: string, dto: SendFaxDto): Promise<FaxMessageRow> {
		const organizationId = requireActiveOrganizationId(session);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const bound = await getFaxServerWithNumber(transaction, serverId);
			if (bound === undefined) {
				throw new FaxNotFoundException("server");
			}
			if (!bound.server.enabled) {
				throw new FaxNotSendableException("disabled");
			}
			if (bound.fromE164 === null) {
				throw new FaxNotSendableException("no-number");
			}
			return await insertOutboundFax(transaction, {
				organizationId,
				faxServerId: serverId,
				fromE164: bound.fromE164,
				toE164: dto.to,
				sourceMediaUrl: dto.mediaUrl,
			});
		});
	}

	/** Mints a signed, expiring link to a received fax's document, or refuses when unconfigured. */
	async mintDownloadLink(
		session: AppSession,
		id: string,
	): Promise<{ readonly url: string; readonly expiresAt: string }> {
		const organizationId = requireActiveOrganizationId(session);
		const secret = this.env.FAX_MEDIA_URL_SECRET;
		if (secret === undefined) {
			throw new FaxSigningUnavailableException();
		}
		const message = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await getFaxMessage(transaction, id),
		);
		if (message === undefined || message.objectKey === null) {
			throw new FaxNotFoundException("message");
		}
		const expiresAtSeconds = Math.floor(Date.now() / 1000) + this.env.FAX_MEDIA_URL_TTL_SECONDS;
		const token = mintFaxMediaToken(id, organizationId, expiresAtSeconds, secret);
		return {
			url: faxMediaPath(token),
			expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
		};
	}

	/**
	 * Verifies a media token and opens the fax document for a ranged response — the anonymous
	 * download side of the signed link, mirroring the CDR export `media` route.
	 */
	async openSignedFax(token: string, rangeHeader: string | undefined): Promise<MediaResponse> {
		const secret = this.env.FAX_MEDIA_URL_SECRET;
		if (secret === undefined) {
			throw new FaxSigningUnavailableException();
		}
		const verified = verifyFaxMediaToken(token, { current: secret });
		const payload = verified.payload;
		if (!verified.ok || payload === undefined) {
			throw verified.failure === "expired"
				? new FaxLinkExpiredException()
				: new FaxLinkInvalidException();
		}
		const message = await this.database.withTenantScope(
			payload.o,
			async (transaction) => await getFaxMessage(transaction, payload.r),
		);
		if (message === undefined || message.objectKey === null) {
			throw new FaxLinkInvalidException();
		}
		const objectKey = message.objectKey;
		const stat = await this.store.head(objectKey).catch(() => undefined);
		if (stat === undefined) {
			throw new FaxMediaGoneException();
		}
		const fileName = `${message.id}.${objectKey.endsWith(".tiff") ? "tiff" : "pdf"}`;
		return await openMediaResponse(this.store, objectKey, stat.sizeBytes, {
			contentType: objectKey.endsWith(".tiff") ? "image/tiff" : "application/pdf",
			fileName,
			...(rangeHeader === undefined ? {} : { rangeHeader }),
			disposition: "inline",
		});
	}
}
