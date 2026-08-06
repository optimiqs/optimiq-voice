import {
	DEFAULT_MAIL_APP_NAME,
	invitationMail,
	type Mailer,
	passwordResetMail,
	twoFactorOtpMail,
	verificationMail,
} from "../mail";
import type { AuthEmailDelivery } from "@optimiq-voice/auth";

/**
 * The auth slice's four outbound messages, bound to the {@link Mailer}.
 *
 * `@optimiq-voice/auth` takes delivery as an injected port and never binds SMTP, a provider SDK or
 * a template — which is what keeps it importable from tests and from the migration tooling with no
 * mail configuration at all. This is the binding for `apps/api`.
 *
 * ## It replaced a log-only stub, and that is why `requireEmailVerification` can move
 *
 * Until this landed, every one of these was a `logger.warn` with the one-time link in it, and
 * `resolveAuthSliceConfig()` compensated by only requiring email verification in production —
 * because requiring it anywhere else would have locked a developer out of their own sign-up.
 * `Mailer` now keeps that affordance without the special case: with no SMTP configured it renders
 * and logs the message in full, so the local flow is unchanged, and a production process that would
 * do the same refuses to boot (`assertMailPreflight`).
 *
 * ## Delivery failure is not a flow failure
 *
 * `Mailer.send` never throws — see its header. That is what these `await`s rely on: better-auth
 * calls `sendVerificationEmail` INSIDE the sign-up request, and a relay timeout that propagated
 * would tell a user their account was not created after it was.
 */
export function createMailerEmailDelivery(
	mailer: Mailer,
	options: { readonly appName?: string } = {},
): AuthEmailDelivery {
	const appName = options.appName ?? DEFAULT_MAIL_APP_NAME;

	return {
		sendVerification: async ({ user, url }) => {
			await mailer.sendRendered(user.email, verificationMail({ appName, name: user.name, url }));
		},

		sendReset: async ({ user, url }) => {
			await mailer.sendRendered(user.email, passwordResetMail({ appName, name: user.name, url }));
		},

		sendInvite: async ({ email, organizationName, inviterEmail, role, acceptUrl }) => {
			await mailer.sendRendered(
				email,
				invitationMail({ appName, organizationName, inviterEmail, role, acceptUrl }),
			);
		},

		/**
		 * The second factor's one-time code.
		 *
		 * Optional on the port, and supplied here, which is what makes better-auth's `twoFactor`
		 * plugin register its `otp` sub-adapter at all — without a sender the plugin has no way to
		 * deliver a code and `POST /two-factor/send-otp` would mint one nobody receives. TOTP and
		 * backup codes are unaffected either way; they need no transport.
		 */
		sendTwoFactorOtp: async ({ user, otp }) => {
			await mailer.sendRendered(user.email, twoFactorOtpMail({ appName, name: user.name, otp }));
		},
	};
}
