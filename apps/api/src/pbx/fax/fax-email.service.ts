import { Inject, Injectable } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { MailTemplateService } from "../../auth/mail-templates/mail-template.service";
import { DEFAULT_MAIL_APP_NAME, faxReceivedMail, Mailer } from "../../mail";
import { applyMailOverride } from "../../mail/mail-template-resolution";
import { faxMediaPath, mintFaxMediaToken } from "./fax-media-token";
import { FAX_ENV } from "./fax.tokens";
import type { MailComposition } from "../../auth/mail-templates/mail-template.service";
import type { FaxEnv } from "./fax-env";

const logger = getLogger("api.pbx");

export interface FaxEmailInput {
	readonly organizationId: string;
	readonly messageId: string;
	readonly toAddress: string;
	readonly fromNumber: string;
	readonly toNumber: string;
	readonly pages: number | null;
	readonly receivedAt: Date;
	/** Whether the document has been stored yet — a link is only offered when it has. */
	readonly hasDocument: boolean;
}

/**
 * Fax-to-email.
 *
 * The voicemail-to-email pattern, narrowed: a received fax is filed exactly once (the inbound insert
 * is idempotent on the carrier fax id), and this runs on that single fresh insert, so there is no
 * race and no `email_sent_at` claim column to guard — once-only comes from the insert being once. It
 * never throws: the fax is durable before this runs, and a relay that is down must not turn the
 * filing into a failure. A signed link, not an attachment, for the reason `faxReceivedMail` records.
 */
@Injectable()
export class FaxEmailService {
	private sent = 0;
	private skipped = 0;
	private failed = 0;

	constructor(
		@Inject(FAX_ENV) private readonly env: FaxEnv,
		@Inject(Mailer) private readonly mailer: Mailer,
		@Inject(MailTemplateService) private readonly templates: MailTemplateService,
	) {}

	get stats(): { readonly sent: number; readonly skipped: number; readonly failed: number } {
		return { sent: this.sent, skipped: this.skipped, failed: this.failed };
	}

	/** Notifies the fax server's configured address, best-effort. Returns whether a mail was sent. */
	async notify(input: FaxEmailInput): Promise<boolean> {
		const to = input.toAddress.trim();
		if (to.length === 0) {
			this.skipped += 1;
			return false;
		}
		try {
			const documentUrl = input.hasDocument
				? this.mintDocumentUrl(input.organizationId, input.messageId)
				: undefined;
			const inboxUrl = this.mailer.appUrl === undefined ? undefined : `${this.mailer.appUrl}/faxes`;
			// The mail-template cascade, the same wire the voicemail consumer uses: the org's (or its
			// reseller's) branding product name feeds the code template as its `appName`, and the
			// resolved subject/intro override is applied to the result. Keyed by `fax-received` and the
			// organization id this notification already holds.
			const composition = await this.compose(input.organizationId);
			const rendered = applyMailOverride(
				faxReceivedMail({
					appName: composition.productName,
					toNumber: input.toNumber,
					fromNumber: input.fromNumber,
					pages: input.pages ?? undefined,
					receivedAt: input.receivedAt,
					documentUrl,
					inboxUrl,
				}),
				composition.override,
			);
			const result = await this.mailer.sendRendered(to, rendered, {
				// A stable per-message header, so a redelivery-driven duplicate can be threaded or
				// suppressed rather than shown twice.
				headers: { "X-Optimiq-Fax-Message-Id": input.messageId },
			});
			if (!result.delivered) {
				this.failed += 1;
				return false;
			}
			this.sent += 1;
			return true;
		} catch (error) {
			this.failed += 1;
			logger.error(
				{ organizationId: input.organizationId, faxId: input.messageId, error },
				"failed to send a fax-to-email notification",
			);
			return false;
		}
	}

	/**
	 * The branding product name and resolved template override for this organization's fax mail.
	 *
	 * Best-effort, exactly like the voicemail consumer's `compose`: a cascade read that fails must not
	 * suppress a notification whose document is already durable, so a failure falls back to the code
	 * default (`DEFAULT_MAIL_APP_NAME`, no override) — the message this consumer sent before the
	 * cascade was wired. Language is `en`: fax mail carries no per-recipient locale, and the override
	 * table keys on `(org, template, language)` with `en` as its own default.
	 */
	private async compose(organizationId: string): Promise<MailComposition> {
		try {
			return await this.templates.resolveComposition(organizationId, "fax-received", "en");
		} catch (error) {
			logger.warn(
				{ organizationId, err: error },
				"could not resolve the fax mail template; sending with the default branding",
			);
			return { productName: DEFAULT_MAIL_APP_NAME, override: null };
		}
	}

	/** A signed, expiring absolute URL to the document, or `undefined` when unconfigured. */
	private mintDocumentUrl(organizationId: string, messageId: string): string | undefined {
		const secret = this.env.FAX_MEDIA_URL_SECRET;
		const origin = this.mailer.appUrl;
		if (secret === undefined || origin === undefined) {
			return undefined;
		}
		const expiresAt = Math.floor(Date.now() / 1000) + this.env.FAX_MEDIA_URL_TTL_SECONDS;
		return `${origin}${faxMediaPath(mintFaxMediaToken(messageId, organizationId, expiresAt, secret))}`;
	}
}
