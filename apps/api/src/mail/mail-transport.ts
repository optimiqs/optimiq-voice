import { getLogger } from "@optimiq-voice/logging";
import { isMailConfigured } from "./mail-env";
import type { MailEnv } from "./mail-env";

const logger = getLogger("api.mail");

/**
 * The transport seam: one interface, two implementations, one selection rule.
 *
 * ## Why a seam at all
 *
 * `nodemailer` is the only thing in this process that opens a TCP connection to a relay, and it is
 * the one thing a unit test cannot exercise. Naming the boundary means the SELECTION (which
 * transport a given environment gets) and the RENDERING (what the message says) are both testable
 * without a socket, and the untestable part is reduced to "hand this object to nodemailer".
 *
 * ## The logging transport is not a null object
 *
 * It writes the ENTIRE message — recipient, subject, both bodies, every one-time link — at `warn`,
 * prefixed so it cannot be mistaken for a delivery. That is the point: without a relay, a
 * developer completing a sign-up has no other way to reach the verification link, and a transport
 * that quietly discarded the message would make the flow untestable rather than unconfigured.
 *
 * It is also why {@link assertMailPreflight} exists in `mail-env.ts`: this behaviour is correct in
 * development and unacceptable in production, so production refuses to boot into it rather than
 * relying on an operator noticing the log prefix.
 */

export interface MailMessage {
	readonly to: string;
	readonly subject: string;
	readonly text: string;
	readonly html: string;
	readonly replyTo?: string | undefined;
	/** Extra headers, e.g. `X-Optimiq-Voicemail-Message-Id`, for a receiving system to thread on. */
	readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface MailDeliveryResult {
	readonly delivered: boolean;
	readonly transport: MailTransportKind;
	/** The relay's message id, when there was a relay. */
	readonly messageId?: string | undefined;
}

export type MailTransportKind = "smtp" | "log";

export interface MailTransport {
	readonly kind: MailTransportKind;
	send(message: MailMessage): Promise<MailDeliveryResult>;
	close(): Promise<void>;
}

/**
 * Which transport an environment gets.
 *
 * A pure function of the parsed environment so the rule can be asserted directly, and so there is
 * exactly one answer to "why is this deployment logging instead of sending?".
 */
export function selectMailTransport(env: MailEnv): MailTransportKind {
	return isMailConfigured(env) ? "smtp" : "log";
}

export function createMailTransport(env: MailEnv): MailTransport {
	return selectMailTransport(env) === "smtp" ? createSmtpTransport(env) : createLoggingTransport();
}

/**
 * The development fallback.
 *
 * `warn`, not `info`: a process writing password-reset links to its log is an abnormal state, and
 * the level is what makes that visible in an aggregator that filters `info` away.
 */
export function createLoggingTransport(): MailTransport {
	return {
		kind: "log",
		send: async (message) => {
			logger.warn(
				{
					to: message.to,
					subject: message.subject,
					text: message.text,
					html: message.html,
				},
				"MAIL NOT SENT (no SMTP configured) — the message below was rendered and discarded",
			);
			return { delivered: false, transport: "log" };
		},
		close: async () => {
			// Nothing to close: there is no connection.
		},
	};
}

/**
 * The real transport.
 *
 * ## The nodemailer handle is built lazily, once
 *
 * `createTransport` itself opens nothing — it is the pool that does — but importing `nodemailer`
 * pulls in a large module graph, and a process that never sends a message (a verify script booting
 * one HTTP slice, a migration container) should not pay for it. The import and the transporter are
 * therefore memoised behind the first `send`, and a failure to construct is not cached: a
 * misconfiguration surfaces on every attempt rather than once.
 *
 * ## Auth is omitted rather than sent empty
 *
 * A relay that accepts unauthenticated submission from inside a private network — which is what
 * `compose.dev.yaml`'s mailhog is — refuses an `AUTH` command with empty credentials. Passing
 * `auth: { user: "", pass: "" }` is therefore not "no auth", it is a failed handshake, so the key
 * is only present when both halves are.
 */
export function createSmtpTransport(env: MailEnv): MailTransport {
	if (env.host === undefined) {
		throw new Error("createSmtpTransport requires SMTP_HOST; use createMailTransport instead");
	}
	const host = env.host;

	let transporter: Promise<NodemailerTransporter> | undefined;

	const handle = (): Promise<NodemailerTransporter> => {
		transporter ??= import("nodemailer")
			.then((module) =>
				module.createTransport({
					host,
					port: env.port,
					secure: env.secure,
					...(env.user !== undefined && env.pass !== undefined
						? { auth: { user: env.user, pass: env.pass } }
						: {}),
					connectionTimeout: env.timeoutMs,
					greetingTimeout: env.timeoutMs,
					socketTimeout: env.timeoutMs,
				}),
			)
			.catch((error: unknown) => {
				// Not cached: the next send retries the construction rather than replaying the failure.
				transporter = undefined;
				throw error;
			});
		return transporter;
	};

	return {
		kind: "smtp",
		send: async (message) => {
			const client = await handle();
			const sent = await client.sendMail({
				from: env.from,
				to: message.to,
				subject: message.subject,
				text: message.text,
				html: message.html,
				...((message.replyTo ?? env.replyTo) ? { replyTo: message.replyTo ?? env.replyTo } : {}),
				...(message.headers === undefined ? {} : { headers: { ...message.headers } }),
			});
			return { delivered: true, transport: "smtp", messageId: sent?.messageId };
		},
		close: async () => {
			if (transporter === undefined) {
				return;
			}
			const client = await transporter.catch(() => undefined);
			client?.close();
		},
	};
}

/**
 * The part of nodemailer's surface this module touches.
 *
 * `Transporter` from `@types/nodemailer` is generic over its plugin's `SentMessageInfo`, and every
 * one of those generics would have to be threaded through {@link MailTransport} for two methods.
 * Naming the two here keeps the library's types at the boundary where they are used.
 */
type NodemailerTransporter = ReturnType<typeof import("nodemailer").createTransport>;
