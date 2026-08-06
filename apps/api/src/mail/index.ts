/**
 * The mail area's public surface.
 *
 * Everything another area needs to send a message: the {@link Mailer} it injects, the templates it
 * renders, and the environment contract `main.ts` preflights.
 */

export {
	assertMailPreflight,
	isMailConfigured,
	loadMailEnv,
	MAIL_LEGACY_ENV_ALIASES,
	MailConfigurationFailure,
	type MailEnv,
	mailEnvSchema,
	withLegacyFallbacks,
} from "./mail-env";
export {
	type EmergencyDialedMailInput,
	emergencyDialedMail,
	escapeHtml,
	formatCaller,
	formatDispatchableLocation,
	formatDuration,
	type InvitationMailInput,
	invitationMail,
	type PasswordResetMailInput,
	passwordResetMail,
	type RenderedMail,
	type TwoFactorOtpMailInput,
	twoFactorOtpMail,
	type VerificationMailInput,
	verificationMail,
	type VoicemailMailInput,
	voicemailMail,
} from "./mail-templates";
export {
	createLoggingTransport,
	createMailTransport,
	createSmtpTransport,
	type MailDeliveryResult,
	type MailMessage,
	type MailTransport,
	type MailTransportKind,
	selectMailTransport,
} from "./mail-transport";
export { MailModule } from "./mail.module";
export { MAIL_ENV } from "./mail.tokens";
export { DEFAULT_MAIL_APP_NAME, Mailer } from "./mailer.service";
