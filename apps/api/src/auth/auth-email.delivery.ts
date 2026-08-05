import { Logger } from "@nestjs/common";
import type { AuthEmailDelivery } from "@optimiq-voice/auth";

/**
 * TEMPORARY — console/log delivery stubs.
 *
 * `@optimiq-voice/auth` deliberately takes delivery as an injected port. Until the SMTP helpers
 * in `apps/api/src/core/` are ported to the new slice (identity-removal Step 1.2) every message
 * is logged instead of sent, including the one-time link, so a developer can complete a flow
 * locally. This MUST be replaced before production: `resolveAuthSliceConfig()` only requires
 * email verification in production, so these stubs are never on the critical path today.
 */
export function createLoggingEmailDelivery(): AuthEmailDelivery {
	const logger = new Logger("AuthEmailDelivery");

	return {
		sendVerification: async ({ user, url }) => {
			logger.warn(
				`STUB email delivery — verification link for ${user.email} (user ${user.id}): ${url}`,
			);
		},
		sendReset: async ({ user, url }) => {
			logger.warn(
				`STUB email delivery — password reset link for ${user.email} (user ${user.id}): ${url}`,
			);
		},
		sendInvite: async ({ email, organizationName, inviterEmail, role, acceptUrl }) => {
			logger.warn(
				`STUB email delivery — invitation to ${email} for "${organizationName}" ` +
					`from ${inviterEmail} as ${role ?? "member"}: ${acceptUrl}`,
			);
		},
	};
}
