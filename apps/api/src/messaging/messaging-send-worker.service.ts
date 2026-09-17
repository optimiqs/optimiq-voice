import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_DATABASE } from "../pbx/shared/pbx.tokens";
import { messagingMediaPath, mintMessagingMediaToken } from "./messaging-media";
import { messagesTotal } from "./messaging.metrics";
import {
	claimNextMessageSend,
	failMessage,
	getMessagingNumber,
	markMessageSent,
	releaseMessageClaim,
} from "./messaging.repository";
import { MESSAGING_ENV, MESSAGING_PROVIDER } from "./messaging.tokens";
import { MessagingSendError, type MessagingProvider } from "./provider/messaging-provider.port";
import type { MessagingEnv } from "./messaging-env";
import type { ClaimableMessage } from "./messaging.repository";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.messaging");

/**
 * Turns queued outbound messages into carrier sends.
 *
 * # The queue is a column, not a message
 *
 * The same design the fax and CDR-export workers set out, and for the same reason: a message's state
 * has to be readable by the API that queued it — the composer shows `queued → sent → delivered` on
 * the bubble the user just typed — so it lives in the row. A NATS message beside the row would
 * introduce the exact bug the status column prevents: a row and a queue entry that disagree.
 *
 * # One at a time, untenanted claim, tenant-scoped send
 *
 * Each pass claims one message on `adminDb` ("which message anywhere is owed a send" is not a
 * tenant's question), then re-enters `withTenantScope` for the writes. `skip locked` lets N replicas
 * share the queue with no coordination.
 *
 * # Why the media URL is minted HERE and not at enqueue time
 *
 * The carrier fetches MMS parts from a URL, so a send has to hand it one. Minting the URL at enqueue
 * time would mean a message that sat in a backlog longer than the link TTL arrives at the carrier
 * with an expired link — a failure whose cause is invisible from either end. Minting at claim time
 * makes the TTL start when the send does. The worker also refuses to send at all if the configured
 * TTL is shorter than the lease, because that combination guarantees a link that expires mid-retry.
 *
 * # What this worker does NOT retry
 *
 * A {@link MessagingSendError} marked `permanent` — an empty body, a number the carrier will not
 * accept — fails the row immediately with the carrier's own sentence. Retrying it produces the same
 * refusal three times and a message that is still not sent, three minutes later.
 */
@Injectable()
export class MessagingSendWorker implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private swept = 0;
	private sent = 0;
	private failed = 0;

	constructor(
		@Inject(MESSAGING_ENV) private readonly env: MessagingEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(MESSAGING_PROVIDER) private readonly provider: MessagingProvider | undefined,
	) {}

	get stats(): { readonly swept: number; readonly sent: number; readonly failed: number } {
		return { swept: this.swept, sent: this.sent, failed: this.failed };
	}

	onModuleInit(): void {
		if (
			!this.env.MESSAGING_SEND_ENABLED ||
			this.env.MESSAGING_SEND_POLL_INTERVAL_MS === 0 ||
			this.provider === undefined
		) {
			return;
		}
		this.timer = setInterval(() => {
			void this.tick();
		}, this.env.MESSAGING_SEND_POLL_INTERVAL_MS);
		this.timer.unref?.();
		logger.info(
			{ intervalMs: this.env.MESSAGING_SEND_POLL_INTERVAL_MS, provider: this.provider.name },
			"messaging send worker started",
		);
	}

	onApplicationShutdown(): void {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * One pass: claim at most one queued message and send it. Public so a harness can drive it
	 * without waiting out an interval; re-entrancy is refused rather than queued.
	 */
	async tick(): Promise<{ readonly sent: number }> {
		if (this.running || this.stopped) {
			return { sent: 0 };
		}
		this.running = true;
		this.swept += 1;
		try {
			return { sent: await this.runOne() };
		} catch (error) {
			logger.error({ err: error }, "the messaging send pass failed");
			return { sent: 0 };
		} finally {
			this.running = false;
		}
	}

	private async runOne(): Promise<number> {
		const leaseCutoff = new Date(Date.now() - this.env.MESSAGING_SEND_LEASE_MS);
		const claimed = await claimNextMessageSend(this.database.adminDb, leaseCutoff);
		if (claimed === undefined) {
			return 0;
		}
		const provider = this.provider;
		if (provider === undefined) {
			await this.fail(claimed, "Messaging is not configured on this deployment.");
			return 0;
		}
		if (claimed.attempts > this.env.MESSAGING_SEND_MAX_ATTEMPTS) {
			await this.fail(claimed, `Abandoned after ${String(claimed.attempts)} send attempts.`);
			return 0;
		}

		let mediaUrls: readonly string[] = [];
		if (claimed.mediaKeys.length > 0) {
			const minted = this.mintMediaUrls(claimed);
			if (minted === undefined) {
				await this.fail(
					claimed,
					"This message has attachments but MMS media links are not configured " +
						"(set MESSAGING_MEDIA_URL_SECRET and MESSAGING_PUBLIC_BASE_URL).",
				);
				return 0;
			}
			mediaUrls = minted;
		}

		try {
			const result = await provider.send({
				from: claimed.fromE164,
				to: claimed.toE164,
				text: claimed.body ?? undefined,
				mediaUrls: mediaUrls.length === 0 ? undefined : mediaUrls,
				// Echoed on every receipt, so the terminal outcome correlates to this row without a
				// carrier-side lookup table.
				clientState: claimed.id,
				messagingProfileId: await this.profileFor(claimed),
			});
			await this.database.withTenantScope(
				claimed.organizationId,
				async (transaction) =>
					await markMessageSent(transaction, claimed.id, result.carrierMessageId, result.segments),
			);
			this.sent += 1;
			messagesTotal.inc({ direction: "outbound", kind: mediaUrls.length > 0 ? "MMS" : "SMS" });
			logger.info(
				{
					organizationId: claimed.organizationId,
					messageId: claimed.id,
					carrierMessageId: result.carrierMessageId,
				},
				"an outbound message was accepted by the carrier",
			);
			return 1;
		} catch (error) {
			const permanent = error instanceof MessagingSendError && error.permanent;
			if (permanent || claimed.attempts >= this.env.MESSAGING_SEND_MAX_ATTEMPTS) {
				await this.fail(claimed, errorMessage(error));
				return 0;
			}
			logger.warn(
				{ organizationId: claimed.organizationId, messageId: claimed.id, err: String(error) },
				"an outbound message send attempt failed; it will be retried",
			);
			// Released with a null lease, so the next poll picks it up rather than waiting the lease
			// out. A text is expected in seconds, and a transient carrier blip should cost one poll
			// rather than one minute — the opposite trade from fax, where a backoff is the point.
			await this.database.withTenantScope(
				claimed.organizationId,
				async (transaction) => await releaseMessageClaim(transaction, claimed.id, null),
			);
			return 0;
		}
	}

	/**
	 * Signed, expiring URLs for this message's parts.
	 *
	 * `undefined` when the deployment has no signing secret — an MMS that cannot present its media is
	 * a permanent failure with a readable reason, not something to retry.
	 */
	private mintMediaUrls(claimed: ClaimableMessage): readonly string[] | undefined {
		const secret = this.env.MESSAGING_MEDIA_URL_SECRET;
		if (secret === undefined) {
			return undefined;
		}
		// See the header: the link has to outlive the whole retry budget, or a message that fails once
		// arrives at the carrier the second time with a dead link.
		const ttlSeconds = Math.max(
			this.env.MESSAGING_MEDIA_URL_TTL_SECONDS,
			Math.ceil((this.env.MESSAGING_SEND_LEASE_MS / 1_000) * this.env.MESSAGING_SEND_MAX_ATTEMPTS),
		);
		const expiresAt = Math.floor(Date.now() / 1_000) + ttlSeconds;
		const token = mintMessagingMediaToken(claimed.id, claimed.organizationId, expiresAt, secret);
		// ABSOLUTE, because the carrier fetches these from the public internet. A deployment with no
		// public base URL configured cannot send MMS at all, and saying so is better than handing the
		// carrier a relative path it will silently fail to resolve.
		const base = this.env.MESSAGING_PUBLIC_BASE_URL;
		if (base === undefined) {
			return undefined;
		}
		return claimed.mediaKeys.map(
			(_key, index) => `${base.replace(/\/$/u, "")}${messagingMediaPath(token, index)}`,
		);
	}

	/** The carrier-side profile this number sends through, when it has one. */
	private async profileFor(claimed: ClaimableMessage): Promise<string | undefined> {
		const number = await this.database.withTenantScope(
			claimed.organizationId,
			async (transaction) => await getMessagingNumber(transaction, claimed.messagingNumberId),
		);
		return number?.carrierMessagingProfileId ?? undefined;
	}

	private async fail(claimed: ClaimableMessage, reason: string): Promise<void> {
		this.failed += 1;
		await this.database.withTenantScope(
			claimed.organizationId,
			async (transaction) => await failMessage(transaction, claimed.id, reason),
		);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
