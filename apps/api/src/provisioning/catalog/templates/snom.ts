import { renderSettingsAsXmlElements, xmlEscape, xmlValue } from "../format";
import type { RenderContext, RenderKey, RenderLine } from "../render-context";
import type { VendorTemplate } from "../template";
import type { SipTransport } from "@optimiq-voice/pbx-db";

/**
 * Snom D7xx / D8xx — the `<settings>` XML document (firmware 10.x).
 *
 * ## The format
 *
 * Root `<settings>`, children `<phone-settings>` and `<functionKeys>`. A setting is
 * `<name idx="N" perm="FLAG">value</name>` — **the index is an attribute**, not part of the element
 * name, which is what distinguishes this from the other two XML formats in this catalogue.
 *
 * ## Three things that are Snom-specific and cost a day each
 *
 * **1. `idx` bases differ.** Identities (`user_*`) are **1-based**; function keys (`fkey`) are
 * **0-based**. Not a typo. The template decrements for keys, so our uniformly 1-based `keyIndex`
 * lands where an administrator counted it.
 *
 * **2. `perm=""` and `perm=" "` mean OPPOSITE things.** Empty (or `$`, `RW`) is user-changeable and
 * re-applied on every provisioning; a **single space** (or `&`, `R`) is write-protected. `!` means
 * provisioning wins only while the user has never changed it locally — which is precisely the flag
 * NOT to put on credentials, because a user who once touched a field would then permanently pin a
 * stale password. This template uses `R` for credentials and `RW` for preferences, and never `!`.
 *
 * **3. There is no transport parameter.** The transport rides on `user_outbound` as a suffix:
 * `pbx.example.com:5060;udp`. A `user_server_type` does not exist on this firmware line, and adding
 * one produces a setting the phone ignores while the transport stays at its default.
 *
 * ## Function keys
 *
 * `<fkey idx="N" context="C" label="L" perm="P">TYPE ARG</fkey>` — the **text** is the whole
 * instruction. `line`, `blf sip:1001@host;user=phone`, `speed 1002`, `dest sip:…`, `icom`,
 * `multicast`, `transfer`, `redirect`, `keyevent F_…`. `context` names the identity (1-based) or the
 * word `active`.
 */

/** The `;transport` suffix on `user_outbound`. There is no separate parameter. */
function transportSuffix(transport: SipTransport): string {
	switch (transport) {
		case "tcp": {
			return "tcp";
		}
		case "tls": {
			return "tls";
		}
		default: {
			return "udp";
		}
	}
}

/**
 * `perm`: `R` write-protected, `RW` user-changeable.
 *
 * Spelled as words rather than as `""` / `" "` deliberately — the two whitespace forms mean
 * opposite things and a stray trim anywhere in this file's lifetime would silently invert every
 * credential's protection. `R` and `RW` are documented aliases with no such failure mode.
 */
function setting(name: string, index: number, value: string | number, readOnly = false): string {
	return `\t\t<${xmlEscape(name)} idx="${index}" perm="${readOnly ? "R" : "RW"}">${xmlValue(value)}</${xmlEscape(name)}>`;
}

function renderAccount(line: RenderLine): readonly string[] {
	const index = line.lineNumber;
	const host =
		line.serverPort === 5060 ? line.serverAddress : `${line.serverAddress}:${line.serverPort}`;
	const outboundHost = line.outboundProxy ?? `${line.serverAddress}:${line.serverPort}`;
	return [
		setting("user_active", index, "on"),
		setting("user_realname", index, line.displayName),
		setting("user_name", index, line.registerUser, true),
		setting("user_pname", index, line.authUser, true),
		setting("user_pass", index, line.password, true),
		setting("user_host", index, host, true),
		// The transport lives here, as a suffix. See the class comment.
		setting("user_outbound", index, `${outboundHost};${transportSuffix(line.transport)}`, true),
		setting("user_expiry", index, line.registerExpiresSeconds),
		setting("user_srtp", index, "off"),
	];
}

/**
 * An `<fkey>`'s instruction text.
 *
 * `blf` takes a full SIP URI with `;user=phone`, which is the form Snom's own documentation shows —
 * a bare extension number subscribes to nothing and the key stays dark. `dtmf` is not in the
 * documented keyword set and is rendered as `none` rather than guessed.
 */
function keyInstruction(key: RenderKey, sipDomain: string): string {
	const target = key.value;
	switch (key.keyType) {
		case "line": {
			return "line";
		}
		case "blf": {
			return target === undefined ? "none" : `blf sip:${target}@${sipDomain};user=phone`;
		}
		case "speed-dial": {
			return target === undefined ? "none" : `speed ${target}`;
		}
		case "park": {
			return target === undefined ? "none" : `dest sip:${target}@${sipDomain}`;
		}
		case "intercom": {
			return "icom";
		}
		case "transfer": {
			return "transfer";
		}
		case "url": {
			return target === undefined ? "none" : `dest ${target}`;
		}
		default: {
			return "none";
		}
	}
}

/** `idx` is 0-based here and 1-based for identities. See the class comment. */
function renderKey(key: RenderKey, sipDomain: string): string {
	const label = xmlValue(key.label ?? "");
	return `\t\t<fkey idx="${Math.max(0, key.keyIndex - 1)}" context="${key.lineNumber}" label="${label}" perm="RW">${xmlValue(keyInstruction(key, sipDomain))}</fkey>`;
}

export const SNOM_TEMPLATE: VendorTemplate = {
	id: "0192a1c0-0000-7000-8000-000000000005",
	vendor: "snom",
	name: "Snom D7xx / D8xx (firmware 10.x settings XML)",
	models: ["D", "M", "A", "PA"],
	defaults: {},
	contentType: "application/xml; charset=utf-8",
	filename: (macAddress) => `${macAddress}.xml`,
	render: (context: RenderContext): string => {
		const settings = renderSettingsAsXmlElements(context.settings, "\t\t");
		return [
			// Lowercase `utf-8` is the documented form.
			'<?xml version="1.0" encoding="utf-8"?>',
			`<!-- Optimiq Voice — ${xmlValue(context.macAddress)} — rendered ${context.renderedAt.toISOString()} -->`,
			"<settings>",
			"\t<phone-settings>",
			...context.lines.flatMap((line) => renderAccount(line)),
			...(settings.length === 0 ? [] : [settings]),
			"\t</phone-settings>",
			...(context.keys.length === 0
				? []
				: [
						"\t<functionKeys>",
						...context.keys.map((key) => renderKey(key, context.sipDomain)),
						"\t</functionKeys>",
					]),
			"</settings>",
			"",
		].join("\n");
	},
	sources: [
		"Snom Service Hub — Desk Phone Configuration Files: `<settings>` structure, `<phone-settings>` / `<functionKeys>` children, minimal example, BLF fkey example",
		'Snom Service Hub — Permission Flags: `""` / `$` / `RW` user-changeable, `" "` / `&` / `R` write-protected, `!` provisioning-wins-until-touched, `V` volatile',
		"Snom Service Hub — `<functionKeys>` tag: `<fkey idx context label perm>` attribute syntax and keyword set",
		"Snom Service Hub — Auto Provisioning: `{mac}`, `%MACD`, `{phone_type}`, `{firmware_version}` URL placeholders",
		"BroadSoft Partner Configuration Guide, Snom 10.1.51.12 (Cisco-hosted) — `user_pname` / `user_outbound` / `user_expiry` cross-check",
	],
	caveats: [
		"`<fkey idx>` is 0-based while identities are 1-based; the template decrements so a `keyIndex` of 1 is the phone's first programmable key.",
		"There is no transport parameter on this firmware line — the transport is a `;udp` / `;tcp` / `;tls` suffix on `user_outbound`, and this template always emits `user_outbound` for that reason even when no proxy is configured.",
		'`perm` is written as `R` / `RW` rather than the whitespace forms, because `perm=""` and `perm=" "` mean opposite things and a stray trim would invert every credential\'s protection.',
		"`dtmf` has no documented Snom keyword and renders as `none` rather than a guess.",
		"If a deployment's Setting URL omits `{mac}`, the phone also requests a `-<MAC>` filename variant; plan the server route for both.",
		"Not validated against physical hardware.",
	],
};

export const snomKeyInstruction = keyInstruction;
export const snomTransportSuffix = transportSuffix;
