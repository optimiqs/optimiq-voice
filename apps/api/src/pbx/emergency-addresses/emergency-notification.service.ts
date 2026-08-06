import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logger";
import { emergencyAddress, eq, extension } from "@optimiq-voice/pbx-db";
import {
	DEFAULT_MAIL_APP_NAME,
	emergencyDialedMail,
	formatDispatchableLocation,
	Mailer,
} from "../../mail";
import { OrgSettingsService } from "../org-settings/org-settings.service";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/** The header a mail store collapses a redelivery on. The value is the EVENT's uuid v7. */
export const EMERGENCY_EVENT_ID_HEADER = "X-Optimiq-Emergency-Event-Id";

/** The `call.emergency.dialed` payload, plus the envelope fields this needs. */
export interface EmergencyDialedNotice {
	/** The envelope's `id` — uuid v7, and the idempotency key. */
	readonly eventId: string;
	/** The envelope's `at` — when the call was PLACED, not when this ran. */
	readonly dialedAt: Date;
	readonly dialed: string;
	readonly number: string;
	readonly callerNumber?: string | undefined;
	readonly callerName?: string | undefined;
	readonly elin?: string | undefined;
	readonly emergencyAddressId?: string | undefined;
	readonly trunkName?: string | undefined;
}

/** Why a notice was not delivered. Returned rather than thrown; each of these is a normal answer. */
export type EmergencyNotificationSkip = "no-recipients";

export type EmergencyNotificationOutcome =
	| { readonly outcome: "sent"; readonly to: readonly string[] }
	| {
			readonly outcome: "partial";
			readonly to: readonly string[];
			readonly failed: readonly string[];
	  }
	| { readonly outcome: "skipped"; readonly reason: EmergencyNotificationSkip }
	| { readonly outcome: "failed" };

/**
 * The Kari's Law notification — the consumer half of `call.emergency.dialed`.
 *
 * ## Why the delivery lives here and not in `apps/engine`
 *
 * `packages/events` states the contract: "the engine publishes this the moment the first trunk
 * attempt is made — before the answer, because the notification is about the attempt — and
 * delivery is a consumer's job." The engine holds no tenant configuration and no SMTP handle, so
 * it cannot know who a tenant's front desk is, and a notification that lives inside the engine is
 * a notification one process can lose. This process already owns `pbx-db`, the settings cascade
 * and the `Mailer`, which is exactly the three things a notification needs.
 *
 * ## The call is never blocked, structurally
 *
 * §9.16(b) requires the notification not to delay the call, and the architecture makes that
 * unfalsifiable rather than careful: the engine PUBLISHES and moves on, and everything in this
 * file happens after the fact on a different process reading a JetStream consumer. There is no
 * code path from here back to the call. {@link notify} therefore never throws either — every
 * refusal is a named outcome — so the consumer's ack decision is never a function of the relay
 * being up.
 *
 * ## Best-effort per recipient, and a partial send is not a failure
 *
 * A distribution list with four addresses where one bounces has still notified the central
 * location. Each address is sent independently and the outcome names which ones did not take, so
 * a redelivery-driven retry is a judgement the operator can make from a log rather than an
 * automatic re-mail to the three people who already have it.
 *
 * ## An unconfigured tenant is loud, not silent
 *
 * `notifications.emergencyNotificationEmails` defaults to empty and empty means nobody. There is
 * no defensible platform-wide default recipient (see the catalogue entry), so the miss is logged
 * at `warn` naming the setting and the organization — which is the only place a deployment can
 * discover that its Kari's Law obligation is unmet BEFORE somebody dials 911.
 */
@Injectable()
export class EmergencyNotificationService {
	private sent = 0;
	private skipped = 0;
	private failed = 0;

	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(Mailer) private readonly mailer: Mailer,
		@Inject(OrgSettingsService) private readonly settings: OrgSettingsService,
	) {}

	get stats(): { readonly sent: number; readonly skipped: number; readonly failed: number } {
		return { sent: this.sent, skipped: this.skipped, failed: this.failed };
	}

	/** Notifies an organization's central location. Never throws; see the class header. */
	async notify(
		organizationId: string,
		notice: EmergencyDialedNotice,
	): Promise<EmergencyNotificationOutcome> {
		try {
			return await this.deliver(organizationId, notice);
		} catch (error) {
			this.failed += 1;
			logger.error("failed to send an emergency notification", {
				organizationId,
				eventId: notice.eventId,
				error,
			});
			return { outcome: "failed" };
		}
	}

	private async deliver(
		organizationId: string,
		notice: EmergencyDialedNotice,
	): Promise<EmergencyNotificationOutcome> {
		const policy = await this.settings.readNotificationSettingsFor(organizationId);
		const recipients = [
			...new Set(
				policy.emergencyNotificationEmails
					.map((address) => address.trim())
					.filter((address) => address.length > 0),
			),
		];
		if (recipients.length === 0) {
			this.skipped += 1;
			logger.warn(
				"an emergency call was placed and this organization has no Kari's Law recipients " +
					"configured; set notifications.emergencyNotificationEmails",
				{ organizationId, number: notice.number, eventId: notice.eventId },
			);
			return { outcome: "skipped", reason: "no-recipients" };
		}

		const context = await this.readContext(organizationId, notice);
		const rendered = emergencyDialedMail({
			appName: DEFAULT_MAIL_APP_NAME,
			...(policy.fromName === undefined ? {} : { fromName: policy.fromName }),
			dialed: notice.dialed,
			number: notice.number,
			...(notice.callerNumber === undefined ? {} : { callerNumber: notice.callerNumber }),
			...(notice.callerName === undefined ? {} : { callerName: notice.callerName }),
			...(context.callerExtension === undefined
				? {}
				: { callerExtension: context.callerExtension }),
			...(notice.elin === undefined ? {} : { elin: notice.elin }),
			...(context.location === undefined ? {} : { location: context.location }),
			...(context.locationUnknown ? { locationUnknown: true } : {}),
			...(notice.trunkName === undefined ? {} : { trunkName: notice.trunkName }),
			dialedAt: notice.dialedAt,
		});

		const delivered: string[] = [];
		const failed: string[] = [];
		for (const to of recipients) {
			const result = await this.mailer.sendRendered(to, rendered, {
				...(policy.replyTo === undefined ? {} : { replyTo: policy.replyTo }),
				// The EVENT's id, stable across every redelivery of this message, so a mail store that
				// receives a duplicate can collapse it. JetStream will redeliver — a crash between the
				// ack and the send guarantees it eventually — and duplicating a life-safety notice is
				// the direction to fail in.
				headers: { [EMERGENCY_EVENT_ID_HEADER]: notice.eventId },
			});
			if (result.delivered) {
				delivered.push(to);
			} else {
				failed.push(to);
			}
		}

		if (delivered.length === 0) {
			this.failed += 1;
			return { outcome: "failed" };
		}
		this.sent += 1;
		if (failed.length > 0) {
			logger.warn("an emergency notification reached some recipients but not all", {
				organizationId,
				eventId: notice.eventId,
				failed,
			});
			return { outcome: "partial", to: delivered, failed };
		}
		return { outcome: "sent", to: delivered };
	}

	/**
	 * The two facts the event carries by REFERENCE, resolved inside one tenant scope so RLS filters.
	 *
	 * The dispatchable location is looked up by the `emergency_address.id` the event names — the
	 * engine cannot ship the address because it holds no database handle. An id that resolves to
	 * nothing is reported as `locationUnknown` rather than as an absent field, because "the number
	 * has an address on record and we could not read it" and "no address is registered" are
	 * different problems and only one of them is a data-entry error.
	 *
	 * The extension is a best-effort reverse lookup of the calling station's number. It is not on
	 * the event (the engine knows the leg, not the directory), and it is what turns "+12125550100
	 * dialed 911" into "extension 214 dialed 911" for a front desk that thinks in extensions.
	 */
	private async readContext(
		organizationId: string,
		notice: EmergencyDialedNotice,
	): Promise<{
		readonly location: string | undefined;
		readonly locationUnknown: boolean;
		readonly callerExtension: string | undefined;
	}> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			let location: string | undefined;
			let locationUnknown = false;
			if (notice.emergencyAddressId !== undefined) {
				const rows = await transaction
					.select({
						label: emergencyAddress.label,
						streetLine1: emergencyAddress.streetLine1,
						streetLine2: emergencyAddress.streetLine2,
						locationDetail: emergencyAddress.locationDetail,
						locality: emergencyAddress.locality,
						administrativeArea: emergencyAddress.administrativeArea,
						postalCode: emergencyAddress.postalCode,
						country: emergencyAddress.country,
					})
					.from(emergencyAddress)
					.where(eq(emergencyAddress.id, notice.emergencyAddressId))
					.limit(1);
				const address = rows[0];
				if (address === undefined) {
					locationUnknown = true;
				} else {
					const formatted = formatDispatchableLocation(address);
					location = formatted.length === 0 ? undefined : formatted;
					locationUnknown = location === undefined;
				}
			}

			let callerExtension: string | undefined;
			const number = notice.callerNumber?.trim();
			if (number !== undefined && number.length > 0) {
				const rows = await transaction
					.select({ number: extension.number, label: extension.label })
					.from(extension)
					.where(eq(extension.number, number))
					.limit(1);
				const found = rows[0];
				if (found !== undefined) {
					callerExtension =
						found.label.trim().length === 0 ? found.number : `${found.number} (${found.label})`;
				}
			}

			return { location, locationUnknown, callerExtension };
		});
	}
}
