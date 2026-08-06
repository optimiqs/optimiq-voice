import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { createMailTransport } from "./mail-transport";
import { MAIL_ENV } from "./mail.tokens";
import type { MailEnv } from "./mail-env";
import type { RenderedMail } from "./mail-templates";
import type {
	MailDeliveryResult,
	MailMessage,
	MailTransport,
	MailTransportKind,
} from "./mail-transport";

const logger = getLogger("api.mail");

/** The default product name every template falls back to when nothing sets one. */
export const DEFAULT_MAIL_APP_NAME = "Optimiq Voice";

/**
 * The one thing in `apps/api` that sends mail.
 *
 * ## Why a service and not a bare function
 *
 * The transport owns a connection pool that has to be closed at shutdown, so it has a lifecycle,
 * and Nest is what manages lifecycles here. Everything else about this class is deliberately thin:
 * the message is RENDERED by `mail-templates.ts`, the transport is CHOSEN by `mail-transport.ts`,
 * and what is left is "hand the rendered message to the chosen transport, and do not let a failure
 * to send become a failure of the thing that asked".
 *
 * ## A send never throws
 *
 * Every caller in this codebase is on a path where the primary work has already succeeded and is
 * durable: better-auth has created the user, the consumer has filed the voicemail row, the
 * organization plugin has written the invitation. Turning "the relay refused the connection" into
 * a 500 on `POST /sign-up` would roll nothing back — it would just tell the user their sign-up
 * failed when it did not. So {@link send} logs and returns `delivered: false`, and the ONE place
 * where an unsent message is a real problem — a production process with no relay at all — is
 * caught at boot by `assertMailPreflight`, not per message.
 */
@Injectable()
export class Mailer implements OnApplicationShutdown {
	private readonly transport: MailTransport;
	private sent = 0;
	private failed = 0;

	constructor(@Inject(MAIL_ENV) private readonly env: MailEnv) {
		this.transport = createMailTransport(env);
		if (this.transport.kind === "log") {
			logger.warn(
				"SMTP is not configured (SMTP_HOST / MAIL_FROM) — every message will be written to " +
					"this log, one-time links included, instead of being sent. This is a development " +
					"fallback; a NODE_ENV=production process refuses to boot into it.",
			);
		} else {
			logger.info(
				{
					host: env.host,
					port: env.port,
					secure: env.secure,
					authenticated: env.user !== undefined,
				},
				"SMTP mail transport ready",
			);
		}
	}

	get kind(): MailTransportKind {
		return this.transport.kind;
	}

	/** The web app's origin, for links inside a message. `undefined` when none is configured. */
	get appUrl(): string | undefined {
		return this.env.appUrl;
	}

	get stats(): {
		readonly sent: number;
		readonly failed: number;
		readonly kind: MailTransportKind;
	} {
		return { sent: this.sent, failed: this.failed, kind: this.transport.kind };
	}

	/** Sends a pre-rendered message. Never throws; see the class header. */
	async send(message: MailMessage): Promise<MailDeliveryResult> {
		try {
			const result = await this.transport.send(message);
			if (result.delivered) {
				this.sent += 1;
			}
			return result;
		} catch (error) {
			this.failed += 1;
			// The SUBJECT and the recipient, never the body: a body carries the one-time link, and an
			// error path is exactly where a log ends up somewhere it was not meant to.
			logger.error(
				{
					to: message.to,
					subject: message.subject,
					error,
				},
				"failed to send a message",
			);
			return { delivered: false, transport: this.transport.kind };
		}
	}

	/** Sends a {@link RenderedMail} to one recipient. */
	async sendRendered(
		to: string,
		rendered: RenderedMail,
		options?: {
			readonly replyTo?: string | undefined;
			readonly headers?: Readonly<Record<string, string>> | undefined;
		},
	): Promise<MailDeliveryResult> {
		return await this.send({
			to,
			subject: rendered.subject,
			text: rendered.text,
			html: rendered.html,
			...(options?.replyTo === undefined ? {} : { replyTo: options.replyTo }),
			...(options?.headers === undefined ? {} : { headers: options.headers }),
		});
	}

	async onApplicationShutdown(): Promise<void> {
		await this.transport.close();
	}
}
