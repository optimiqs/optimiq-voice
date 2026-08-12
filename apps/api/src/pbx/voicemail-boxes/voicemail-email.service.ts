import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import {
	and,
	eq,
	extensionUser,
	isNull,
	voicemailBox,
	voicemailMessage,
} from "@optimiq-voice/pbx-db";
import { DEFAULT_MAIL_APP_NAME, Mailer, voicemailMail } from "../../mail";
import { OrgSettingsService } from "../org-settings/org-settings.service";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import { mintVoicemailMediaToken, voicemailMediaPath } from "./voicemail-media-token";
import type { PbxEnv } from "../shared/pbx-env";
import type {
	PbxDatabaseClient,
	VoicemailEmailMode,
	VoicemailTranscriptionStatus,
} from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/** Why a message was not emailed. Returned rather than thrown; every one of these is normal. */
export type VoicemailEmailSkip =
	| "org-disabled"
	| "mailbox-mode-none"
	| "no-address"
	| "no-such-message"
	/** Somebody else already sent it. Normal: the deferred path has three racing senders. */
	| "already-sent";

/**
 * What goes where a transcript would, when the organization asked for one and there is none.
 *
 * A marker rather than an omission, because the two facts are different and the reader can only tell
 * them apart if the mail says so: a notification with no transcript section reads as "this mailbox
 * does not do transcription", and one that says the transcript is unavailable reads as "it was
 * supposed to and something went wrong" — which is the difference between a user who shrugs and a
 * user who tells an administrator.
 */
export const TRANSCRIPTION_UNAVAILABLE = "[transcription unavailable]";

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
 * ## Two switches, both of which must be on — and one person's presentation on top
 *
 * `voicemail_box.email_mode` is the mailbox's own preference (`none` / `notify` / `attach`) and
 * `notifications.voicemailToEmailEnabled` is the organization's policy. The org switch can only
 * narrow: a tenant that turns voicemail-to-email off stops every mailbox, and a mailbox set to
 * `none` is never emailed even when the tenant allows it. See `org-settings.catalog.ts` for why
 * both exist.
 *
 * The two `include*` settings are now resolved through the USER level as well — this is the
 * consumer that makes `user_setting`'s return more than a table. The user behind a mailbox is
 * found through the only join that exists: `voicemail_box.extension_id → extension_user`, taking
 * the `primary` link and nobody else's. A `shared` or `delegate` link is somebody ELSE's access
 * to the line, and rendering the box's mail to a delegate's taste would apply one colleague's
 * preference to another colleague's inbox. A box with no extension, or an extension with no
 * primary user, resolves org-only — exactly what every box did before the level existed.
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
			logger.error(
				{
					organizationId,
					mailboxId,
					messageId,
					error,
				},
				"failed to send a voicemail notification",
			);
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
				{ organizationId, mailboxId },
				"this mailbox asks for the audio as an attachment; sending a signed link instead",
			);
		}

		/**
		 * The user level, applied only once a user is known. The org read above stays first and
		 * stays the kill switch — it is one query that short-circuits a whole disabled tenant
		 * before the box is even fetched, and `voicemailToEmailEnabled` is not user-scoped so no
		 * override could revive it. Only the two presentation settings can differ here, which
		 * `resolveForUser` guarantees by construction.
		 */
		const effective =
			context.userId === undefined
				? policy
				: await this.settings.readNotificationSettingsForUser(organizationId, context.userId);

		const playUrl = effective.voicemailToEmailIncludeLink
			? this.mintPlaybackUrl(organizationId, messageId)
			: undefined;
		const inboxUrl =
			this.mailer.appUrl === undefined ? undefined : `${this.mailer.appUrl}/voicemail`;
		const transcription = transcriptionFor(
			effective.voicemailToEmailIncludeTranscription,
			context.transcription,
			context.transcriptionStatus,
		);

		// The claim goes here and not a line earlier: every refusal above is a decision NOT to send,
		// and marking a message as notified because a mailbox is set to `none` would make
		// `email_sent_at` mean "somebody looked at this", which is a column nothing could then use to
		// answer the question it exists for.
		if (!(await this.claim(organizationId, messageId))) {
			this.skipped += 1;
			return { outcome: "skipped", reason: "already-sent" };
		}

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
			// The claim is GIVEN BACK, and this is the one place the once-only rule bends. It bends in
			// the safe direction: nothing was delivered, so releasing cannot produce a duplicate in
			// anybody's inbox, and holding the claim would mean a relay that was briefly down
			// permanently suppresses a notification the back-fill would otherwise re-drive. The window
			// it opens — two senders, one of which fails, and the other reads the released row — costs
			// at worst one duplicate after a failure that has already been logged.
			await this.release(organizationId, messageId);
			this.failed += 1;
			return { outcome: "failed" };
		}
		this.sent += 1;
		return { outcome: "sent", to, linked: playUrl !== undefined };
	}

	/**
	 * Whether this organization wants its voicemail notifications to WAIT for a transcript.
	 *
	 * The consumer's question at filing time, answered from the same policy read the send itself
	 * uses. Both switches, because deferring a notification an organization has turned off would be
	 * waiting ninety seconds to skip.
	 *
	 * The mailbox's half of the decision — whether this message is being transcribed at all — is the
	 * consumer's to add, and it has it already: `file()` returns it as `transcribe`.
	 *
	 * The USER level is deliberately not consulted here, though `voicemailToEmailIncludeTranscription`
	 * is user-scoped: resolving the mailbox's user at this seam would put the extension-user join on
	 * every filing to refine a scheduling hint, and being wrong costs only comfort — a deferral that
	 * was not needed, or a send whose transcript section says unavailable. The SEND honours the
	 * override; this only decides how long to wait for it.
	 */
	async deferForTranscription(organizationId: string): Promise<boolean> {
		try {
			const policy = await this.settings.readNotificationSettingsFor(organizationId);
			return policy.voicemailToEmailEnabled && policy.voicemailToEmailIncludeTranscription;
		} catch (error) {
			// A settings read that fails must not hold a notification hostage. Sending now, without a
			// transcript, is the failure mode this whole feature is allowed to have.
			logger.warn(
				{ organizationId, err: error },
				"could not read the notification policy; sending the voicemail notification immediately",
			);
			return false;
		}
	}

	/**
	 * Takes the right to send, atomically. `true` means this caller owns the notification.
	 *
	 * `UPDATE … SET email_sent_at = now() WHERE id = … AND email_sent_at IS NULL RETURNING id` — a
	 * compare-and-set on the row rather than a flag in this process, because the deferred path has
	 * three possible senders (the transcription worker, its budget timer, the back-fill) and two of
	 * them can be in a DIFFERENT process. Under `READ COMMITTED` the loser's predicate is re-evaluated
	 * against the winner's committed version and matches nothing, so it returns no rows and says so.
	 *
	 * Inside `withTenantScope`, so RLS is still the filter: the id came from a claim on the untenanted
	 * handle, and re-proving the message belongs to this organization before writing to it is the same
	 * rule the transcription worker follows for the object key.
	 */
	private async claim(organizationId: string, messageId: string): Promise<boolean> {
		const claimed = await this.database.withTenantScope(organizationId, async (transaction) =>
			transaction
				.update(voicemailMessage)
				.set({ emailSentAt: new Date() })
				.where(and(eq(voicemailMessage.id, messageId), isNull(voicemailMessage.emailSentAt)))
				.returning({ id: voicemailMessage.id }),
		);
		return claimed.length > 0;
	}

	/** Undoes a claim whose send did not happen. See the call site for why this is safe. */
	private async release(organizationId: string, messageId: string): Promise<void> {
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await transaction
				.update(voicemailMessage)
				.set({ emailSentAt: null })
				.where(eq(voicemailMessage.id, messageId));
		});
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
					extensionId: voicemailBox.extensionId,
				})
				.from(voicemailBox)
				.where(eq(voicemailBox.id, mailboxId))
				.limit(1);
			const box = boxes[0];
			if (box === undefined) {
				return undefined;
			}

			/**
			 * The user behind the mailbox: `voicemail_box.extension_id → extension_user`, primary
			 * link only — see the class header for why a delegate's preferences must not style this
			 * mail. Ordered by creation then id so two primary links (the unique index permits them)
			 * resolve the same way on every delivery rather than flapping with the planner. The
			 * guard is a string check rather than `!== null` so an absent column (however a driver
			 * or a fake spells absence) reads as "no extension" and never as a joinable id.
			 */
			let boundUserId: string | undefined;
			if (typeof box.extensionId === "string") {
				const links = await transaction
					.select({ userId: extensionUser.userId })
					.from(extensionUser)
					.where(
						and(eq(extensionUser.extensionId, box.extensionId), eq(extensionUser.role, "primary")),
					)
					.orderBy(extensionUser.createdAt, extensionUser.id)
					.limit(1);
				boundUserId = links[0]?.userId;
			}

			const messages = await transaction
				.select({
					callerIdName: voicemailMessage.callerIdName,
					callerIdNumber: voicemailMessage.callerIdNumber,
					receivedAt: voicemailMessage.receivedAt,
					durationMs: voicemailMessage.durationMs,
					transcription: voicemailMessage.transcription,
					transcriptionStatus: voicemailMessage.transcriptionStatus,
				})
				.from(voicemailMessage)
				.where(eq(voicemailMessage.id, messageId))
				.limit(1);
			const message = messages[0];
			if (message === undefined) {
				return undefined;
			}

			// `extensionId` was read only to find the user behind the mailbox; it is not part of the
			// context the notification is rendered from, and dropping it here keeps that seam narrow.
			// Spelled with a helper rather than a destructure with a discarded binding, which the lint
			// rule against unused variables is right to call a declaration nobody reads.
			return { ...withoutExtensionId(box), ...message, userId: boundUserId };
		});
	}
}

interface VoicemailEmailContext {
	readonly mailboxNumber: string;
	readonly label: string | null;
	readonly emailAddress: string | null;
	readonly emailMode: VoicemailEmailMode;
	/** The primary user behind the mailbox's extension, when the chain exists. */
	readonly userId: string | undefined;
	readonly callerIdName: string | null;
	readonly callerIdNumber: string | null;
	readonly receivedAt: Date;
	readonly durationMs: number;
	readonly transcription: string | null;
	readonly transcriptionStatus: VoicemailTranscriptionStatus;
}

/**
 * What the notification says where the transcript goes, decided from the ROW.
 *
 * From the row rather than from an argument, because there are now three callers — the consumer at
 * filing time, the transcription worker at settlement, and the back-fill — and a flag each of them
 * passed would be three chances to disagree about a fact the database already holds. The status is
 * what carries the difference:
 *
 * - `done` — the transcript, including an EMPTY one. A three-second message of hold music
 *   transcribes to nothing, `mail-templates.ts` renders an empty string as no section, and that is
 *   the right outcome without this function needing to know it.
 * - `pending` — the budget expired before the provider answered. The marker: the notification was
 *   held back for a transcript and is going out without one.
 * - `failed` — the provider refused it. The marker, for the same reason.
 * - `disabled` — this mailbox does not do transcription. NOTHING, which is the pre-existing
 *   behaviour and the reason a box that never asked for a transcript cannot regress into being told
 *   one is unavailable.
 *
 * A `done` row whose transcript is null is treated as the marker too. It should not exist — `done`
 * is written together with the text — and if it does, the honest thing to say is that the transcript
 * is not there.
 */
function transcriptionFor(
	included: boolean,
	transcription: string | null,
	status: VoicemailTranscriptionStatus,
): string | undefined {
	if (!included || status === "disabled") {
		return undefined;
	}
	if (transcription !== null) {
		return transcription;
	}
	return status === "pending" || status === "failed" || status === "done"
		? TRANSCRIPTION_UNAVAILABLE
		: undefined;
}

/** The mailbox row minus the join key. See its one call site for why the key is dropped. */
function withoutExtensionId<T extends { readonly extensionId?: unknown }>(
	box: T,
): Omit<T, "extensionId"> {
	const rest: Record<string, unknown> = { ...box };
	delete rest.extensionId;
	return rest as Omit<T, "extensionId">;
}
