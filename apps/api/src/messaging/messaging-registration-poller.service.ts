import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { TELNYX_CLIENT } from "../pbx/carrier/carrier.tokens";
import { PBX_DATABASE } from "../pbx/shared/pbx.tokens";
import {
	brandStatusReason,
	campaignStatusReason,
	mapBrandStatus,
	mapCampaignStatus,
	mapTollFreeStatus,
	tollFreeStatusReason,
} from "./messaging-registration.service";
import { messagingRegistrationTransitions } from "./messaging.metrics";
import {
	findPendingRegistrationsAdmin,
	getBrand,
	getCampaign,
	listNumbersForCampaign,
	listTollFreeVerifications,
	updateBrand,
	updateCampaign,
	updateMessagingNumber,
	updateTollFreeVerification,
} from "./messaging.repository";
import { MESSAGING_ENV } from "./messaging.tokens";
import type { MessagingEnv } from "./messaging-env";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";
import type { TelnyxClient } from "@optimiq-voice/telnyx";

const logger = getLogger("api.messaging");

/** How many still-moving registrations one pass reconciles. See {@link MessagingRegistrationPoller}. */
const BATCH = 25;

/**
 * Reconciles pending A2P registrations against the registries, and fans the verdict out to numbers.
 *
 * ## Why a poller and not a webhook
 *
 * Telnyx does emit brand and campaign status webhooks, and this platform does not rely on them. A
 * registration is the precondition for a tenant being able to send at all, so a single missed
 * delivery is not a delayed notification, it is a tenant whose approved campaign never unblocks and
 * whose only recourse is a support ticket. Polling a handful of rows every five minutes
 * (`MESSAGING_REGISTRATION_POLL_INTERVAL_MS`, deliberately slow — TCR vetting takes days) is cheap
 * and self-healing; a webhook is neither. If the webhooks are wired later they become an accelerator
 * for this loop, not a replacement.
 *
 * ## The fan-out is the point
 *
 * Writing the new status onto the brand/campaign/verification row is the easy half and would be
 * nearly useless on its own: the send gate reads `messaging_number.registration_status`, not the
 * campaign's. So every observed transition is pushed down onto the NUMBERS —
 *
 * - a campaign reaching `active` registers every number assigned to it;
 * - a campaign LEAVING `active` (suspended, expired, rejected) un-registers all of them, with a
 *   reason quoting the campaign's new status;
 * - a toll-free verification reaching `verified` registers its one number, and `rejected` marks it
 *   rejected with the aggregator's own words.
 *
 * That second bullet is the one that matters operationally. When a carrier suspends a campaign
 * overnight — which they do, without warning — the traffic from its numbers is being filtered from
 * that moment. Without the fan-out this platform would keep accepting sends against a stale
 * `registered` and hand them to a carrier that drops them silently; with it, the next pass turns
 * every one of those sends into a 422 that names the suspension. The metric
 * `api_messaging_registration_transitions_total` is what makes that visible on a dashboard.
 *
 * ## One pass never throws
 *
 * Each row is reconciled in its own try/catch. One tenant's carrier error — a deleted brand, a rate
 * limit, a 500 from the registry — must not abandon the other twenty-four rows in the batch, and the
 * next pass will retry the failed one anyway. `lastPolledAt` is written even when nothing changed,
 * so "the poller is alive and this brand is genuinely still pending" is distinguishable from "the
 * poller has been dead for a week".
 */
@Injectable()
export class MessagingRegistrationPoller implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private swept = 0;
	private changed = 0;

	constructor(
		@Inject(MESSAGING_ENV) private readonly env: MessagingEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(TELNYX_CLIENT) private readonly carrier: TelnyxClient | undefined,
	) {}

	get stats(): { readonly swept: number; readonly changed: number } {
		return { swept: this.swept, changed: this.changed };
	}

	onModuleInit(): void {
		// No carrier means every reconciliation would be a no-op against nothing; arming the timer
		// would only produce a log line every five minutes saying so.
		if (this.env.MESSAGING_REGISTRATION_POLL_INTERVAL_MS === 0 || this.carrier === undefined) {
			return;
		}
		this.timer = setInterval(() => {
			void this.tick();
		}, this.env.MESSAGING_REGISTRATION_POLL_INTERVAL_MS);
		this.timer.unref?.();
		logger.info(
			{ intervalMs: this.env.MESSAGING_REGISTRATION_POLL_INTERVAL_MS },
			"messaging registration poller started",
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
	 * One reconciliation pass. Public so a harness can drive it without waiting out the interval;
	 * re-entrancy is refused rather than queued, because a pass that overruns the interval is already
	 * behind and a second concurrent pass would fight it for the same rows.
	 */
	async tick(): Promise<{ readonly reconciled: number; readonly changed: number }> {
		if (this.running || this.stopped || this.carrier === undefined) {
			return { reconciled: 0, changed: 0 };
		}
		this.running = true;
		this.swept += 1;
		try {
			// The "which registration anywhere is still moving" question is the platform's, not a
			// tenant's, so the scan is untenanted and each reconciliation re-enters the row's scope.
			const pending = await findPendingRegistrationsAdmin(this.database.adminDb, BATCH);
			let changed = 0;
			for (const row of pending) {
				if (this.stopped) {
					break;
				}
				try {
					if (await this.reconcile(row)) {
						changed += 1;
						this.changed += 1;
					}
				} catch (error) {
					logger.warn(
						{
							organizationId: row.organizationId,
							kind: row.kind,
							id: row.id,
							err: String(error),
						},
						"a registration could not be reconciled against the carrier; it stays pending",
					);
				}
			}
			return { reconciled: pending.length, changed };
		} catch (error) {
			logger.error({ err: error }, "the messaging registration poll failed");
			return { reconciled: 0, changed: 0 };
		} finally {
			this.running = false;
		}
	}

	private async reconcile(row: {
		readonly kind: "brand" | "campaign" | "toll-free";
		readonly id: string;
		readonly organizationId: string;
		readonly carrierId: string;
	}): Promise<boolean> {
		switch (row.kind) {
			case "brand":
				return await this.reconcileBrand(row.organizationId, row.id, row.carrierId);
			case "campaign":
				return await this.reconcileCampaign(row.organizationId, row.id, row.carrierId);
			default:
				return await this.reconcileTollFree(row.organizationId, row.id, row.carrierId);
		}
	}

	private async reconcileBrand(
		organizationId: string,
		id: string,
		carrierBrandId: string,
	): Promise<boolean> {
		const carrier = this.carrier;
		if (carrier === undefined) {
			return false;
		}
		const remote = await carrier.tenDlc.getBrand(carrierBrandId);
		const status = mapBrandStatus(remote.identityStatus);

		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const local = await getBrand(transaction, id);
			if (local === undefined) {
				return false;
			}
			if (local.status === status) {
				await updateBrand(transaction, id, { lastPolledAt: new Date() });
				return false;
			}
			await updateBrand(transaction, id, {
				status,
				statusReason: remote.failureReasons ?? brandStatusReason(status),
				lastPolledAt: new Date(),
			});
			messagingRegistrationTransitions.inc({ kind: "brand", status });
			logger.info(
				{ organizationId, brandId: id, from: local.status, to: status },
				"a 10DLC brand changed status at the registry",
			);
			// No fan-out: a brand does not gate sending on its own. Its campaigns do, and each of them
			// is its own row in the same scan — so a brand that fails is felt when its campaigns are
			// failed by the registry, which is the moment the carriers actually stop the traffic.
			return true;
		});
	}

	private async reconcileCampaign(
		organizationId: string,
		id: string,
		carrierCampaignId: string,
	): Promise<boolean> {
		const carrier = this.carrier;
		if (carrier === undefined) {
			return false;
		}
		const remote = await carrier.tenDlc.getCampaign(carrierCampaignId);
		const status = mapCampaignStatus(remote.campaignStatus ?? remote.status);

		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const local = await getCampaign(transaction, id);
			if (local === undefined) {
				return false;
			}
			if (local.status === status) {
				await updateCampaign(transaction, id, { lastPolledAt: new Date() });
				return false;
			}
			const reason = remote.failureReasons ?? campaignStatusReason(status);
			await updateCampaign(transaction, id, {
				status,
				statusReason: reason,
				lastPolledAt: new Date(),
			});
			messagingRegistrationTransitions.inc({ kind: "campaign", status });

			// THE FAN-OUT. See the class header: the send gate reads the NUMBER's registration status,
			// so a campaign transition that stopped here would be a dashboard change with no effect on
			// what this platform is willing to hand a carrier.
			await fanOutCampaign(transaction, id, local.name, status, reason);

			logger.info(
				{ organizationId, campaignId: id, from: local.status, to: status },
				"a 10DLC campaign changed status at the registry",
			);
			return true;
		});
	}

	private async reconcileTollFree(
		organizationId: string,
		id: string,
		carrierVerificationId: string,
	): Promise<boolean> {
		const carrier = this.carrier;
		if (carrier === undefined) {
			return false;
		}
		const remote = await carrier.tollFreeVerification.get(carrierVerificationId);
		const status = mapTollFreeStatus(remote.verificationStatus);

		return await this.database.withTenantScope(organizationId, async (transaction) => {
			// There is no `getTollFreeVerification` by id in the repository, and adding one for the
			// poller alone is not worth a column set: the pending page is small by construction (the
			// scan only offers rows that are pending or in-review) and this reads the same rows.
			const { rows } = await listTollFreeVerifications(transaction, {
				page: 1,
				limit: 200,
				offset: 0,
			});
			const local = rows.find((candidate) => candidate.id === id);
			if (local === undefined) {
				return false;
			}
			if (local.status === status) {
				await updateTollFreeVerification(transaction, id, { lastPolledAt: new Date() });
				return false;
			}
			const reason = remote.rejectionReason ?? remote.reason ?? tollFreeStatusReason(status);
			await updateTollFreeVerification(transaction, id, {
				status,
				statusReason: reason,
				lastPolledAt: new Date(),
			});
			messagingRegistrationTransitions.inc({ kind: "toll-free", status });

			// The toll-free fan-out, one number rather than a set: a verification names exactly the
			// number it was filed for, and that number's ability to send is the whole outcome.
			if (status === "verified") {
				await updateMessagingNumber(transaction, local.messagingNumberId, {
					registrationStatus: "registered",
					registrationReason: null,
				});
			} else if (status === "rejected") {
				await updateMessagingNumber(transaction, local.messagingNumberId, {
					registrationStatus: "rejected",
					registrationReason:
						reason ??
						"The aggregators rejected this number's toll-free verification. Correct the " +
							"submission and file it again.",
				});
			}
			logger.info(
				{ organizationId, verificationId: id, from: local.status, to: status },
				"a toll-free verification changed status at the aggregators",
			);
			return true;
		});
	}
}

/**
 * Pushes a campaign's new status onto every number assigned to it.
 *
 * `active` is the only status that registers a number, and everything else un-registers it — there
 * is no "leave it as it was" branch, on purpose. A number left `registered` under a campaign that is
 * no longer active is precisely the stale state that lets this platform hand a carrier traffic it is
 * already filtering, and the tenant discovers it as messages that were "sent" and never arrived.
 *
 * The reason QUOTES the campaign's new status rather than paraphrasing it, so the 422 an agent sees
 * on the next send and the badge on the campaign page say the same word.
 */
async function fanOutCampaign(
	transaction: PbxDatabaseTransaction,
	campaignId: string,
	campaignName: string,
	status: string,
	statusReason: string | null,
): Promise<void> {
	const numbers = await listNumbersForCampaign(transaction, campaignId);
	if (numbers.length === 0) {
		return;
	}
	const registered = status === "active";
	const reason = registered
		? null
		: `Campaign "${campaignName}" is ${status}${statusReason === null ? "" : ` — ${statusReason}`}` +
			". The carriers accept traffic only from an active campaign.";
	for (const number of numbers) {
		await updateMessagingNumber(transaction, number.id, {
			registrationStatus: registered ? "registered" : "unregistered",
			registrationReason: reason,
		});
	}
}
