import { expect } from "chai";
import { upsertMailTemplateDto } from "../../src/auth/mail-templates/mail-template.dto";
import { MAIL_TEMPLATE_KEYS } from "../../src/mail/mail-template-resolution";

/**
 * The DTO is the boundary that has to reject a header-injection attempt.
 *
 * `subject` is the only untrusted string in the platform that reaches an SMTP header verbatim
 * (`mail-transport.ts` hands it to nodemailer as-is), and `settings.write` is a deliberately low
 * bar to hold — so a control character has to fail validation here rather than rely on every
 * transport in the chain folding it as carefully as nodemailer does.
 */
describe("upsertMailTemplateDto", () => {
	const templateKey = MAIL_TEMPLATE_KEYS[0];

	it("rejects a subject carrying a newline", () => {
		const parsed = upsertMailTemplateDto.safeParse({
			templateKey,
			subject: `Hello${String.fromCodePoint(13)}${String.fromCodePoint(10)}Bcc: attacker@example.test`,
		});
		expect(parsed.success).to.equal(false);
	});

	it("rejects a bodyIntro carrying a control character", () => {
		const parsed = upsertMailTemplateDto.safeParse({
			templateKey,
			bodyIntro: `Hi${String.fromCodePoint(7)}there`,
		});
		expect(parsed.success).to.equal(false);
	});

	it("still accepts an ordinary subject with punctuation and accents", () => {
		const parsed = upsertMailTemplateDto.safeParse({
			templateKey,
			subject: "You have a new voicemail — from Renée (0:12)",
		});
		expect(parsed.success).to.equal(true);
	});
});
