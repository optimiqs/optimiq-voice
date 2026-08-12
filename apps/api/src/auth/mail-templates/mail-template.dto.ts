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

export const upsertMailTemplateDto = z.strictObject({
	templateKey: z.enum(MAIL_TEMPLATE_KEYS),
	language: language.default("en"),
	subject: z.string().trim().min(1).max(200).nullable().optional(),
	bodyIntro: z.string().trim().min(1).max(2000).nullable().optional(),
	enabled: z.boolean().optional(),
});
export type UpsertMailTemplateInput = z.output<typeof upsertMailTemplateDto>;
