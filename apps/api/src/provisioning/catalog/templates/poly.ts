import { AUTO_ANSWER_ALERT_INFO } from "../../auto-answer";
import { renderSettingsAsXmlAttributes, xmlValue } from "../format";
import type { RenderContext, RenderKey, RenderLine } from "../render-context";
import type { VendorTemplate } from "../template";
import type { SipTransport } from "@optimiq-voice/pbx-db";

/**
 * Poly / Polycom — UC Software / Poly Voice XML (VVX, Edge E).
 *
 * ## The format
 *
 * Every setting is an XML **attribute** whose attribute NAME is the dotted parameter name. The
 * element names and the nesting are decorative — the phone flattens every attribute it finds — so
 * `<PHONE_CONFIG><ALL reg.1.address="…"/></PHONE_CONFIG>` and any other well-formed arrangement are
 * equivalent. That is why this template's helpers produce attributes while the Grandstream and Snom
 * ones produce elements: the three formats look superficially alike and are not interchangeable.
 *
 * Edge E (Poly Voice OS 7.x+) uses the same `reg.x.*` / `attendant.*` / `lineKey.x.*` names as the
 * VVX line, so one template covers both.
 *
 * ## The two-file bootstrap, which we do not pretend to collapse
 *
 * A Poly phone boots by fetching a **master configuration file** — `<MAC>.cfg`, falling back to
 * `000000000000.cfg` — whose `<APPLICATION>` element carries `APP_FILE_PATH`, `CONFIG_FILES`,
 * `MISC_FILES`, `LOG_FILE_DIRECTORY`, `OVERRIDES_DIRECTORY` and `CONTACTS_DIRECTORY`. It is a
 * manifest, not a configuration, and there is no supported way to hand a Poly phone one URL and
 * have it read settings directly out of it.
 *
 * `CONFIG_FILES` is read **left to right and the LEFTMOST file wins** a duplicated parameter, which
 * is the opposite of most layering schemes and the opposite of what "later overrides earlier"
 * instincts predict. Our URL therefore belongs first in that list if it is to take precedence over
 * a site-wide file.
 *
 * So this template renders the **settings** document and
 * `plans/reference/device-provisioning-formats.md` records the master file that has to point at it.
 * Emitting the settings under `<MAC>.cfg` and hoping produces a phone that fetches the file, fails
 * to parse it as a manifest, and boots to defaults with no error anywhere an administrator can see.
 *
 * ## Transport values are WORDS
 *
 * `reg.N.server.1.transport` takes exactly `DNSnaptr` (the default), `TCPpreferred`, `UDPOnly`,
 * `TLS` or `TCPOnly`, case-sensitively. A numeric value is silently ignored — the trap for anyone
 * porting the Yealink template.
 */

function transportWord(transport: SipTransport): string {
	switch (transport) {
		case "tcp": {
			return "TCPOnly";
		}
		case "tls": {
			return "TLS";
		}
		default: {
			return "UDPOnly";
		}
	}
}

function splitHostPort(value: string, fallbackPort: number): readonly [string, number] {
	const match = /^(?<host>\[[^\]]+\]|[^:]+)(?::(?<port>\d+))?$/u.exec(value);
	const host = match?.groups?.host ?? value;
	const port = match?.groups?.port;
	return [host, port === undefined ? fallbackPort : Number(port)];
}

function registrationAttributes(line: RenderLine, sipDomain: string): readonly string[] {
	const index = line.lineNumber;
	const attributes = [
		/**
		 * The AOR, and effectively the line's enable flag — a Null `reg.N.address` disables the
		 * registration entirely. `user@host` rather than a bare user: a bare user works only when
		 * `voIpProt.server.1.address` is also set, and relying on that is how a phone ends up
		 * registering to the wrong domain after an unrelated edit.
		 */
		`reg.${index}.address="${xmlValue(`${line.registerUser}@${sipDomain}`)}"`,
		`reg.${index}.label="${xmlValue(line.label ?? line.registerUser)}"`,
		`reg.${index}.displayName="${xmlValue(line.displayName)}"`,
		`reg.${index}.type="${line.sharedLine ? "shared" : "private"}"`,
		`reg.${index}.auth.userId="${xmlValue(line.authUser)}"`,
		`reg.${index}.auth.password="${xmlValue(line.password)}"`,
		`reg.${index}.server.1.address="${xmlValue(line.serverAddress)}"`,
		`reg.${index}.server.1.port="${line.serverPort}"`,
		`reg.${index}.server.1.transport="${transportWord(line.transport)}"`,
		`reg.${index}.server.1.expires="${line.registerExpiresSeconds}"`,
		`reg.${index}.server.1.register="1"`,
	];
	if (line.outboundProxy !== undefined) {
		const [host, port] = splitHostPort(line.outboundProxy, line.serverPort);
		attributes.push(
			`reg.${index}.outboundProxy.address="${xmlValue(host)}"`,
			`reg.${index}.outboundProxy.port="${port}"`,
			// Same five literals as the server transport, and the same reason to spell them out.
			`reg.${index}.outboundProxy.transport="${transportWord(line.transport)}"`,
		);
	}
	if (line.voicemailNumber !== undefined) {
		attributes.push(
			`msg.mwi.${index}.subscribe="${xmlValue(`${line.registerUser}@${sipDomain}`)}"`,
			`msg.mwi.${index}.callBackMode="contact"`,
			`msg.mwi.${index}.callBack="${xmlValue(line.voicemailNumber)}"`,
		);
	}
	return attributes;
}

/**
 * BLF keys become attendant resources; speed dials become enhanced feature keys.
 *
 * Polycom has no single "programmable key" abstraction the way Yealink does. Presence monitoring is
 * the **attendant** feature (`attendant.reg` plus an `attendant.resourceList.N.*` list), and a key
 * that dials is an **enhanced feature key** (`efk.efklist.N.*` defining the macro plus
 * `efk.efksoftkey.N.*` putting it on a key, both gated on `feature.enhancedFeatureKeys.enabled`).
 * Mapping both onto one namespace, as a naive port of the Yealink template would, produces
 * speed-dial keys that light up for presence they never subscribe to.
 *
 * Both lists are **positional and dense** — unlike Yealink's memory keys, which are addressed by
 * button — so an entry's index is its POSITION among keys of that kind. `keyIndex` still decides
 * the order, which is what makes the position deterministic.
 */
function renderKeys(keys: readonly RenderKey[], sipDomain: string): readonly string[] {
	const attributes: string[] = [];

	const blf = keys.filter((key) => key.keyType === "blf" && key.value !== undefined);
	if (blf.length > 0) {
		attributes.push(`attendant.reg="1"`);
		for (const [position, key] of blf.entries()) {
			const index = position + 1;
			attributes.push(
				`attendant.resourceList.${index}.address="${xmlValue(`${key.value as string}@${sipDomain}`)}"`,
				`attendant.resourceList.${index}.label="${xmlValue(key.label ?? (key.value as string))}"`,
				// `normal` or `automata`; `normal` is a human whose presence is worth showing.
				`attendant.resourceList.${index}.type="normal"`,
			);
		}
	}

	const dialers = keys.filter(
		(key) =>
			key.value !== undefined &&
			(key.keyType === "speed-dial" || key.keyType === "park" || key.keyType === "intercom"),
	);
	if (dialers.length > 0) {
		attributes.push(`feature.enhancedFeatureKeys.enabled="1"`);
		for (const [position, key] of dialers.entries()) {
			const index = position + 1;
			/**
			 * An EFK is two halves: an `efklist` entry that DEFINES the macro, and an `efksoftkey`
			 * entry that puts it on a key. Emitting only the second leaves a key bound to a macro that
			 * does not exist, which the phone renders as a key that does nothing.
			 *
			 * `$Tinvite$` is the macro for "place a call to the preceding digits". Without it the key
			 * types the digits into the dial field and waits, which also reads as a broken key.
			 */
			const macro = `${key.value as string}$Tinvite$`;
			const label = xmlValue(key.label ?? (key.value as string));
			attributes.push(
				`efk.efklist.${index}.mname="sd${index}"`,
				`efk.efklist.${index}.status="1"`,
				`efk.efklist.${index}.action.string="${xmlValue(macro)}"`,
				`efk.efksoftkey.${index}.label="${label}"`,
				`efk.efksoftkey.${index}.status="1"`,
				`efk.efksoftkey.${index}.action.string="${xmlValue(macro)}"`,
			);
		}
	}

	return attributes;
}

/**
 * Auto-answer, which on Poly is a RING CLASS rather than a feature flag.
 *
 * This is the vendor whose model is genuinely different from the other four. Poly has no "answer
 * automatically when you see this header" switch. What it has is a table:
 * `voIpProt.SIP.alertInfo.N.value` is a string compared against the incoming `Alert-Info` field, and
 * `voIpProt.SIP.alertInfo.N.class` names the RING CLASS applied when it matches. One of the built-in
 * classes — `ringAutoAnswer` — plays a short ring and then answers. So auto-answer is expressed here
 * as "map this header to that ringer", and the mapping is the configuration.
 *
 * The consequence worth noticing is that Poly is the only one of the five where WE choose the token.
 * The other vendors match a string their firmware owns; this one matches whatever we write into
 * `.value`. That is why {@link AUTO_ANSWER_ALERT_INFO} is interpolated here rather than a Poly
 * convention being hard-coded: `Ring Answer` and `Auto Answer` are the two strings the Polycom
 * community uses, and either would have made this phone the odd one out on a switch that has to send
 * one header to a mixed fleet.
 *
 * Index 1 is claimed, and it is the only entry this template writes. The table is positional and
 * shared, so a deployment adding distinctive ringing through the settings cascade should start at 2.
 * That is recorded in `caveats` because it is the kind of collision that presents as "paging stopped
 * working after we added a ringtone".
 */
function autoAnswerAttributes(): readonly string[] {
	return [
		`voIpProt.SIP.alertInfo.1.value="${xmlValue(AUTO_ANSWER_ALERT_INFO)}"`,
		/*
		 * `ringAutoAnswer` — ring briefly, then answer. NOT `AUTO_ANSWER`, which some forum snippets
		 * show: the built-in class that answers with no ring at all leaves the person whose phone it
		 * is with no cue that their microphone opened, and the ring is the only indication this vendor
		 * offers. The Yealink and Snom templates make the same choice through their own parameters.
		 */
		`voIpProt.SIP.alertInfo.1.class="ringAutoAnswer"`,
	];
}

export const POLY_TEMPLATE: VendorTemplate = {
	id: "0192a1c0-0000-7000-8000-000000000002",
	vendor: "poly",
	name: "Poly / Polycom VVX and Edge E (UC Software 5.x–7.x)",
	models: ["VVX", "EDGE", "E", "SOUNDPOINT", "IP", "TRIO", "CCX"],
	defaults: {},
	contentType: "application/xml; charset=utf-8",
	// Deliberately NOT `<MAC>.cfg`: that name belongs to the master manifest. See the class comment.
	filename: (macAddress) => `${macAddress}-phone.cfg`,
	render: (context: RenderContext): string => {
		const attributes = [
			...context.lines.flatMap((line) => registrationAttributes(line, context.sipDomain)),
			...autoAnswerAttributes(),
			...renderKeys(context.keys, context.sipDomain),
		];
		const settings = renderSettingsAsXmlAttributes(context.settings);
		return [
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
			`<!-- Optimiq Voice — ${xmlValue(context.macAddress)} — rendered ${context.renderedAt.toISOString()} -->`,
			"<PHONE_CONFIG>",
			"\t<ALL",
			...attributes.map((attribute) => `\t\t${attribute}`),
			...(settings.length === 0 ? [] : [settings]),
			"\t/>",
			"</PHONE_CONFIG>",
			"",
		].join("\n");
	},
	sources: [
		"Poly UC Software 6.4.0 Administrator Guide — attribute-style XML, `reg.x.*`, `attendant.*`, `lineKey.x.*`, master-config attributes, configuration encryption",
		"Poly Voice Software Administrator Guide (Edge E) — the same `reg.x.*` / `attendant.*` names carried over from VVX, and the exact `reg.x.server.y.transport` literals",
		"Polycom, Provisioning with the Master Configuration File — `APP_FILE_PATH` / `CONFIG_FILES` / `MISC_FILES` semantics and the leftmost-wins ordering",
		"Poly UC Software parameter reference — `attendant.resourceList.x.{address,label,type}`, `efk.efklist.x.*`, `efk.efksoftkey.x.*`, `msg.mwi.x.*`",
		"Poly UC Software Parameter Reference Guide 7.2.0 — `voIpProt.SIP.alertInfo.x.value` / `.class`: the Alert-Info field is compared against `value` and the named ring class is applied, with `ringAutoAnswer` as the class that answers the call",
	],
	caveats: [
		"A Poly phone fetches a MASTER config file first, and `CONFIG_FILES` is LEFTMOST-wins. This document is the settings file it must be pointed at; the master snippet is in plans/reference/device-provisioning-formats.md. Generating that manifest is a follow-up.",
		"Speed dials are rendered as enhanced feature keys, which occupy soft keys rather than the line-key column — the physical placement will not match a Yealink of the same layout. Polycom's other speed-dial mechanism is a contact-directory file (`<MAC>-directory.xml`) that this build does not generate.",
		"The phone WRITES its own `<MAC>-phone.cfg` and `<MAC>-web.cfg` override files. A provisioned value can appear ignored when such an override exists.",
		"BLF and EFK entries are positional dense lists, so a key's `keyIndex` decides its ORDER but not its slot number.",
		"Auto-answer occupies `voIpProt.SIP.alertInfo.1.*`. That table is positional and shared with distinctive ringing, so a deployment adding its own Alert-Info mappings through the settings cascade must start at index 2 — overwriting index 1 silently disables paging and intercom.",
		"UNVERIFIED: whether `voIpProt.SIP.alertInfo.x.value` matches the Alert-Info field EXACTLY or as a substring. Poly's own examples use bare tokens (`Ring Answer`), while the header this platform sends is the parameter form `info=alert-autoanswer`. If a handset rings instead of answering, this comparison is the first thing to test.",
		"Not validated against physical hardware.",
	],
};

export const polyTransportWord = transportWord;
