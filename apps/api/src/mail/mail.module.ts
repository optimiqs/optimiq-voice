import { Global, Module } from "@nestjs/common";
import { loadMailEnv } from "./mail-env";
import { MAIL_ENV } from "./mail.tokens";
import { Mailer } from "./mailer.service";
import type { MailEnv } from "./mail-env";

/**
 * The mail area.
 *
 * `@Global()`, which is a deliberate exception to the oikos default of explicit imports. Mail is
 * not a feature that some other feature depends on — it is a leaf capability with no dependencies
 * of its own (no database, no broker, no session), and three unrelated areas need it: the auth
 * slice for verification, reset, invitation and 2FA; the PBX area for voicemail-to-email; and, in
 * time, anything that notifies. Threading an `imports: [MailModule]` line through each of them
 * would buy nothing that a Symbol token does not already give, and the usual argument for explicit
 * imports — that a module's dependencies should be legible from its declaration — is weakest for a
 * capability that cannot fail to be available.
 *
 * It mounts UNCONDITIONALLY, including when SMTP is unconfigured. There is no gate here on
 * purpose: the "unconfigured" case is a real, supported mode (every message is rendered and
 * logged, which is what makes a local sign-up completable), and the case where it is NOT
 * acceptable — production — is refused at boot by `assertMailPreflight` in `main.ts`, before this
 * module is ever built.
 */
@Global()
@Module({
	providers: [{ provide: MAIL_ENV, useFactory: (): MailEnv => loadMailEnv() }, Mailer],
	exports: [MAIL_ENV, Mailer],
})
export class MailModule {}
