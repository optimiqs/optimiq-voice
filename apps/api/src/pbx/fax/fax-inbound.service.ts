import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { FaxEmailService } from "./fax-email.service";
import { buildFaxObjectKey, FAX_CONTENT_TYPES, faxExtensionFor } from "./fax-media";
import {
	applyOutboundStatus,
	findMessageOrgById,
	findOutboundOrgByTelnyxId,
	findServerByDidE164Admin,
	insertInboundFax,
	setFaxObjectKey,
} from "./fax.repository";
import { FAX_MEDIA_FETCH, FAX_STORE } from "./fax.tokens";
import type { ObjectStore } from "../../storage";
import type { FaxMediaFetch } from "./fax-media";
import type { FaxMessageStatus, PbxDatabaseClient } from "@optimiq-voice/pbx-db";
import type { TelnyxFaxWebhook } from "@optimiq-voice/telnyx";

const logger = getLogger("api.pbx");

/** The named result of handling a webhook, so the caller can log without a boolean's ambiguity. */
export type FaxWebhookOutcome =
	| "filed"
	| "duplicate"
	| "no-server"
	| "updated"
	| "uncorrelated"
	| "ignored"
	| "error";

/**
 * The control-plane side of Programmable Fax: it turns a verified `fax.*` webhook into a row.
 *
 * The carrier webhook controller owns the signature check and the envelope parse; this owns the
 * meaning. It never throws — a webhook must be answered 200 or Telnyx eventually disables the
 * endpoint — so every path returns a named outcome and logs its own failures.
 *
 * ## Inbound arrives at the carrier edge, not on a voice call
 *
 * There is no in-band CNG/CED detection in this platform (mediad has tone GENERATION and DTMF
 * detection only, no fax-tone detector, and no T.38 gateway — rung 8, absent). So a fax is never
 * "detected mid-call and handed to T.38" here; Telnyx receives it on the DID, renders it to a
 * document, and delivers `fax.received`. This method is that ingress. The document is downloaded from
 * the carrier's URL — the one place in this API that fetches a remote URL into the object store — and
 * filed once, idempotently on the carrier fax id.
 */
@Injectable()
export class FaxInboundService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(FAX_STORE) private readonly store: ObjectStore,
		@Inject(FAX_MEDIA_FETCH) private readonly fetchMedia: FaxMediaFetch,
		@Inject(FaxEmailService) private readonly email: FaxEmailService,
	) {}

	async handle(event: TelnyxFaxWebhook): Promise<FaxWebhookOutcome> {
		try {
			if (event.eventType === "fax.received" || event.fax.direction === "inbound") {
				return await this.handleInbound(event);
			}
			return await this.handleOutbound(event);
		} catch (error) {
			logger.error(
				{ eventType: event.eventType, err: error },
				"a fax webhook could not be handled",
			);
			return "error";
		}
	}

	private async handleInbound(event: TelnyxFaxWebhook): Promise<FaxWebhookOutcome> {
		const fax = event.fax;
		const to = fax.to ?? undefined;
		const from = fax.from ?? undefined;
		if (to === undefined || from === undefined) {
			return "ignored";
		}

		// Untenanted: the DID is what tells us whose fax this is.
		const server = await findServerByDidE164Admin(this.database.adminDb, to);
		if (server === undefined) {
			logger.info({ did: to }, "an inbound fax arrived on a DID with no fax server; ignoring");
			return "no-server";
		}

		const filed = await this.database.withTenantScope(server.organizationId, async (transaction) =>
			insertInboundFax(transaction, {
				organizationId: server.organizationId,
				faxServerId: server.id,
				fromE164: from,
				toE164: to,
				telnyxFaxId: fax.fax_id,
				pages: fax.page_count ?? null,
			}),
		);
		if (filed === undefined) {
			// A redelivery of a fax we already filed. The document is already stored and already emailed.
			return "duplicate";
		}

		// Download the rendered document, best-effort. A failure leaves the row filed without an
		// object_key — recoverable, not a lost fax.
		let stored = false;
		const mediaUrl = fax.media_url ?? undefined;
		if (mediaUrl !== undefined) {
			try {
				const download = await this.fetchMedia(mediaUrl);
				const extension = faxExtensionFor(download.contentType, mediaUrl);
				const objectKey = buildFaxObjectKey(server.organizationId, filed.id, extension);
				await this.store.put(objectKey, download.bytes, {
					contentType: FAX_CONTENT_TYPES[extension],
				});
				await this.database.withTenantScope(
					server.organizationId,
					async (transaction) => await setFaxObjectKey(transaction, filed.id, objectKey),
				);
				stored = true;
			} catch (error) {
				logger.error(
					{ organizationId: server.organizationId, faxId: filed.id, err: String(error) },
					"an inbound fax was filed but its document could not be downloaded",
				);
			}
		}

		if (server.emailToAddress !== null && server.emailToAddress.length > 0) {
			await this.email.notify({
				organizationId: server.organizationId,
				messageId: filed.id,
				toAddress: server.emailToAddress,
				fromNumber: from,
				toNumber: to,
				pages: fax.page_count ?? null,
				receivedAt: new Date(),
				hasDocument: stored,
			});
		}
		return "filed";
	}

	private async handleOutbound(event: TelnyxFaxWebhook): Promise<FaxWebhookOutcome> {
		const mapped = mapOutboundStatus(event.eventType);
		if (mapped === undefined) {
			return "ignored";
		}
		const fax = event.fax;

		// Correlate on our own token first (`client_state` is the fax_message id), then fall back to
		// the carrier fax id. Both lookups are untenanted — a webhook has no session organization.
		const clientState = fax.client_state ?? undefined;
		const found =
			(clientState === undefined
				? undefined
				: await findMessageOrgById(this.database.adminDb, clientState)) ??
			(await findOutboundOrgByTelnyxId(this.database.adminDb, fax.fax_id));
		if (found === undefined) {
			logger.info(
				{ eventType: event.eventType, telnyxFaxId: fax.fax_id },
				"an outbound fax webhook did not correlate to a known row",
			);
			return "uncorrelated";
		}

		await this.database.withTenantScope(
			found.organizationId,
			async (transaction) =>
				await applyOutboundStatus(transaction, found.id, {
					status: mapped.status,
					telnyxFaxId: fax.fax_id,
					...(fax.page_count === null || fax.page_count === undefined
						? {}
						: { pages: fax.page_count }),
					...(fax.failure_reason === null || fax.failure_reason === undefined
						? {}
						: { errorReason: fax.failure_reason }),
					terminal: mapped.terminal,
				}),
		);
		return "updated";
	}
}

/** Maps a fax event type to the outbox status it means, or `undefined` for one we do not record. */
function mapOutboundStatus(
	eventType: string,
): { readonly status: FaxMessageStatus; readonly terminal: boolean } | undefined {
	switch (eventType) {
		case "fax.sending.started":
			return { status: "sending", terminal: false };
		case "fax.delivered":
			return { status: "delivered", terminal: true };
		case "fax.failed":
			return { status: "failed", terminal: true };
		// fax.queued and fax.media.processed carry no state this outbox does not already have.
		default:
			return undefined;
	}
}
