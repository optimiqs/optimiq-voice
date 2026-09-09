import { z } from "zod/v4";
import { MAIL_TEMPLATE_KEYS } from "../../mail/mail-template-resolution";

/**
 * Managing per-organization mail-template overrides. `templateKey` is the closed set from
 * `mail-template-resolution.ts`; `language` is a BCP-47 tag; `subject`/`bodyIntro` may be null to
 * clear an override half.
 */

const language = z
	.string()
	.trim()
	.regex(/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/u, "expected a BCP-47 language tag like en or en-GB");

/** Everything but the C0/C1 control characters and the format characters — newlines included. */
const NO_CONTROL_CHARS = /^[^\p{Cc}\p{Cf}]+$/u;

export const upsertMailTemplateDto = z.strictObject({
	templateKey: z.enum(MAIL_TEMPLATE_KEYS),
	language: language.default("en"),
	// No control characters, in either half. `subject` is the only untrusted string in the platform
	// that reaches an SMTP HEADER verbatim (`mail-transport.ts` hands it to nodemailer as-is), and a
	// `\r\n` in a header value is header injection wherever the transport is less careful than
	// nodemailer. The boundary that should reject it is this schema.
	subject: z.string().trim().min(1).max(200).regex(NO_CONTROL_CHARS).nullable().optional(),
	bodyIntro: z.string().trim().min(1).max(2000).regex(NO_CONTROL_CHARS).nullable().optional(),
	enabled: z.boolean().optional(),
});
export type UpsertMailTemplateInput = z.output<typeof upsertMailTemplateDto>;
