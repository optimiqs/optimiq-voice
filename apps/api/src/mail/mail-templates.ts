/**
 * The message bodies, as plain functions.
 *
 * ## No template engine, deliberately
 *
 * There are five messages, none of them is authored by a user, and none of them is themed per
 * tenant. A template engine would add a runtime dependency, a directory of files that has to be
 * copied into `dist` by a build step (this repository already has `copy:hbstemplates` for exactly
 * that reason and it is a step nobody remembers), and a class of bug — a rename that typechecks —
 * that plain functions do not have. So a template here is a typed function that returns a
 * {@link RenderedMail}, and adding a field to one is a compile error at every call site.
 *
 * ## Both parts, always
 *
 * Every template returns `text` AND `html`. The plain part is not a courtesy: a `text/html`-only
 * message scores badly with every spam filter that looks, and the one-time links in these messages
 * are precisely the mail a deployment cannot afford to have filed as junk. The HTML is a handful
 * of inline-styled block elements — no external stylesheet, no image, no web font — because mail
 * clients strip all three and a message that depends on them renders as unstyled text anyway.
 *
 * ## Every interpolated value is escaped
 *
 * `organizationName`, `callerIdName` and a user's own `name` all reach these functions from the
 * database, and two of the three ultimately come from a caller. {@link escapeHtml} is applied to
 * every one of them on the HTML side; the text side needs no escaping and gets none.
 */

export interface RenderedMail {
	readonly subject: string;
	readonly text: string;
	readonly html: string;
}

/** The five characters that can turn interpolated text into markup. */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;")
		.replace(/'/gu, "&#39;");
}

/**
 * The shared HTML shell.
 *
 * A table-free, single-column block with inline styles. `paragraphs` are already-escaped HTML
 * fragments — the callers below escape their own interpolations, which keeps the escaping decision
 * next to the value being escaped rather than in a wrapper that cannot see where a string came
 * from.
 */
function shell(heading: string, paragraphs: readonly string[]): string {
	const body = paragraphs
		.map((paragraph) => `<p style="margin:0 0 16px;line-height:1.5">${paragraph}</p>`)
		.join("\n");
	return [
		`<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;color:#111;max-width:520px">`,
		`<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(heading)}</h1>`,
		body,
		`</div>`,
	].join("\n");
}

/** A link rendered as a button-ish block, with the raw URL repeated underneath. */
function actionLink(label: string, url: string): string {
	const safe = escapeHtml(url);
	return (
		`<a href="${safe}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;` +
		`text-decoration:none;border-radius:6px">${escapeHtml(label)}</a>`
	);
}

function greeting(name: string | undefined): string {
	return name === undefined || name.trim().length === 0 ? "Hello," : `Hello ${name.trim()},`;
}

// ---------------------------------------------------------------------------------------------
// better-auth flows
// ---------------------------------------------------------------------------------------------

export interface VerificationMailInput {
	readonly appName: string;
	readonly name?: string | undefined;
	readonly url: string;
}

export function verificationMail(input: VerificationMailInput): RenderedMail {
	return {
		subject: `Confirm your ${input.appName} email address`,
		text: [
			greeting(input.name),
			"",
			`Confirm this address to finish setting up your ${input.appName} account:`,
			input.url,
			"",
			"If you did not create an account, you can ignore this message.",
		].join("\n"),
		html: shell(`Confirm your email address`, [
			escapeHtml(greeting(input.name)),
			escapeHtml(`Confirm this address to finish setting up your ${input.appName} account.`),
			actionLink("Confirm email address", input.url),
			`<span style="color:#666;font-size:13px">${escapeHtml(input.url)}</span>`,
			`<span style="color:#666;font-size:13px">If you did not create an account, you can ignore this message.</span>`,
		]),
	};
}

export interface PasswordResetMailInput {
	readonly appName: string;
	readonly name?: string | undefined;
	readonly url: string;
}

export function passwordResetMail(input: PasswordResetMailInput): RenderedMail {
	return {
		subject: `Reset your ${input.appName} password`,
		text: [
			greeting(input.name),
			"",
			"Use this link to choose a new password:",
			input.url,
			"",
			"The link expires shortly. If you did not ask for it, nothing has changed and you can " +
				"ignore this message.",
		].join("\n"),
		html: shell("Reset your password", [
			escapeHtml(greeting(input.name)),
			escapeHtml("Use the link below to choose a new password."),
			actionLink("Choose a new password", input.url),
			`<span style="color:#666;font-size:13px">${escapeHtml(input.url)}</span>`,
			`<span style="color:#666;font-size:13px">${escapeHtml(
				"The link expires shortly. If you did not ask for it, nothing has changed.",
			)}</span>`,
		]),
	};
}

export interface InvitationMailInput {
	readonly appName: string;
	readonly organizationName: string;
	readonly inviterEmail: string;
	readonly role: string | undefined;
	readonly acceptUrl: string;
}

export function invitationMail(input: InvitationMailInput): RenderedMail {
	const role = input.role ?? "member";
	return {
		subject: `${input.inviterEmail} invited you to ${input.organizationName} on ${input.appName}`,
		text: [
			"Hello,",
			"",
			`${input.inviterEmail} has invited you to join ${input.organizationName} on ` +
				`${input.appName} as ${role}.`,
			"",
			"Accept the invitation:",
			input.acceptUrl,
			"",
			"If you were not expecting this, you can ignore this message.",
		].join("\n"),
		html: shell(`Join ${input.organizationName}`, [
			escapeHtml(
				`${input.inviterEmail} has invited you to join ${input.organizationName} on ` +
					`${input.appName} as ${role}.`,
			),
			actionLink("Accept invitation", input.acceptUrl),
			`<span style="color:#666;font-size:13px">${escapeHtml(input.acceptUrl)}</span>`,
			`<span style="color:#666;font-size:13px">If you were not expecting this, you can ignore this message.</span>`,
		]),
	};
}

export interface TwoFactorOtpMailInput {
	readonly appName: string;
	readonly name?: string | undefined;
	readonly otp: string;
}

export function twoFactorOtpMail(input: TwoFactorOtpMailInput): RenderedMail {
	return {
		subject: `Your ${input.appName} sign-in code`,
		text: [
			greeting(input.name),
			"",
			`Your sign-in code is ${input.otp}.`,
			"",
			"It expires in a few minutes and can be used once. Nobody from support will ever ask " +
				"you for it.",
		].join("\n"),
		html: shell("Your sign-in code", [
			escapeHtml(greeting(input.name)),
			`<span style="font-size:28px;letter-spacing:6px;font-weight:600">${escapeHtml(input.otp)}</span>`,
			`<span style="color:#666;font-size:13px">${escapeHtml(
				"It expires in a few minutes and can be used once. Nobody from support will ever ask you for it.",
			)}</span>`,
		]),
	};
}

// ---------------------------------------------------------------------------------------------
// Voicemail
// ---------------------------------------------------------------------------------------------

export interface VoicemailMailInput {
	readonly appName: string;
	/** The organization's notification display name, when it set one. */
	readonly fromName?: string | undefined;
	readonly mailboxNumber: string;
	readonly mailboxLabel?: string | undefined;
	readonly callerIdName?: string | undefined;
	readonly callerIdNumber?: string | undefined;
	readonly receivedAt: Date;
	readonly durationMs: number;
	/**
	 * A signed, expiring playback link, when one could be minted.
	 *
	 * Absent when `PBX_VOICEMAIL_URL_SECRET` is not configured — the message still goes out with
	 * the metadata and the inbox link, because "you have a voicemail from +1…" is the part that is
	 * actually time-critical.
	 */
	readonly playUrl?: string | undefined;
	/** The mailbox in the web UI. Absent when no app URL is configured. */
	readonly inboxUrl?: string | undefined;
	readonly transcription?: string | undefined;
}

/** `mm:ss`, because "83000 ms" is not a duration anyone reads. */
export function formatDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** "+12125550100 (Jane Doe)", "+12125550100", or "an unknown caller" — never an empty string. */
export function formatCaller(
	callerIdNumber: string | undefined,
	callerIdName: string | undefined,
): string {
	const number = callerIdNumber?.trim();
	const name = callerIdName?.trim();
	if (number !== undefined && number.length > 0 && name !== undefined && name.length > 0) {
		return `${number} (${name})`;
	}
	if (number !== undefined && number.length > 0) {
		return number;
	}
	if (name !== undefined && name.length > 0) {
		return name;
	}
	return "an unknown caller";
}

export function voicemailMail(input: VoicemailMailInput): RenderedMail {
	const caller = formatCaller(input.callerIdNumber, input.callerIdName);
	const duration = formatDuration(input.durationMs);
	const received = input.receivedAt.toISOString().replace("T", " ").slice(0, 19) + " UTC";
	const mailbox =
		input.mailboxLabel === undefined || input.mailboxLabel.trim().length === 0
			? `mailbox ${input.mailboxNumber}`
			: `${input.mailboxLabel} (${input.mailboxNumber})`;

	const textLines = [
		`New voicemail in ${mailbox}.`,
		"",
		`From:     ${caller}`,
		`Received: ${received}`,
		`Duration: ${duration}`,
	];
	if (input.transcription !== undefined && input.transcription.trim().length > 0) {
		textLines.push("", "Transcription:", input.transcription.trim());
	}
	if (input.playUrl !== undefined) {
		textLines.push("", "Listen (this link expires shortly):", input.playUrl);
	}
	if (input.inboxUrl !== undefined) {
		textLines.push("", "Open the mailbox:", input.inboxUrl);
	}

	const htmlParts: string[] = [
		escapeHtml(`New voicemail in ${mailbox}.`),
		[
			`<span style="color:#666">From</span> ${escapeHtml(caller)}<br/>`,
			`<span style="color:#666">Received</span> ${escapeHtml(received)}<br/>`,
			`<span style="color:#666">Duration</span> ${escapeHtml(duration)}`,
		].join("\n"),
	];
	if (input.transcription !== undefined && input.transcription.trim().length > 0) {
		htmlParts.push(
			`<span style="color:#666">Transcription</span><br/>${escapeHtml(input.transcription.trim())}`,
		);
	}
	if (input.playUrl !== undefined) {
		htmlParts.push(
			actionLink("Listen", input.playUrl),
			`<span style="color:#666;font-size:13px">This playback link expires shortly.</span>`,
		);
	}
	if (input.inboxUrl !== undefined) {
		htmlParts.push(
			`<a href="${escapeHtml(input.inboxUrl)}" style="color:#111">Open the mailbox</a>`,
		);
	}

	return {
		subject: `New voicemail from ${caller} (${duration})`,
		text: textLines.join("\n"),
		html: shell(input.fromName ?? input.appName, htmlParts),
	};
}

// ---------------------------------------------------------------------------------------------
// Kari's Law
// ---------------------------------------------------------------------------------------------

export interface EmergencyDialedMailInput {
	readonly appName: string;
	readonly fromName?: string | undefined;
	/** What the caller keyed, e.g. `9911`. */
	readonly dialed: string;
	/** What went on the wire after the outside-line prefix was stripped, e.g. `911`. */
	readonly number: string;
	/** The calling station — the CALLBACK number a responder or a colleague dials. */
	readonly callerNumber?: string | undefined;
	readonly callerName?: string | undefined;
	/** The extension behind the calling station, when one is known. */
	readonly callerExtension?: string | undefined;
	/** The ELIN actually presented. Absent means the call went out with no caller id at all. */
	readonly elin?: string | undefined;
	/** The dispatchable location the ELIN is registered against, already formatted. */
	readonly location?: string | undefined;
	/** Set when the event named an address the control plane could not find or read. */
	readonly locationUnknown?: boolean | undefined;
	readonly trunkName?: string | undefined;
	/** When the call was placed — the event's `at`, never when this message was rendered. */
	readonly dialedAt: Date;
}

/** The address a responder is given, on one line. Empty parts are dropped, never rendered blank. */
export function formatDispatchableLocation(address: {
	readonly label?: string | null;
	readonly streetLine1?: string | null;
	readonly streetLine2?: string | null;
	readonly locationDetail?: string | null;
	readonly locality?: string | null;
	readonly administrativeArea?: string | null;
	readonly postalCode?: string | null;
	readonly country?: string | null;
}): string {
	const parts = [
		address.label,
		address.streetLine1,
		address.streetLine2,
		address.locationDetail,
		address.locality,
		address.administrativeArea,
		address.postalCode,
		address.country,
	]
		.map((part) => part?.trim())
		.filter((part): part is string => part !== undefined && part.length > 0);
	return parts.join(", ");
}

/**
 * The Kari's Law notification.
 *
 * ## What is in it, and why each part is there
 *
 * 47 CFR §9.16(b)(2) says the notification must include, "to the extent technically feasible", the
 * fact that a 911 call was made, a **callback number**, and **information about the caller's
 * location**. So the subject leads with the number dialed and the caller, and the body carries
 * the callback number, the extension, the dispatchable location behind the ELIN, and the instant
 * the call was placed. Nothing here is a link and nothing here needs a login: the recipient is a
 * front desk that has thirty seconds, not an admin at a browser.
 *
 * The message says explicitly when a field is missing rather than omitting the line, because
 * "location: unknown" is actionable — somebody walks the floor — and a missing line reads as a
 * rendering bug.
 */
export function emergencyDialedMail(input: EmergencyDialedMailInput): RenderedMail {
	const caller = formatCaller(input.callerNumber, input.callerName);
	const placed = input.dialedAt.toISOString().replace("T", " ").slice(0, 19) + " UTC";
	const callback =
		input.callerNumber === undefined || input.callerNumber.trim().length === 0
			? "not presented"
			: input.callerNumber.trim();
	const extension =
		input.callerExtension === undefined || input.callerExtension.trim().length === 0
			? "unknown"
			: input.callerExtension.trim();
	const location =
		input.location !== undefined && input.location.length > 0
			? input.location
			: input.locationUnknown === true
				? "on record but could not be read — check the emergency address for this number"
				: "not registered for this call";
	const elin = input.elin === undefined || input.elin.trim().length === 0 ? "none" : input.elin;

	const textLines = [
		`${input.number} was dialed from this phone system.`,
		"",
		`Dialed:    ${input.dialed}${input.dialed === input.number ? "" : ` (sent as ${input.number})`}`,
		`Caller:    ${caller}`,
		`Callback:  ${callback}`,
		`Extension: ${extension}`,
		`Location:  ${location}`,
		`ELIN:      ${elin}`,
		`Placed:    ${placed}`,
	];
	if (input.trunkName !== undefined && input.trunkName.trim().length > 0) {
		textLines.push(`Trunk:     ${input.trunkName.trim()}`);
	}
	textLines.push(
		"",
		"This is an automatic notification sent when an emergency number is dialed " +
			"(Kari's Law, 47 CFR §9.16). Nobody has to acknowledge it for the call to proceed.",
	);

	const rows = [
		[
			"Dialed",
			`${input.dialed}${input.dialed === input.number ? "" : ` (sent as ${input.number})`}`,
		],
		["Caller", caller],
		["Callback", callback],
		["Extension", extension],
		["Location", location],
		["ELIN", elin],
		["Placed", placed],
		...(input.trunkName !== undefined && input.trunkName.trim().length > 0
			? [["Trunk", input.trunkName.trim()]]
			: []),
	];

	return {
		subject: `EMERGENCY: ${input.number} dialed from ${caller}`,
		text: textLines.join("\n"),
		html: shell(input.fromName ?? input.appName, [
			`<strong>${escapeHtml(`${input.number} was dialed from this phone system.`)}</strong>`,
			rows
				.map(
					([label, value]) =>
						`<span style="color:#666">${escapeHtml(String(label))}</span> ${escapeHtml(String(value))}`,
				)
				.join("<br/>\n"),
			`<span style="color:#666;font-size:13px">${escapeHtml(
				"This is an automatic notification sent when an emergency number is dialed " +
					"(Kari's Law, 47 CFR §9.16). Nobody has to acknowledge it for the call to proceed.",
			)}</span>`,
		]),
	};
}
