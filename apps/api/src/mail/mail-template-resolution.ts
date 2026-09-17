import { escapeHtml, type RenderedMail } from "./mail-templates";

/**
 * The email-template resolution layer — the two cascade levels above the fixed code templates.
 *
 * The mail path composes from typed functions in `mail-templates.ts` (the code default). This layer
 * resolves a per-organization (and per-language) OVERRIDE of the subject and an optional body intro,
 * and carries the resolved BRANDING product name so a composer can pass it as the template's
 * `appName` — that is the whole of "branding substitution into existing templates": the templates
 * already take a product name, so rebranding an email is feeding them the resolved one rather than
 * the hardcoded `"Optimiq Voice"`.
 *
 * Kept pure and dependency-free so the resolution is unit-tested without a database or a mailer.
 */

/**
 * The closed set of templates a tenant may override — one key per function in `mail-templates.ts`.
 * A key nothing sends has no row to render, which is why the storage column is plain text and the
 * closed list lives here.
 */
export const MAIL_TEMPLATE_KEYS = [
	"verification",
	"password-reset",
	"invitation",
	"two-factor-otp",
	"voicemail",
	"fax-received",
	"emergency-dialed",
] as const;
export type MailTemplateKey = (typeof MAIL_TEMPLATE_KEYS)[number];

export function isMailTemplateKey(value: string): value is MailTemplateKey {
	return (MAIL_TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** A resolved override: either half may be absent, in which case the code default stands. */
export interface MailTemplateOverride {
	readonly subject?: string | null;
	readonly bodyIntro?: string | null;
}

/**
 * Apply a resolved override to a code-rendered message.
 *
 * `subject` replaces the code subject when set. `bodyIntro` is prepended as the first paragraph of
 * both the text and HTML bodies — an intro, deliberately not a full-body CMS, which is the tight
 * scope W14 asks for: a tenant re-words the opening line, the structured body the template built
 * (links, transcription, dispatch details) is untouched. An empty override returns the input
 * unchanged, so a composer can call this unconditionally.
 */
export function applyMailOverride(
	rendered: RenderedMail,
	override: MailTemplateOverride | null | undefined,
): RenderedMail {
	if (!override) {
		return rendered;
	}
	const subject =
		typeof override.subject === "string" && override.subject.length > 0
			? override.subject
			: rendered.subject;
	const intro = typeof override.bodyIntro === "string" ? override.bodyIntro.trim() : "";
	if (intro.length === 0) {
		return { ...rendered, subject };
	}
	return {
		subject,
		text: `${intro}\n\n${rendered.text}`,
		html: `<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(intro)}</p>\n${rendered.html}`,
	};
}
