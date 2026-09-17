import { expect } from "chai";
import {
	applyMailOverride,
	isMailTemplateKey,
	MAIL_TEMPLATE_KEYS,
} from "../../src/mail/mail-template-resolution";
import type { RenderedMail } from "../../src/mail";

/**
 * The email-template resolution layer, without a database or a mailer.
 *
 * `applyMailOverride` is what turns a code-rendered message into the tenant's version: a subject
 * override and an intro paragraph, and nothing more — the structured body the template built stays
 * intact, which is the tight scope W14 asks for.
 */

const CODE: RenderedMail = {
	subject: "New voicemail from Alex (0:12)",
	text: "You have a new voicemail.\n\nListen: https://app.example/voicemail",
	html: '<div style="color:#111"><h1>Optimiq Voice</h1><p>You have a new voicemail.</p></div>',
};

describe("mail template keys", () => {
	it("recognises every declared key and rejects an unknown one", () => {
		for (const key of MAIL_TEMPLATE_KEYS) {
			expect(isMailTemplateKey(key)).to.equal(true);
		}
		expect(isMailTemplateKey("not-a-template")).to.equal(false);
	});
});

describe("applyMailOverride", () => {
	it("returns the code message unchanged when there is no override", () => {
		expect(applyMailOverride(CODE, null)).to.deep.equal(CODE);
		expect(applyMailOverride(CODE, {})).to.deep.equal(CODE);
	});

	it("replaces the subject when the override sets one", () => {
		const result = applyMailOverride(CODE, { subject: "Nueva llamada perdida" });
		expect(result.subject).to.equal("Nueva llamada perdida");
		// Body is untouched:
		expect(result.text).to.equal(CODE.text);
	});

	it("keeps the code subject when the override subject is empty or null", () => {
		expect(applyMailOverride(CODE, { subject: "" }).subject).to.equal(CODE.subject);
		expect(applyMailOverride(CODE, { subject: null }).subject).to.equal(CODE.subject);
	});

	it("prepends the body intro to both the text and HTML bodies, escaping HTML", () => {
		const result = applyMailOverride(CODE, { bodyIntro: "Hola <b>equipo</b>" });
		expect(result.text.startsWith("Hola <b>equipo</b>\n\n")).to.equal(true);
		expect(result.text).to.contain("You have a new voicemail.");
		expect(result.html).to.contain("Hola &lt;b&gt;equipo&lt;/b&gt;");
		// The structured body still follows the intro:
		expect(result.html).to.contain("<h1>Optimiq Voice</h1>");
	});

	it("applies subject and intro together", () => {
		const result = applyMailOverride(CODE, { subject: "S", bodyIntro: "I" });
		expect(result.subject).to.equal("S");
		expect(result.text.startsWith("I\n\n")).to.equal(true);
	});
});
