import { AUTO_ANSWER_ALERT_INFO } from "../../auto-answer";
import { cfgValue, renderSettingsAsCfg } from "../format";
import type { RenderContext, RenderKey, RenderLine } from "../render-context";
import type { VendorTemplate } from "../template";
import type { SipTransport } from "@optimiq-voice/pbx-db";

/**
 * Yealink — the Common CFG plain-text format (firmware V84/V85/V86).
 *
 * ## The format
 *
 * `key = value`, one parameter per line, `#` comments, and a **mandatory** first line
 * `#!version:1.0.0.1`. That banner is the CONFIGURATION-format version, not a firmware version, and
 * every `.cfg` and `.boot` file must carry it as line 1. Its absence is the single most common
 * reason a hand-written Yealink file appears to be ignored: the phone fetches it, parses nothing,
 * and reports nothing.
 *
 * Yealink's own scheme has three layers — a per-model common file (`y0000000000xx.cfg`, where the
 * suffix is a model code: `66` T46S, `96` T54W, `97` T57W, `109` T48U…), a per-MAC file
 * (`<mac>.cfg`, lower case, no separators), and a phone-written `<mac>-local.cfg` holding user
 * overrides. We render ONE file, the per-MAC one: everything in it is per-device anyway, and a
 * shared file would be a second artifact to keep in sync for no benefit at our scale.
 *
 * ## The three parameter names that are easy to get subtly wrong
 *
 * - `account.N.sip_server.1.transport_type` — **`transport_type`, not `transport`.**
 * - `account.N.outbound_proxy.1.address` / `.port` — the proxy is an indexed sub-object, not the
 *   `outbound_host` / `outbound_port` pair some older documentation shows.
 * - `expkey.N.*` for an expansion module, not `expansionmodule.…`.
 *
 * ## Key namespaces, and the one place our schema does not map cleanly
 *
 * The V86 parameter guide has three: `linekey.N.*` (the DSS key column beside the screen),
 * `programablekey.N.*` (the hard keys — note the **single m**, which is Yealink's spelling and not
 * a typo here), and `expkey.N.*` (expansion module).
 *
 * There is no separate "memory key" namespace on this firmware line: a BLF or speed dial lives on a
 * `linekey` exactly as a line does. So our `line` and `memory` categories BOTH render to `linekey`,
 * and they share its index space. That is a real limitation — a device with `line` key 1 and
 * `memory` key 1 renders two `linekey.1.*` blocks and the later one wins — and it is left visible
 * rather than papered over with an offset, because an invented offset would silently put an
 * administrator's key on a different button than the one they chose. The UI's guidance is to use
 * one category per Yealink device.
 */

/** `account.N.sip_server.1.transport_type` — `0` UDP, `1` TCP, `2` TLS, `3` DNS-NAPTR. */
function transportCode(transport: SipTransport): string {
	switch (transport) {
		case "tcp": {
			return "1";
		}
		case "tls": {
			return "2";
		}
		default: {
			return "0";
		}
	}
}

/**
 * `linekey.N.type` for our vocabulary.
 *
 * The verified V86 codes: `15` Line, `16` BLF, `13` Speed Dial, `14` Intercom, `10` Call Park,
 * `39` BLF List, `2` Forward, `5` DND, `7` Recall, `12` Voice Mail, `23` Group Pickup,
 * `24` Multicast Paging, `27` XML Browser, `42` ACD, `73` Custom Key.
 *
 * `dtmf`, `transfer` and `url` in our vocabulary have **no verified Yealink line-key code** — the
 * V86 table has no DTMF or Transfer key type, and `24` is Multicast Paging rather than a URL key.
 * They render as `0` (N/A), which leaves the button dark. A dark button is a visible gap somebody
 * reports; a button wired to `5` because the number looked plausible would be a DND key labelled
 * "DTMF", and nobody reports that as a provisioning bug.
 */
function keyTypeCode(key: RenderKey): string {
	switch (key.keyType) {
		case "line": {
			return "15";
		}
		case "blf": {
			return "16";
		}
		case "speed-dial": {
			return "13";
		}
		case "park": {
			return "10";
		}
		case "intercom": {
			return "14";
		}
		default: {
			return "0";
		}
	}
}

function splitHostPort(value: string, fallbackPort: number): readonly [string, number] {
	const match = /^(?<host>\[[^\]]+\]|[^:]+)(?::(?<port>\d+))?$/u.exec(value);
	const host = match?.groups?.host ?? value;
	const port = match?.groups?.port;
	return [host, port === undefined ? fallbackPort : Number(port)];
}

function renderAccount(line: RenderLine): readonly string[] {
	const index = line.lineNumber;
	const entries = [
		`account.${index}.enable = 1`,
		`account.${index}.label = ${cfgValue(line.label ?? line.registerUser)}`,
		`account.${index}.display_name = ${cfgValue(line.displayName)}`,
		`account.${index}.auth_name = ${cfgValue(line.authUser)}`,
		`account.${index}.user_name = ${cfgValue(line.registerUser)}`,
		`account.${index}.password = ${cfgValue(line.password)}`,
		`account.${index}.sip_server.1.address = ${cfgValue(line.serverAddress)}`,
		`account.${index}.sip_server.1.port = ${line.serverPort}`,
		`account.${index}.sip_server.1.transport_type = ${transportCode(line.transport)}`,
		`account.${index}.sip_server.1.expires = ${line.registerExpiresSeconds}`,
		// `0` private, `2` BLA (Bridged Line Appearance).
		`account.${index}.shared_line = ${line.sharedLine ? "2" : "0"}`,
	];

	if (line.outboundProxy !== undefined) {
		const [host, port] = splitHostPort(line.outboundProxy, line.serverPort);
		entries.push(
			`account.${index}.outbound_proxy_enable = 1`,
			`account.${index}.outbound_proxy.1.address = ${cfgValue(host)}`,
			`account.${index}.outbound_proxy.1.port = ${port}`,
		);
	}

	if (line.voicemailNumber !== undefined) {
		entries.push(
			`account.${index}.subscribe_mwi = 1`,
			`account.${index}.voice_mail.number.1 = ${cfgValue(line.voicemailNumber)}`,
		);
	}

	return entries;
}

/** `linekey` / `programablekey` / `expkey`. See the class comment for the category mapping. */
function keyNamespace(category: RenderKey["category"]): string {
	switch (category) {
		case "expansion": {
			return "expkey";
		}
		case "programmable":
		case "soft": {
			// Yealink's own spelling, with one `m`. Correcting it produces a parameter the phone
			// silently ignores.
			return "programablekey";
		}
		default: {
			return "linekey";
		}
	}
}

function renderKey(key: RenderKey): readonly string[] {
	const prefix = `${keyNamespace(key.category)}.${key.keyIndex}`;
	const entries = [`${prefix}.type = ${keyTypeCode(key)}`, `${prefix}.line = ${key.lineNumber}`];
	if (key.value !== undefined) {
		entries.push(`${prefix}.value = ${cfgValue(key.value)}`);
	}
	if (key.label !== undefined) {
		entries.push(`${prefix}.label = ${cfgValue(key.label)}`);
	}
	return entries;
}

/**
 * Auto-answer, which on Yealink is the INTERCOM feature and not the `auto_answer` parameter.
 *
 * The trap is `account.N.auto_answer`, which exists, is called what you would search for, and is
 * wrong: it answers EVERY inbound call on that line, unconditionally and forever. Configuring it
 * here would turn a desk phone into an open microphone that anybody who can dial the extension can
 * open. The header-triggered behaviour lives under `features.intercom.*` instead: with
 * `features.intercom.allow = 1` the phone answers an INVITE whose `Alert-Info` carries
 * `info=alert-autoanswer` — the token {@link AUTO_ANSWER_ALERT_INFO} owns — and rings normally for
 * everything else.
 *
 * All four parameters are written explicitly rather than left to their defaults. Yealink's defaults
 * for this family (`allow` 1, `tone` 1, `mute` 0, `barge` 0) are documented and are also exactly the
 * values a phone that somebody has already touched will not have; a provisioned file that omits a
 * parameter leaves whatever the handset last had, which is how one phone in a fleet ends up silently
 * different from the other thirty-nine.
 *
 * `barge` stays OFF, and it is the only one of the four that is a policy choice rather than a
 * transcription of the vendor's default. Barge answers the intercom while the user is on another
 * call, putting that call on hold — which is right for an emergency page and wrong for the ordinary
 * case, and a deployment that wants it can set `features.intercom.barge` through the settings
 * cascade. Defaulting a fleet into "an intercom can interrupt any conversation" is not a default to
 * ship silently.
 */
function autoAnswerEntries(): readonly string[] {
	return [
		`# auto-answer for INVITEs carrying "Alert-Info: ${AUTO_ANSWER_ALERT_INFO}"`,
		"features.intercom.allow = 1",
		// The warning tone before the microphone opens. A phone that answers silently is a phone
		// whose owner cannot tell that it did, which is the one thing this feature must never be.
		"features.intercom.tone = 1",
		// Not muted on answer: a muted intercom is a page nobody can reply to, and the two-way case
		// is what supervision and intercom are for.
		"features.intercom.mute = 0",
		// See the note above: off is a decision, not a copied default.
		"features.intercom.barge = 0",
	];
}

export const YEALINK_TEMPLATE: VendorTemplate = {
	id: "0192a1c0-0000-7000-8000-000000000001",
	vendor: "yealink",
	name: "Yealink T3x / T4x / T5x (V84–V86 Common CFG)",
	models: ["T3", "T4", "T5", "CP", "W6", "W7", "VP"],
	defaults: {
		/**
		 * Static parameters carry a `static.` prefix and are excluded from the user-override
		 * protection mechanism — which is why this one is here rather than being assumed: a phone
		 * whose auto-provision mode is off never comes back for a second configuration.
		 */
		"static.auto_provision.mode": 1,
	},
	contentType: "text/plain; charset=utf-8",
	filename: (macAddress) => `${macAddress}.cfg`,
	render: (context: RenderContext): string => {
		const body = [
			// MANDATORY, line 1, both in `.cfg` and `.boot` files.
			"#!version:1.0.0.1",
			"",
			`# Optimiq Voice — ${context.macAddress}${context.model === undefined ? "" : ` (${context.model})`}`,
			`# rendered ${context.renderedAt.toISOString()}`,
			"",
			...context.lines.flatMap((line) => [...renderAccount(line), ""]),
			...autoAnswerEntries(),
			"",
			...context.keys.flatMap((key) => renderKey(key)),
		];
		return `${body.join("\n")}${renderSettingsAsCfg(context.settings)}\n`;
	},
	sources: [
		"Yealink Administrator's Guide for SIP-T2/T3/T4/T5/CP92X IP Phones V86.5 — `#!version:1.0.0.1` banner, boot/CFG file naming and per-model common-file codes, `account.X.*` table, `linekey.X.*` / `programablekey.X.*` / `expkey.X.*` and the numeric key-type table",
		"Yealink Administrator's Guide V86 — `features.intercom.allow` / `.mute` / `.tone` / `.barge`, and the `Alert-Info: info=alert-autoanswer` trigger for answering an intercom INVITE automatically",
	],
	caveats: [
		"Our `line` and `memory` key categories both render to `linekey`, which is the only DSS-key namespace this firmware line has — so a device using both categories at the same index renders two blocks and the later wins. Use one category per Yealink device.",
		"`dtmf`, `transfer` and `url` have no verified Yealink line-key type code and render as `0` (N/A) rather than a guessed number.",
		"Auto-answer is configured as the INTERCOM feature (`features.intercom.*`), not as `account.N.auto_answer` — the latter answers every inbound call unconditionally and would turn the handset into an open microphone. `features.intercom.barge` is left at 0, so an intercom will not interrupt a call already in progress; a deployment that wants emergency paging to barge must override it through the settings cascade.",
		"Yealink caches user edits in `<mac>-local.cfg`; with `static.auto_provision.custom.protect = 1` a provisioned value will not override one the user changed on the handset.",
		"Not validated against physical hardware.",
	],
};

/** Exported so the spec can pin the code tables without re-deriving them from rendered output. */
export const yealinkKeyTypeCode = keyTypeCode;
export const yealinkTransportCode = transportCode;
export const yealinkKeyNamespace = keyNamespace;
