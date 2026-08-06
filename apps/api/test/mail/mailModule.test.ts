import { expect } from "chai";
import {
	assertMailPreflight,
	escapeHtml,
	formatCaller,
	formatDuration,
	invitationMail,
	isMailConfigured,
	loadMailEnv,
	MAIL_LEGACY_ENV_ALIASES,
	MailConfigurationFailure,
	passwordResetMail,
	selectMailTransport,
	twoFactorOtpMail,
	verificationMail,
	voicemailMail,
	withLegacyFallbacks,
} from "../../src/mail";
import { createLoggingTransport } from "../../src/mail/mail-transport";

/**
 * The mail area's three decisions, tested without a socket.
 *
 * Which transport an environment gets, what a message says, and whether a production process is
 * allowed to boot without a relay. The fourth thing the module does — hand a rendered message to
 * nodemailer — is the one part that needs a real SMTP server, and it is covered by
 * `compose.dev.yaml`'s mailhog rather than here.
 */

const CONFIGURED = {
	SMTP_HOST: "smtp.example.test",
	SMTP_PORT: "587",
	SMTP_USER: "postmaster@example.test",
	SMTP_PASS: "secret",
	MAIL_FROM: "Optimiq Voice <no-reply@example.test>",
} satisfies NodeJS.ProcessEnv;

describe("mail environment", () => {
	it("selects the logging transport when nothing is configured", () => {
		const env = loadMailEnv({});
		expect(isMailConfigured(env)).to.equal(false);
		expect(selectMailTransport(env)).to.equal("log");
	});

	it("selects SMTP once a host and a from address are present", () => {
		const env = loadMailEnv({ ...CONFIGURED });
		expect(isMailConfigured(env)).to.equal(true);
		expect(selectMailTransport(env)).to.equal("smtp");
		expect(env.host).to.equal("smtp.example.test");
		expect(env.user).to.equal("postmaster@example.test");
	});

	it("still logs when a host is set but no from address is", () => {
		// A relay with no envelope sender is not a configuration, it is half of one: nodemailer
		// would submit a message with no `From` and the relay would refuse it.
		const env = loadMailEnv({ SMTP_HOST: "smtp.example.test" });
		expect(selectMailTransport(env)).to.equal("log");
	});

	it("derives implicit TLS from port 465 and STARTTLS from anything else", () => {
		expect(loadMailEnv({ ...CONFIGURED, SMTP_PORT: "465" }).secure).to.equal(true);
		expect(loadMailEnv({ ...CONFIGURED, SMTP_PORT: "587" }).secure).to.equal(false);
		// An explicit setting always wins over the port's implication.
		expect(loadMailEnv({ ...CONFIGURED, SMTP_PORT: "465", SMTP_SECURE: "false" }).secure).to.equal(
			false,
		);
	});

	it("falls back to every legacy API_SMTP_* name", () => {
		const env = loadMailEnv({
			API_SMTP_HOST: "legacy.example.test",
			API_SMTP_PORT: "2525",
			API_SMTP_AUTH_USER: "legacy-user",
			API_SMTP_AUTH_PASS: "legacy-pass",
			API_SMTP_SENDER: "Legacy <legacy@example.test>",
			API_APP_URL: "https://app.example.test/",
		});
		expect(env.host).to.equal("legacy.example.test");
		expect(env.port).to.equal(2525);
		expect(env.user).to.equal("legacy-user");
		expect(env.pass).to.equal("legacy-pass");
		expect(env.from).to.equal("Legacy <legacy@example.test>");
		// Trailing slashes are stripped so a template can concatenate a path without doubling one.
		expect(env.appUrl).to.equal("https://app.example.test");
	});

	it("prefers the canonical name when both are set", () => {
		const env = loadMailEnv({ SMTP_HOST: "new.example.test", API_SMTP_HOST: "old.example.test" });
		expect(env.host).to.equal("new.example.test");
	});

	it("treats an empty string as unset, because compose cannot express absence", () => {
		const env = loadMailEnv({ SMTP_HOST: "", API_SMTP_HOST: "  " });
		expect(env.host).to.equal(undefined);
	});

	it("pairs every canonical name with exactly one legacy name", () => {
		const overlay = withLegacyFallbacks({ API_SMTP_HOST: "x" });
		expect(overlay.SMTP_HOST).to.equal("x");
		expect(Object.keys(MAIL_LEGACY_ENV_ALIASES)).to.include.members([
			"SMTP_HOST",
			"SMTP_PORT",
			"SMTP_SECURE",
			"SMTP_USER",
			"SMTP_PASS",
			"MAIL_FROM",
		]);
	});

	it("rejects a malformed port at boot rather than at first send", () => {
		expect(() => loadMailEnv({ ...CONFIGURED, SMTP_PORT: "70000" })).to.throw(
			/Invalid mail environment/u,
		);
	});
});

describe("mail preflight", () => {
	it("refuses to boot a production process with no relay", () => {
		let thrown: unknown;
		try {
			assertMailPreflight(loadMailEnv({}), "production");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(MailConfigurationFailure);
		expect((thrown as MailConfigurationFailure).missing).to.deep.equal(["SMTP_HOST", "MAIL_FROM"]);
	});

	it("names only what is actually missing", () => {
		let thrown: MailConfigurationFailure | undefined;
		try {
			assertMailPreflight(loadMailEnv({ SMTP_HOST: "smtp.example.test" }), "production");
		} catch (error) {
			thrown = error as MailConfigurationFailure;
		}
		expect(thrown?.missing).to.deep.equal(["MAIL_FROM"]);
	});

	it("permits the logging fallback outside production", () => {
		expect(() => assertMailPreflight(loadMailEnv({}), "development")).to.not.throw();
		expect(() => assertMailPreflight(loadMailEnv({}), undefined)).to.not.throw();
	});

	it("permits a configured production process", () => {
		expect(() => assertMailPreflight(loadMailEnv({ ...CONFIGURED }), "production")).to.not.throw();
	});
});

describe("logging transport", () => {
	it("reports that nothing was delivered", async () => {
		const result = await createLoggingTransport().send({
			to: "someone@example.test",
			subject: "s",
			text: "t",
			html: "<p>t</p>",
		});
		// `delivered: false` is the honest answer and it is what `Mailer` counts on: a development
		// send must not increment the "sent" statistic.
		expect(result).to.deep.equal({ delivered: false, transport: "log" });
	});
});

describe("mail templates", () => {
	it("escapes every character that could turn text into markup", () => {
		expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).to.equal(
			"&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;",
		);
	});

	it("puts the verification link in both parts", () => {
		const mail = verificationMail({
			appName: "Optimiq Voice",
			name: "Alice",
			url: "https://app.test/verify?token=abc",
		});
		expect(mail.subject).to.equal("Confirm your Optimiq Voice email address");
		expect(mail.text).to.contain("https://app.test/verify?token=abc");
		expect(mail.html).to.contain("https://app.test/verify?token=abc");
		expect(mail.text).to.contain("Hello Alice,");
	});

	it("greets without a name when there is none", () => {
		expect(passwordResetMail({ appName: "X", url: "https://app.test/r" }).text).to.contain(
			"Hello,",
		);
	});

	it("names the inviter, the organization and the role", () => {
		const mail = invitationMail({
			appName: "Optimiq Voice",
			organizationName: "Acme <Ltd>",
			inviterEmail: "boss@acme.test",
			role: "admin",
			acceptUrl: "https://app.test/accept-invitation/inv-1",
		});
		expect(mail.subject).to.contain("boss@acme.test");
		expect(mail.subject).to.contain("Acme <Ltd>");
		expect(mail.text).to.contain("as admin");
		// The raw name reaches the text part; the HTML part must not carry unescaped angle brackets.
		expect(mail.html).to.contain("Acme &lt;Ltd&gt;");
		expect(mail.html).to.not.contain("Acme <Ltd>");
	});

	it("defaults an invitation with no role to member", () => {
		const mail = invitationMail({
			appName: "X",
			organizationName: "Acme",
			inviterEmail: "boss@acme.test",
			role: undefined,
			acceptUrl: "https://app.test/a",
		});
		expect(mail.text).to.contain("as member");
	});

	it("renders the one-time code in both parts", () => {
		const mail = twoFactorOtpMail({ appName: "Optimiq Voice", otp: "123456" });
		expect(mail.subject).to.equal("Your Optimiq Voice sign-in code");
		expect(mail.text).to.contain("123456");
		expect(mail.html).to.contain("123456");
	});

	describe("voicemail", () => {
		const base = {
			appName: "Optimiq Voice",
			mailboxNumber: "1001",
			receivedAt: new Date("2026-08-06T09:41:12.000Z"),
			durationMs: 83_000,
		};

		it("formats a duration as mm:ss", () => {
			expect(formatDuration(0)).to.equal("0:00");
			expect(formatDuration(9_000)).to.equal("0:09");
			expect(formatDuration(83_000)).to.equal("1:23");
			expect(formatDuration(3_600_000)).to.equal("60:00");
		});

		it("names a caller from whichever half it has", () => {
			expect(formatCaller("+12125550100", "Jane")).to.equal("+12125550100 (Jane)");
			expect(formatCaller("+12125550100", undefined)).to.equal("+12125550100");
			expect(formatCaller(undefined, "Jane")).to.equal("Jane");
			expect(formatCaller(undefined, undefined)).to.equal("an unknown caller");
			expect(formatCaller("  ", "")).to.equal("an unknown caller");
		});

		it("carries the caller, the time and the duration", () => {
			const mail = voicemailMail({ ...base, callerIdNumber: "+12125550100" });
			expect(mail.subject).to.equal("New voicemail from +12125550100 (1:23)");
			expect(mail.text).to.contain("+12125550100");
			expect(mail.text).to.contain("2026-08-06 09:41:12 UTC");
			expect(mail.text).to.contain("1:23");
		});

		it("includes the playback link only when one was minted", () => {
			const withLink = voicemailMail({ ...base, playUrl: "https://app.test/api/v1/x?token=t" });
			expect(withLink.text).to.contain("https://app.test/api/v1/x?token=t");
			expect(voicemailMail({ ...base }).text).to.not.contain("Listen");
		});

		it("includes the transcription only when there is one", () => {
			expect(voicemailMail({ ...base, transcription: "call me back" }).text).to.contain(
				"call me back",
			);
			expect(voicemailMail({ ...base, transcription: "   " }).text).to.not.contain("Transcription");
		});

		it("prefers the mailbox label over the bare number", () => {
			expect(voicemailMail({ ...base, mailboxLabel: "Support" }).text).to.contain("Support (1001)");
			expect(voicemailMail({ ...base }).text).to.contain("mailbox 1001");
		});
	});
});
