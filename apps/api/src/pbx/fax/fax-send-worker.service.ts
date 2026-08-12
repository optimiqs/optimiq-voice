import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { TELNYX_CLIENT } from "../carrier/carrier.tokens";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { claimNextSend, failSend, getFaxServer, markSent, releaseSend } from "./fax.repository";
import { FAX_ENV } from "./fax.tokens";
import type { FaxEnv } from "./fax-env";
import type { ClaimableFax } from "./fax.repository";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";
import type { TelnyxClient } from "@optimiq-voice/telnyx";

const logger = getLogger("api.pbx");

/**
 * Turns queued outbound faxes into carrier sends.
 *
 * ## The queue is a column, not a message
 *
 * The same design the CDR export worker sets out, and for the same reason: a fax's state has to be
 * readable by the API that queued it (`GET :id` answers "did it send"), so it lives in the row.
 * Adding a NATS message beside the row would introduce the exact bug the status column prevents — a
 * row and a queue entry that disagree. The interval polls `fax_message_send_queue_idx`, a partial
 * index the size of the backlog, so the poll costs nothing when there is none.
 *
 * ## One at a time, untenanted claim, tenant-scoped send
 *
 * Each pass claims one outbound fax on `adminDb` (the "which fax anywhere is owed a send" question is
 * not a tenant's), then re-enters `withTenantScope` with the row's organization for the retry-policy
 * read and the status writes. `skip locked` lets N replicas share the queue without coordination.
 *
 * ## The retry policy lives on the fax server
 *
 * The claim increments `attempts`; the server's `retry_attempts` is the ceiling. Past it, the fax is
 * terminally `failed` with a sentence rather than retried forever — the case a document the carrier
 * keeps refusing, or a permanent misconfiguration (no fax connection, no carrier key), bounds. A
 * TRANSIENT carrier failure releases the claim (`status` back to `queued`), and the lease offers the
 * row again after the server's backoff.
 *
 * The carrier's own T.30 delivery retries are NOT this worker's concern: once Telnyx accepts the fax
 * (a 202 and a fax id), the row is `sending` and the terminal outcome arrives over the `fax.*`
 * webhooks. This worker only governs getting the document ACCEPTED by the carrier.
 */
@Injectable()
export class FaxSendWorker implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private swept = 0;
	private sent = 0;
	private failed = 0;

	constructor(
		@Inject(FAX_ENV) private readonly env: FaxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(TELNYX_CLIENT) private readonly carrier: TelnyxClient | undefined,
	) {}

	get stats(): { readonly swept: number; readonly sent: number; readonly failed: number } {
		return { swept: this.swept, sent: this.sent, failed: this.failed };
	}

	onModuleInit(): void {
		if (!this.env.FAX_SEND_ENABLED || this.env.FAX_SEND_POLL_INTERVAL_MS === 0) {
			return;
		}
		this.timer = setInterval(() => {
			void this.tick();
		}, this.env.FAX_SEND_POLL_INTERVAL_MS);
		this.timer.unref?.();
		logger.info({ intervalMs: this.env.FAX_SEND_POLL_INTERVAL_MS }, "fax send worker started");
	}

	onApplicationShutdown(): void {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * One pass: claim at most one queued fax and send it. Public so a harness can drive it without
	 * waiting out an interval; re-entrancy is refused rather than queued.
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
			logger.error({ err: error }, "the fax send pass failed");
			return { sent: 0 };
		} finally {
			this.running = false;
		}
	}

	private async runOne(): Promise<number> {
		const leaseCutoff = new Date(Date.now() - this.env.FAX_SEND_LEASE_MS);
		const fax = await claimNextSend(this.database.adminDb, leaseCutoff);
		if (fax === undefined) {
			return 0;
		}

		// The retry ceiling is the server's, read under the tenant's scope.
		const retryAttempts = await this.database.withTenantScope(
			fax.organizationId,
			async (transaction) => {
				const server = await getFaxServer(transaction, fax.faxServerId);
				return server?.retryAttempts ?? 3;
			},
		);

		if (fax.attempts > retryAttempts) {
			await this.fail(fax, `Abandoned after ${fax.attempts} send attempts.`);
			return 0;
		}

		// A send that can never succeed must fail fast rather than loop until the ceiling: no carrier,
		// no fax connection, or no source URL are permanent for this deployment/row.
		if (this.carrier === undefined || this.env.TELNYX_FAX_CONNECTION_ID === undefined) {
			await this.fail(
				fax,
				"Outbound fax is not configured: set TELNYX_API_KEY and TELNYX_FAX_CONNECTION_ID.",
			);
			return 0;
		}
		if (fax.sourceMediaUrl === null) {
			await this.fail(fax, "This outbound fax has no source document URL.");
			return 0;
		}

		try {
			const sent = await this.carrier.faxes.send({
				connectionId: this.env.TELNYX_FAX_CONNECTION_ID,
				from: fax.fromE164,
				to: fax.toE164,
				mediaUrl: fax.sourceMediaUrl,
				// Echoed back on every fax.* webhook, so the terminal outcome correlates to this row.
				clientState: fax.id,
			});
			await this.database.withTenantScope(
				fax.organizationId,
				async (transaction) => await markSent(transaction, fax.id, sent.id),
			);
			this.sent += 1;
			logger.info(
				{ organizationId: fax.organizationId, faxId: fax.id, telnyxFaxId: sent.id },
				"an outbound fax was accepted by the carrier",
			);
			return 1;
		} catch (error) {
			// Transient: release the claim so the lease re-offers the row, unless the attempts are now
			// spent — in which case fail terminally with the carrier's message.
			if (fax.attempts >= retryAttempts) {
				await this.fail(fax, errorMessage(error));
				return 0;
			}
			logger.warn(
				{ organizationId: fax.organizationId, faxId: fax.id, err: String(error) },
				"an outbound fax send attempt failed; it will be retried when its lease expires",
			);
			await this.database.withTenantScope(
				fax.organizationId,
				async (transaction) => await releaseSend(transaction, fax.id),
			);
			return 0;
		}
	}

	private async fail(fax: ClaimableFax, reason: string): Promise<void> {
		this.failed += 1;
		await this.database.withTenantScope(
			fax.organizationId,
			async (transaction) => await failSend(transaction, fax.id, reason),
		);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
