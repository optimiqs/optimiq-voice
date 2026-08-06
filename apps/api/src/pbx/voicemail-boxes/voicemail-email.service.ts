import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logger";
import { eq, voicemailBox, voicemailMessage } from "@optimiq-voice/pbx-db";
import { DEFAULT_MAIL_APP_NAME, Mailer, voicemailMail } from "../../mail";
import { OrgSettingsService } from "../org-settings/org-settings.service";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import { mintVoicemailMediaToken, voicemailMediaPath } from "./voicemail-media-token";
import type { PbxEnv } from "../shared/pbx-env";
import type { PbxDatabaseClient, VoicemailEmailMode } from "@optimiq-voice/pbx-db";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/** Why a message was not emailed. Returned rather than thrown; every one of these is normal. */
export type VoicemailEmailSkip =
	| "org-disabled"
	| "mailbox-mode-none"
	| "no-address"
	| "no-such-message";

/**
 * A string discriminant rather than `sent: true | false`, for the reason `org-settings.dto.ts`
 * records: `apps/api`'s tooling tsconfig relaxes `strictNullChecks`, and without it a union is not
 * narrowed by a boolean-literal member.
 */
export type VoicemailEmailOutcome =
	| { readonly outcome: "sent"; readonly to: string; readonly linked: boolean }
	| { readonly outcome: "skipped"; readonly reason: VoicemailEmailSkip }
	| { readonly outcome: "failed" };

/**
 * Voicemail-to-email.
 *
 * ## Where it sits, and why it is not in `apps/engine`
 *
 * The engine records the audio and publishes `voicemail.evt.v1.<orgId>.<mailboxId>.message.left`.
 * It holds no database handle on purpose — nothing on the call path may need Postgres to be up —
 * so it cannot know the mailbox's email address, cannot read the organization's notification
 * policy, and cannot mint a signed link against a row it has not written. All three of those are
 * control-plane facts, which is why `VoicemailConsumer` already exists here to file the row, and
 * why this hangs off that consumer rather than off the publisher.
 *
 * ## Two switches, both of which must be on
 *
 * `voicemail_box.email_mode` is the mailbox's own preference (`none` / `notify` / `attach`) and
 * `notifications.voicemailToEmailEnabled` is the organization's policy. The org switch can only
 * narrow: a tenant that turns voicemail-to-email off stops every mailbox, and a mailbox set to
 * `none` is never emailed even when the tenant allows it. See `org-settings.catalog.ts` for why
 * both exist.
 *
 * ## `attach` is honoured as `notify`, deliberately, and it is recorded rather than hidden
 *
 * The schema's third mode means "send the audio as an attachment". This implementation does not
 * attach: it sends a signed, expiring link instead, for the reason the whole media surface is
 * built that way — `voicemail-media-token.ts` and `recording-token.ts` exist precisely so audio
 * leaves this process through a route that verifies a signature and re-checks the tenant's RLS
 * scope, and an attachment is a copy of a customer's recording sitting in an arbitrary mail store
 * forever with no revocation, no expiry and no audit trail. Rotating
 * `PBX_VOICEMAIL_URL_SECRET` kills every outstanding link; nothing kills an attachment.
 *
 * A mailbox set to `attach` therefore still gets its notification, still gets its link, and the
 * difference is logged once per message at `debug` so the gap between the column's vocabulary and
 * this behaviour is discoverable rather than surprising. Closing it properly means a
 * `deleteAfterDelivery` story too (the column exists and nothing reads it) and is recorded as
 * follow-up work, not silently absorbed here.
 *
 * ## Delivery is best-effort, after the ack
 *
 * The message IS filed and durable before this runs. A relay that is down must not cause the row
 * to be written twice, so this never throws into the consumer's failure path — exactly the rule
 * `publishMwi` follows, and for the same reason.
 */
@Injectable()
export class VoicemailEmailService {
	private sent = 0;
	private skipped = 0;
	private failed = 0;

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(Mailer) private readonly mailer: Mailer,
		@Inject(OrgSettingsService) private readonly settings: OrgSettingsService,
	) {}

	get stats(): { readonly sent: number; readonly skipped: number; readonly failed: number } {
		return { sent: this.sent, skipped: this.skipped, failed: this.failed };
	}

	/**
	 * Notifies a mailbox about a message that has just been filed.
	 *
	 * Never throws. Every refusal is a named outcome, because "was that voicemail emailed?" is a
	 * question an operator asks about one specific message and a boolean cannot answer.
	 */
	async notify(
		organizationId: string,
		mailboxId: string,
		messageId: string,
	): Promise<VoicemailEmailOutcome> {
		try {
			return await this.deliver(organizationId, mailboxId, messageId);
		} catch (error) {
			this.failed += 1;
			logger.error("failed to send a voicemail notification", {
				organizationId,
				mailboxId,
				messageId,
				error,
			});
			return { outcome: "failed" };
		}
	}

	private async deliver(
		organizationId: string,
		mailboxId: string,
		messageId: string,
	): Promise<VoicemailEmailOutcome> {
		// The organization's policy first: it is one query and it short-circuits every mailbox in a
		// tenant that has switched the feature off.
		const policy = await this.settings.readNotificationSettingsFor(organizationId);
		if (!policy.voicemailToEmailEnabled) {
			this.skipped += 1;
			return { outcome: "skipped", reason: "org-disabled" };
		}

		const context = await this.readContext(organizationId, mailboxId, messageId);
		if (context === undefined) {
			this.skipped += 1;
			return { outcome: "skipped", reason: "no-such-message" };
		}
		if (context.emailMode === "none") {
			this.skipped += 1;
			return { outcome: "skipped", reason: "mailbox-mode-none" };
		}
		const to = context.emailAddress?.trim();
		if (to === undefined || to.length === 0) {
			this.skipped += 1;
			return { outcome: "skipped", reason: "no-address" };
		}
		if (context.emailMode === "attach") {
			logger.debug(
				"this mailbox asks for the audio as an attachment; sending a signed link instead",
				{ organizationId, mailboxId },
			);
		}

		const playUrl = policy.voicemailToEmailIncludeLink
			? this.mintPlaybackUrl(organizationId, messageId)
			: undefined;
		const inboxUrl =
			this.mailer.appUrl === undefined ? undefined : `${this.mailer.appUrl}/voicemail`;
		const transcription =
			policy.voicemailToEmailIncludeTranscription && context.transcription !== null
				? context.transcription
				: undefined;

		const rendered = voicemailMail({
			appName: DEFAULT_MAIL_APP_NAME,
			fromName: policy.fromName,
			mailboxNumber: context.mailboxNumber,
			mailboxLabel: context.label ?? undefined,
			callerIdName: context.callerIdName ?? undefined,
			callerIdNumber: context.callerIdNumber ?? undefined,
			receivedAt: context.receivedAt,
			durationMs: context.durationMs,
			playUrl,
			inboxUrl,
			transcription,
		});

		const result = await this.mailer.sendRendered(to, rendered, {
			...(policy.replyTo === undefined ? {} : { replyTo: policy.replyTo }),
			// A stable per-message header, so a mail store that receives a redelivery-driven duplicate
			// can thread or suppress it rather than showing the same voicemail twice.
			headers: { "X-Optimiq-Voicemail-Message-Id": messageId },
		});

		if (!result.delivered) {
			this.failed += 1;
			return { outcome: "failed" };
		}
		this.sent += 1;
		return { outcome: "sent", to, linked: playUrl !== undefined };
	}

	/**
	 * A signed, expiring absolute URL, or `undefined` when no key is configured.
	 *
	 * `PBX_VOICEMAIL_EMAIL_URL_TTL_SECONDS` rather than the web UI's TTL — see `pbx-env.ts` for why
	 * the two differ. Without `MAIL_APP_URL` / `API_APP_URL` there is no origin to make the path
	 * absolute against, and a relative URL in an email is not a link, so the notification goes out
	 * with the metadata alone rather than with something unclickable.
	 */
	private mintPlaybackUrl(organizationId: string, messageId: string): string | undefined {
		const secret = this.env.PBX_VOICEMAIL_URL_SECRET;
		const origin = this.mailer.appUrl;
		if (secret === undefined || origin === undefined) {
			return undefined;
		}
		const expiresAt = Math.floor(Date.now() / 1000) + this.env.PBX_VOICEMAIL_EMAIL_URL_TTL_SECONDS;
		return `${origin}${voicemailMediaPath(
			mintVoicemailMediaToken(messageId, organizationId, expiresAt, secret),
		)}`;
	}

	/** The box and the message, read together inside one tenant scope so RLS is the filter. */
	private async readContext(
		organizationId: string,
		mailboxId: string,
		messageId: string,
	): Promise<VoicemailEmailContext | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const boxes = await transaction
				.select({
					mailboxNumber: voicemailBox.mailboxNumber,
					label: voicemailBox.label,
					emailAddress: voicemailBox.emailAddress,
					emailMode: voicemailBox.emailMode,
				})
				.from(voicemailBox)
				.where(eq(voicemailBox.id, mailboxId))
				.limit(1);
			const box = boxes[0];
			if (box === undefined) {
				return undefined;
			}

			const messages = await transaction
				.select({
					callerIdName: voicemailMessage.callerIdName,
					callerIdNumber: voicemailMessage.callerIdNumber,
					receivedAt: voicemailMessage.receivedAt,
					durationMs: voicemailMessage.durationMs,
					transcription: voicemailMessage.transcription,
				})
				.from(voicemailMessage)
				.where(eq(voicemailMessage.id, messageId))
				.limit(1);
			const message = messages[0];
			if (message === undefined) {
				return undefined;
			}

			return { ...box, ...message };
		});
	}
}

interface VoicemailEmailContext {
	readonly mailboxNumber: string;
	readonly label: string | null;
	readonly emailAddress: string | null;
	readonly emailMode: VoicemailEmailMode;
	readonly callerIdName: string | null;
	readonly callerIdNumber: string | null;
	readonly receivedAt: Date;
	readonly durationMs: number;
	readonly transcription: string | null;
}
