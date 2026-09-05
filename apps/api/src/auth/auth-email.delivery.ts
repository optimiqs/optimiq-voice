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
 *
 * ## Why these four do NOT cascade the per-tenant mail template, and stay the platform default
 *
 * The voicemail/fax/emergency consumers brand their mail through `MailTemplateService.resolveComposition`,
 * which is keyed on an ORGANIZATION ID. These four have none to give, for two compounding reasons:
 *
 * 1. **No org id at send time.** `AuthEmailDelivery` (packages/auth) carries a user and a URL, not
 *    an organization. Verification, reset and the two-factor OTP happen during sign-up / sign-in /
 *    the 2FA step, before any active-org claim exists — there is genuinely no tenant to key on.
 *    The invitation alone HAS an organization (better-auth's `sendInvitationEmail` hook holds
 *    `data.organization`), but the port forwards only its NAME, not its id.
 * 2. **The hooks are baked into the platform before the resolver exists.** This delivery is
 *    constructed inside the `AUTH_PLATFORM` factory (`auth.module.ts`), and `MailTemplateService`
 *    depends on `AUTH_PLATFORM` — so the service that would resolve branding cannot be injected here
 *    without a construction cycle.
 *
 * So `appName` is the platform default (`DEFAULT_MAIL_APP_NAME`, which equals the branding cascade's
 * own code default `DEFAULT_BRANDING.productName`). That is the honest platform-level answer, not a
 * hardcode standing in for a tenant read. Cascading the invitation specifically would mean widening
 * the `AuthEmailDelivery` port to carry `organizationId` AND resolving branding lazily (via the
 * runtime registry, to dodge the cycle) — a packages/auth change recorded as follow-up rather than
 * faked with an invented org context here.
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
