import { createHash } from "node:crypto";
import { cfgValue, renderSettingsAsCfg } from "../format";
import type { RenderContext, RenderKey, RenderLine } from "../render-context";
import type { VendorTemplate } from "../template";
import type { SipTransport } from "@optimiq-voice/pbx-db";

/**
 * Fanvil X-series — the `<<VOIP CONFIG FILE>>` sectioned text format.
 *
 * ## The format
 *
 * ```text
 * <<VOIP CONFIG FILE>>Version:2.0002
 *
 * <SIP CONFIG MODULE>
 * SIP1 Enable Reg :1
 * <DSSKEY CONFIG MODULE>
 * Fkey1 Type :2
 * <<END OF FILE>>
 * ```
 *
 * Chosen over Fanvil's `<sysConf>` XML dialect because it is the format Fanvil's own exported
 * backups use, so an administrator can diff what we produce against what their phone produces —
 * the most useful debugging affordance a provisioning system can offer, and the one recommended
 * remedy for the unverified key encodings below.
 *
 * Four things matter, and all four are silent when wrong:
 *
 * 1. **The banner is line 1 and ends CRLF.** The whole file uses CRLF.
 * 2. **Section headers use SINGLE angle brackets and are never closed.** A module runs until the
 *    next module header. There is no `</SIP CONFIG MODULE>`.
 * 3. **`<<END OF FILE>>` terminates the document.** Reaching EOF without it is read as truncation
 *    and nothing is applied.
 * 4. **The separator is a colon.** The space padding before it in Fanvil's own exports is cosmetic
 *    — the parser splits on the first colon and trims — but `Key=value` is an unrecognised line.
 *
 * ## The version string is a CHANGE MARKER, not a format version
 *
 * This is the trap that makes Fanvil different from every other vendor here. **The phone will not
 * re-apply a file whose version string has not changed since the last fetch.** A constant
 * `Version:2.0000` therefore means the configuration applies exactly once, ever — including after a
 * real edit, which then appears to have been ignored.
 *
 * So the version is **derived from the content**: `2.` plus ten decimal digits of a SHA-256 over
 * the body. An unchanged device renders an unchanged version and the phone does nothing (no
 * spurious reboot); any real change moves it and the phone applies. Collision probability is about
 * one in ten billion, and a collision's consequence is one skipped update rather than a wrong
 * configuration.
 */

/** `SIPn Transport` — `0` UDP, `1` TCP. TLS is 2 or 3 depending on model; see `caveats`. */
function transportCode(transport: SipTransport): string {
	switch (transport) {
		case "tcp": {
			return "1";
		}
		case "tls": {
			// Fanvil's own parameter sheets show 2 for the X3S/X4 generation and 3 for
			// X5S/X6/X210/X7/XU. 2 is the older and more widely accepted value; a deployment on the
			// newer generation overrides it through the settings cascade. Recorded in `caveats` rather
			// than guessed per model, because the model string is free text and a wrong branch here
			// would silently drop a TLS deployment onto plaintext.
			return "2";
		}
		default: {
			return "0";
		}
	}
}

/** The one separator, in one place, so the mistake can only be made once. */
function entry(key: string, value: string | number): string {
	return `${key} :${cfgValue(value)}`;
}

function renderAccount(line: RenderLine): readonly string[] {
	const prefix = `SIP${line.lineNumber}`;
	const entries = [
		entry(`${prefix} Enable Reg`, 1),
		entry(`${prefix} Phone Number`, line.registerUser),
		entry(`${prefix} Display Name`, line.displayName),
		entry(`${prefix} Register Addr`, line.serverAddress),
		entry(`${prefix} Register Port`, line.serverPort),
		entry(`${prefix} Register User`, line.authUser),
		entry(`${prefix} Register Pswd`, line.password),
		entry(`${prefix} Register TTL`, line.registerExpiresSeconds),
		entry(`${prefix} Transport`, transportCode(line.transport)),
	];
	if (line.outboundProxy !== undefined) {
		const [host, port] = splitHostPort(line.outboundProxy, line.serverPort);
		entries.push(entry(`${prefix} Proxy Addr`, host), entry(`${prefix} Proxy Port`, port));
	}
	return entries;
}

function splitHostPort(value: string, fallbackPort: number): readonly [string, number] {
	const match = /^(?<host>\[[^\]]+\]|[^:]+)(?::(?<port>\d+))?$/u.exec(value);
	const host = match?.groups?.host ?? value;
	const port = match?.groups?.port;
	return [host, port === undefined ? fallbackPort : Number(port)];
}

/**
 * DSS keys, which have a shape no other vendor here shares.
 *
 * A key is exactly four fields — `Type`, `Value`, `Title`, `ICON` — and there is **no**
 * `Fkey1 Subtype` parameter, however much the phone's web UI implies one. `Type` is numeric:
 * `0` None, `1` Memory key, `2` Line, `3` Key Event, `4` DTMF, `7` URL, `13` BLF List,
 * `14` Multicast, `20` Action URL, `21` XML browser.
 *
 * The interesting part: **BLF, speed dial, presence, intercom and call park are ALL `Type = 1`
 * (Memory key)**, and the distinction rides inside `Value` as `<number>@<line>/<subtype>` — e.g.
 * `200@1/bc` for a BLF on line 1. Only `bc` is corroborated from a working template; the rest of
 * the subtype letter map is not documented anywhere we could verify. So this template emits `bc`
 * for BLF, a bare `<number>@<line>` for a plain speed dial (which is the memory key's default
 * behaviour), and nothing it cannot justify. A guessed letter would produce a key that dials
 * something unexpected, which is worse than a key that only dials.
 */
function renderKey(key: RenderKey): readonly string[] {
	const prefix = `Fkey${key.keyIndex}`;
	const entries: string[] = [];

	if (key.keyType === "line") {
		entries.push(entry(`${prefix} Type`, 2), entry(`${prefix} Value`, `SIP${key.lineNumber}`));
	} else if (key.keyType === "blf" && key.value !== undefined) {
		entries.push(
			entry(`${prefix} Type`, 1),
			entry(`${prefix} Value`, `${key.value}@${key.lineNumber}/bc`),
		);
	} else if (key.keyType === "speed-dial" && key.value !== undefined) {
		entries.push(
			entry(`${prefix} Type`, 1),
			entry(`${prefix} Value`, `${key.value}@${key.lineNumber}`),
		);
	} else if (key.keyType === "dtmf" && key.value !== undefined) {
		entries.push(entry(`${prefix} Type`, 4), entry(`${prefix} Value`, key.value));
	} else if (key.keyType === "url" && key.value !== undefined) {
		entries.push(entry(`${prefix} Type`, 7), entry(`${prefix} Value`, key.value));
	} else {
		// `park`, `intercom`, `transfer` and `none` have no verified encoding on this vendor. A key
		// explicitly set to None is better than one wired to a guess.
		entries.push(entry(`${prefix} Type`, 0));
	}

	if (key.label !== undefined) {
		entries.push(entry(`${prefix} Title`, key.label));
	}
	return entries;
}

/**
 * `2.` plus ten digits derived from the body. See the class comment for why this is not a constant.
 *
 * Ten digits rather than a hex prefix because Fanvil's observed version strings are decimal
 * (`2.0002`, `2.0000000000`) and a hex character in a field the firmware may parse numerically is a
 * risk taken for no benefit.
 */
export function fanvilVersionFor(body: string): string {
	const digest = createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12);
	return `2.${(Number.parseInt(digest, 16) % 10_000_000_000).toString().padStart(10, "0")}`;
}

/** The whole file uses CRLF, per Fanvil's documented header. */
const CRLF = "\r\n";

export const FANVIL_TEMPLATE: VendorTemplate = {
	id: "0192a1c0-0000-7000-8000-000000000004",
	vendor: "fanvil",
	name: "Fanvil X-series (VOIP CONFIG FILE, text dialect)",
	models: ["X", "H", "I", "V", "A"],
	defaults: {},
	contentType: "text/plain; charset=utf-8",
	filename: (macAddress) => `${macAddress}.cfg`,
	render: (context: RenderContext): string => {
		const body = [
			`#Optimiq Voice — ${context.macAddress} — rendered ${context.renderedAt.toISOString()}`,
			"",
			"<SIP CONFIG MODULE>",
			...context.lines.flatMap((line) => renderAccount(line)),
			"",
			...(context.keys.length === 0
				? []
				: ["<DSSKEY CONFIG MODULE>", ...context.keys.flatMap((key) => renderKey(key)), ""]),
		].join(CRLF);
		const settings = renderSettingsAsCfg(context.settings, { separator: " :", comment: "#" })
			.split("\n")
			.join(CRLF);
		const content = `${body}${settings}`;
		// The version is derived from the content, so an unchanged device does not make the phone
		// re-apply (and on some models, reboot). See the class comment.
		return [
			`<<VOIP CONFIG FILE>>Version:${fanvilVersionFor(content)}`,
			"",
			content,
			"",
			"<<END OF FILE>>",
			"",
		].join(CRLF);
	},
	sources: [
		"Fanvil Auto Provision Description (official) — `<<VOIP CONFIG FILE>>Version:` header (64 chars, CRLF), unclosed single-bracket module headers, `<<END OF FILE>>`, per-model fixed common-file names, `$mac` URL token",
		"Fanvil X-series parameter spreadsheet — `SIPn *` parameter names, `FkeyN Type/Value/Title/ICON`, numeric key-type codes",
		"BroadSoft Partner Configuration Guide, Fanvil (Cisco-hosted) — cross-check of the SIP parameter names",
		"Fanvil-authored provisioning templates — `<number>@<line>/<subtype>` memory-key value encoding, `bc` = BLF",
	],
	caveats: [
		"UNVERIFIED: the TLS transport integer is 2 on the X3S/X4 generation and 3 on X5S/X6/X210/X7/XU in Fanvil's own sheets. This template writes 2; a newer-generation deployment must override `SIPn Transport` through the settings cascade until this is settled on hardware.",
		"UNVERIFIED: only the `bc` (BLF) memory-key subtype is corroborated. `park`, `intercom` and `transfer` render as Type 0 (None) rather than a guessed subtype letter. Configure one of each in the phone's web UI, export, and read back the exact Value strings.",
		"The version string is a change marker, not a format version — it is derived from the rendered body so an unchanged device does not trigger a re-apply.",
		"Models with a separate expansion module index those keys under a prefix this template does not emit.",
		"Not validated against physical hardware.",
	],
};

export const fanvilTransportCode = transportCode;
