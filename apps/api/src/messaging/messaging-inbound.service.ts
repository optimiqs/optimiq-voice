import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_DATABASE } from "../pbx/shared/pbx.tokens";
import { classifyKeyword } from "./compliance/keywords";
import { MessagingEventPublisher } from "./messaging-event.publisher";
import { buildMessagingObjectKey, messagingMediaExtension } from "./messaging-media";
import {
	messagesTotal,
	messageOutcomesTotal,
	messagingKeywordsTotal,
	messagingOptOutsTotal,
} from "./messaging.metrics";
import {
	applyDeliveryReceipt,
	deleteOptOut,
	findMessageOrgByCarrierIdAdmin,
	findMessageOrgByIdAdmin,
	findMessagingNumberByE164Admin,
	getCampaign,
	getConversation,
	getMessage,
	getMessagingNumber,
	insertInboundMessage,
	insertOutboundMessage,
	setMessageMediaKeys,
	touchConversation,
	upsertConversation,
	upsertOptOut,
} from "./messaging.repository";
import { MESSAGING_ENV, MESSAGING_PROVIDER, MESSAGING_STORE } from "./messaging.tokens";
import type { ObjectStore } from "../storage";
import type { MessagingEnv } from "./messaging-env";
import type {
	MessagingProvider,
	ProviderDeliveryReceipt,
	ProviderInboundMessage,
	ProviderWebhookEvent,
} from "./provider/messaging-provider.port";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.messaging");

/** The named result of handling one webhook, so the route logs without a boolean's ambiguity. */
export type MessagingWebhookOutcome =
	| "filed"
	| "duplicate"
	| "no-number"
	| "number-disabled"
	| "updated"
	| "uncorrelated"
	| "ignored"
	| "error";

/**
 * The control-plane side of messaging: it turns a verified webhook into rows, consent, and events.
 *
 * The route owns authentication and parsing (through the provider port); this owns MEANING. It never
 * throws — a webhook must be answered 200 or the carrier eventually disables the endpoint — so every
 * path returns a named outcome and logs its own failures.
 *
 * # The order of operations on an inbound message, and why
 *
 * 1. **Resolve the tenant from the `to`.** Untenanted, because a webhook has no session: the DID is
 *    the only thing that says whose message this is.
 * 2. **File the row, idempotently.** Before anything else that has an effect. A redelivery must not
 *    re-run the keyword handler, re-download the media, or re-publish the event — and the unique
 *    index is what makes "already filed" a fact rather than a guess.
 * 3. **Honour the keyword, if there was one.** STOP writes the suppression row and sends the
 *    campaign's opt-out confirmation; START removes it; HELP replies. This happens BEFORE the media
 *    download and before the event publish, because it is the one part with a legal clock on it and
 *    it must not be behind a possibly-slow HTTP fetch to the carrier's media host.
 * 4. **Download the media.** Best-effort: a failure leaves the message filed with no attachment,
 *    which is recoverable, rather than losing the message.
 * 5. **Publish `message.received`.** Last, because it fans out to tenant endpoints and everything it
 *    describes should already be true and readable.
 *
 * # Why the auto-replies are sent through the normal send path's ROW but not its gate
 *
 * A STOP confirmation and a HELP reply are messages, so they are `message` rows and appear in the
 * thread — an agent has to be able to see that the platform answered. But they deliberately bypass
 * the opt-out gate, because the STOP confirmation is by definition sent to somebody who has just
 * opted out, and CTIA expects exactly one such message. Routing it through {@link MessagingService.send}
 * would either be refused by the gate we just wrote, or would require a bypass flag on a public
 * method — which is a flag somebody would eventually pass from a controller.
 */
@Injectable()
export class MessagingInboundService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(MESSAGING_ENV) private readonly env: MessagingEnv,
		@Inject(MESSAGING_STORE) private readonly store: ObjectStore,
		@Inject(MESSAGING_PROVIDER) private readonly provider: MessagingProvider | undefined,
		@Inject(MessagingEventPublisher) private readonly events: MessagingEventPublisher,
	) {}

	async handle(event: ProviderWebhookEvent): Promise<MessagingWebhookOutcome> {
		try {
			return event.kind === "inbound"
				? await this.handleInbound(event.message)
				: await this.handleReceipt(event.receipt);
		} catch (error) {
			logger.error({ kind: event.kind, err: error }, "a messaging webhook could not be handled");
			return "error";
		}
	}

	// ---- inbound -----------------------------------------------------------------------------

	private async handleInbound(inbound: ProviderInboundMessage): Promise<MessagingWebhookOutcome> {
		if (inbound.to.length === 0 || inbound.from.length === 0) {
			return "ignored";
		}
		// Untenanted: the DID is what tells us whose message this is.
		const number = await findMessagingNumberByE164Admin(this.database.adminDb, inbound.to);
		if (number === undefined) {
			logger.info(
				{ did: inbound.to },
				"an inbound message arrived on a number with no messaging line; ignoring",
			);
			return "no-number";
		}
		if (!number.enabled) {
			// Still not filed. A disabled line is a tenant saying "not this number"; filing into it
			// would put messages in an inbox nobody is watching and imply a reply is coming.
			logger.info({ did: inbound.to }, "an inbound message arrived on a disabled messaging line");
			return "number-disabled";
		}

		const organizationId = number.organizationId;
		const filed = await this.database.withTenantScope(organizationId, async (transaction) => {
			const thread = await upsertConversation(transaction, {
				organizationId,
				messagingNumberId: number.id,
				remoteE164: inbound.from,
			});
			const campaign =
				number.campaignId === null ? undefined : await getCampaign(transaction, number.campaignId);
			const keyword = classifyKeyword(inbound.text, campaign ?? undefined);
			const row = await insertInboundMessage(transaction, {
				organizationId,
				conversationId: thread.id,
				messagingNumberId: number.id,
				fromE164: inbound.from,
				toE164: inbound.to,
				body: inbound.text ?? null,
				carrierMessageId: inbound.carrierMessageId,
				complianceKeyword: keyword?.keyword ?? null,
				hasMedia: (inbound.mediaUrls ?? []).length > 0,
				receivedAt: inbound.receivedAt,
				retentionUntil: this.retentionFor(
					(await getMessagingNumber(transaction, number.id))?.retentionDays ?? null,
				),
			});
			if (row === undefined) {
				return undefined;
			}
			await touchConversation(transaction, thread.id, {
				at: inbound.receivedAt,
				// A keyword is shown as itself in the preview rather than hidden: an agent scanning the
				// inbox should be able to see that this thread ended in a STOP.
				preview: inbound.text ?? "[attachment]",
				direction: "inbound",
			});
			return { row, thread, campaign, keyword };
		});

		if (filed === undefined) {
			// A redelivery of a message already filed. Everything below has already happened.
			return "duplicate";
		}
		messagesTotal.inc({ direction: "inbound", kind: filed.row.kind });

		// Step 3 — consent, before the media fetch. See the header.
		if (filed.keyword !== undefined) {
			messagingKeywordsTotal.inc({ intent: filed.keyword.intent });
			await this.honourKeyword({
				organizationId,
				messagingNumberId: number.id,
				conversationId: filed.thread.id,
				ourE164: inbound.to,
				remoteE164: inbound.from,
				intent: filed.keyword.intent,
				keyword: filed.keyword.keyword,
				campaign: filed.campaign,
			});
		}

		// Step 4 — media, best-effort.
		const mediaUrls = inbound.mediaUrls ?? [];
		let storedCount = 0;
		if (mediaUrls.length > 0 && this.provider !== undefined) {
			const keys = await this.downloadMedia(organizationId, mediaUrls);
			storedCount = keys.length;
			if (keys.length > 0) {
				await this.database.withTenantScope(
					organizationId,
					async (transaction) => await setMessageMediaKeys(transaction, filed.row.id, keys),
				);
			}
		}

		// Step 5 — the platform event, last.
		await this.events.publishReceived({
			organizationId,
			conversationId: filed.thread.id,
			messageId: filed.row.id,
			messagingNumberId: number.id,
			fromE164: inbound.from,
			toE164: inbound.to,
			kind: filed.row.kind,
			body: inbound.text,
			mediaCount: storedCount,
			complianceKeyword: filed.keyword?.keyword,
			carrierMessageId: inbound.carrierMessageId,
			receivedAt: inbound.receivedAt,
		});
		return "filed";
	}

	/**
	 * Writes the consent change and queues the one reply the keyword calls for.
	 *
	 * The reply is queued as an ordinary outbound row, so the send worker delivers it and the thread
	 * shows it. It bypasses the send GATE — see the header — which is why it is built here rather
	 * than by calling the service.
	 */
	private async honourKeyword(input: {
		readonly organizationId: string;
		readonly messagingNumberId: string;
		readonly conversationId: string;
		readonly ourE164: string;
		readonly remoteE164: string;
		readonly intent: "opt-out" | "opt-in" | "help";
		readonly keyword: string;
		readonly campaign:
			| { readonly helpMessage: string | null; readonly optOutMessage: string | null }
			| undefined;
	}): Promise<void> {
		const reply = await this.database.withTenantScope(input.organizationId, async (transaction) => {
			if (input.intent === "opt-out") {
				const { created } = await upsertOptOut(transaction, {
					organizationId: input.organizationId,
					messagingNumberId: input.messagingNumberId,
					remoteE164: input.remoteE164,
					source: "keyword",
					keyword: input.keyword,
					recordedByUserId: null,
				});
				if (!created) {
					// Already suppressed. CTIA allows ONE opt-out confirmation; a consumer who texts
					// STOP twice must not receive a second message from a program they have left.
					return undefined;
				}
				messagingOptOutsTotal.inc({ action: "added", source: "keyword" });
				return (
					input.campaign?.optOutMessage ??
					"You have been unsubscribed and will receive no further messages. Reply START to resubscribe."
				);
			}
			if (input.intent === "opt-in") {
				const removed = await deleteOptOut(transaction, input.messagingNumberId, input.remoteE164);
				if (removed) {
					messagingOptOutsTotal.inc({ action: "removed", source: "keyword" });
				}
				// A START from somebody who was never suppressed is a greeting, not a state change,
				// and answering it with "you are resubscribed" would be a message they did not ask
				// for. Only an actual removal earns the confirmation.
				return removed ? "You are resubscribed and will receive messages again." : undefined;
			}
			return (
				input.campaign?.helpMessage ??
				"Reply STOP to unsubscribe. For assistance, contact the business you are messaging."
			);
		});
		if (reply === undefined) {
			return;
		}
		await this.database.withTenantScope(input.organizationId, async (transaction) => {
			const row = await insertOutboundMessage(transaction, {
				organizationId: input.organizationId,
				conversationId: input.conversationId,
				messagingNumberId: input.messagingNumberId,
				fromE164: input.ourE164,
				toE164: input.remoteE164,
				body: reply,
				mediaKeys: [],
				// No user: the platform sent this, and attributing it to whoever happened to be logged
				// in would make an automatic reply look like a person's decision.
				sentByUserId: null,
				retentionUntil: null,
			});
			await touchConversation(transaction, input.conversationId, {
				at: row.createdAt ?? new Date(),
				preview: reply,
				direction: "outbound",
			});
		});
		logger.info(
			{
				organizationId: input.organizationId,
				intent: input.intent,
				keyword: input.keyword,
				messagingNumberId: input.messagingNumberId,
			},
			"honoured a messaging compliance keyword",
		);
	}

	/** Downloads MMS parts into the store, skipping any the allow-list or the cap refuses. */
	private async downloadMedia(
		organizationId: string,
		urls: readonly string[],
	): Promise<readonly string[]> {
		const provider = this.provider;
		if (provider === undefined) {
			return [];
		}
		const keys: string[] = [];
		for (const url of urls.slice(0, 10)) {
			try {
				const download = await provider.fetchMedia(url);
				const extension = messagingMediaExtension(download.contentType);
				if (extension === undefined) {
					// The allow-list, applied to carrier-supplied bytes exactly as it is to an upload.
					// An inbound part of an unmodelled type is dropped, not stored under a guess.
					logger.warn(
						{ organizationId, contentType: download.contentType },
						"an inbound MMS part was refused by the media allow-list",
					);
					continue;
				}
				if (download.bytes.byteLength > this.env.MESSAGING_MAX_MEDIA_BYTES) {
					logger.warn(
						{ organizationId, bytes: download.bytes.byteLength },
						"an inbound MMS part was larger than the configured limit",
					);
					continue;
				}
				const objectKey = buildMessagingObjectKey(organizationId, extension);
				await this.store.put(objectKey, download.bytes, {
					contentType: download.contentType ?? "application/octet-stream",
				});
				keys.push(objectKey);
			} catch (error) {
				logger.error(
					{ organizationId, err: String(error) },
					"an inbound MMS part could not be downloaded",
				);
			}
		}
		return keys;
	}

	// ---- delivery receipts -------------------------------------------------------------------

	private async handleReceipt(receipt: ProviderDeliveryReceipt): Promise<MessagingWebhookOutcome> {
		// Correlate on our own token first, then on the carrier id. Both lookups are untenanted — a
		// webhook has no session organization.
		//
		// The UUID shape check is not decoration: `clientState` is echoed by the carrier and goes
		// straight into `where id = $1` on a `uuid` column, so a non-UUID makes Postgres raise
		// `22P02` — and a REJECTED left operand never reaches the `??`, so the fallback this comment
		// promises would never run and the row would sit in `sent` forever.
		const clientState = asUuid(receipt.clientState);
		const found =
			(clientState === undefined
				? undefined
				: await findMessageOrgByIdAdmin(this.database.adminDb, clientState)) ??
			(await findMessageOrgByCarrierIdAdmin(this.database.adminDb, receipt.carrierMessageId));
		if (found === undefined) {
			logger.info(
				{ carrierMessageId: receipt.carrierMessageId, status: receipt.status },
				"a delivery receipt did not correlate to a known message",
			);
			return "uncorrelated";
		}

		const terminal = receipt.status === "delivered" || receipt.status === "failed";
		const context = await this.database.withTenantScope(
			found.organizationId,
			async (transaction) => {
				await applyDeliveryReceipt(transaction, found.id, {
					status: receipt.status,
					carrierMessageId: receipt.carrierMessageId,
					segments: receipt.segments,
					errorReason: receipt.errorReason,
					terminal,
				});
				const row = await getMessage(transaction, found.id);
				if (row === undefined) {
					return undefined;
				}
				const thread = await getConversation(transaction, row.conversationId);
				return { row, thread };
			},
		);
		if (context === undefined) {
			return "uncorrelated";
		}
		messageOutcomesTotal.inc({ status: receipt.status });

		await this.events.publishDelivered({
			organizationId: found.organizationId,
			conversationId: context.row.conversationId,
			messageId: context.row.id,
			messagingNumberId: context.row.messagingNumberId,
			fromE164: context.row.fromE164,
			toE164: context.row.toE164,
			status: receipt.status === "received" ? "delivered" : receipt.status,
			segments: receipt.segments,
			errorReason: receipt.errorReason,
			carrierMessageId: receipt.carrierMessageId,
			occurredAt: receipt.occurredAt,
		});
		return "updated";
	}

	private retentionFor(numberRetentionDays: number | null): Date | null {
		const days = numberRetentionDays ?? this.env.MESSAGING_RETENTION_DAYS;
		return days <= 0 ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1_000);
	}
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The value if it is a UUID, else `undefined`. See the note at the correlation site. */
function asUuid(value: string | undefined): string | undefined {
	return value !== undefined && UUID_PATTERN.test(value) ? value : undefined;
}
