import { AUTO_ANSWER_CALL_INFO } from "../../auto-answer";
import { renderSettingsAsXmlElements, xmlEscape, xmlValue } from "../format";
import type { RenderContext, RenderKey, RenderLine } from "../render-context";
import type { VendorTemplate } from "../template";
import type { SipTransport } from "@optimiq-voice/pbx-db";

/**
 * Grandstream — `<gs_provision version="1">` carrying the **alias dialect**.
 *
 * ## The three formats, and why this is the one
 *
 * GRP26xx and GXP firmware accept three:
 *
 * 1. A legacy **binary** `cfg<mac>`, produced by Grandstream's own encoding tool. Not renderable.
 * 2. **P-values**: `<config version="1">` containing `<P271>1</P271>`.
 * 3. **Aliases**: `<config version="2">` containing
 *    `<item name="account.1.sip.server.1.address">…</item>`.
 *
 * The root is always `<gs_provision version="1">` — never `gs_config` — and it is the INNER
 * `<config>` element's `version` that selects the dialect. Mixing them, or leaving `version="1"`
 * while writing alias names, produces a document the phone silently ignores.
 *
 * ## Why the alias dialect, in two parts
 *
 * **P-values are irregular.** Accounts 2–4 are not a uniform shift: each is a block based at
 * `(N + 2) × 100` (account 2 → 400) with its own within-block offsets — Active `+1`, SIP server
 * `+2`, outbound proxy `+3`, user id `+4`, auth id `+5`, password `+6`, display name `+7`,
 * registration `+10`, expiration `+12`, local port `+13`, account name `+17`, transport `+48`. So
 * account 2's "active" is `P401` and its transport is `P448`. Accounts 5–16 on a GRP2650 have no
 * confirmed P-block at all.
 *
 * **And the key-mode integer scale is genuinely ambiguous**, with two Grandstream documents
 * disagreeing:
 *
 * | Source | Line | Speed dial | BLF |
 * |---|---|---|---|
 * | GXP21xx administration guide, Table 24 (fixed line VPKs) | 0 | 10 | 11 |
 * | Dynamic-VPK/MPK scale in Grandstream's own template annotations | 31 | 0 | 1 |
 *
 * A template that picks one is wrong on half the fleet, and wrong in the worst way — a key that
 * lights up as the *wrong feature* rather than not at all. Current firmware accepts **case-insensitive
 * string** mode names, so this template writes `"BLF"` and `"SpeedDial"` and the conflict is
 * avoided rather than resolved. Resolving it needs hardware; until then no P-value template should
 * be written. See `plans/reference/device-provisioning-formats.md`.
 *
 * ## Three device-facing traps
 *
 * 1. **`registerExpiration` is MINUTES** (1–64800, default 60). A `3600` there is a 60-hour
 *    re-registration interval, which works until the first NAT binding expires and then presents as
 *    "inbound calls stop after a while".
 * 2. **A VPK's `account` is 0-indexed** while account parameters are 1-indexed. Line 1 → `0`.
 * 3. **Dynamic VPKs must be contiguous** — a gap deletes every later key — so a key's slot is its
 *    position among configured keys, not its `keyIndex`. The one vendor here where that is true.
 *
 * ## Filename
 *
 * The phone walks `cfg<mac>.xml` → `cfg<mac>` → `cfg<model>.xml` → `cfg.xml` → `dev<mac>.cfg` →
 * `external.cfg`, first match wins. We serve the first. The optional `<mac>` element (a sibling of
 * `<config>`) is validated against the device when present, which is a guard worth having on a
 * token-addressed URL: a token pasted into the wrong handset is refused rather than applied.
 */

/** `account.N.sip.transport` — accepts `UDP` / `TCP` / `Tls Or Tcp`, or 0/1/2. */
function transportWord(transport: SipTransport): string {
	switch (transport) {
		case "tcp": {
			return "TCP";
		}
		case "tls": {
			return "Tls Or Tcp";
		}
		default: {
			return "UDP";
		}
	}
}

/** `pks.vpk.N.keyMode`, as a STRING. See the class comment for why not an integer. */
function keyMode(key: RenderKey): string {
	switch (key.keyType) {
		case "line": {
			return "Line";
		}
		case "blf": {
			return "BLF";
		}
		case "speed-dial": {
			return "SpeedDial";
		}
		case "park": {
			return "CallPark";
		}
		case "intercom": {
			return "Intercom";
		}
		case "dtmf": {
			return "DTMF";
		}
		case "transfer": {
			return "Transfer";
		}
		default: {
			return "None";
		}
	}
}

/**
 * One `<item name="…">value</item>`.
 *
 * The NAME is escaped as well as the value: an administrator's override key reaches this through
 * the settings cascade, and an unescaped quote in an attribute would produce a document that fails
 * to parse — taking every setting with it, not only the bad one.
 */
function item(name: string, value: string | number): string {
	return `\t\t<item name="${xmlEscape(name)}">${xmlValue(value)}</item>`;
}

/** 1–64800 minutes, converted from seconds and clamped to the documented range. */
export function clampMinutes(seconds: number): number {
	return Math.min(64_800, Math.max(1, Math.round(seconds / 60)));
}

function renderAccount(line: RenderLine): readonly string[] {
	const index = line.lineNumber;
	// The SIP server field carries `host:port`; `account.N.sip.localPort` is the phone's own listener
	// (P40) and is emphatically not the registrar's port. Writing the port there instead is the
	// mistake that makes a phone register from 5060 to nothing.
	const server =
		line.serverPort === 5060 ? line.serverAddress : `${line.serverAddress}:${line.serverPort}`;
	const items = [
		item(`account.${index}.enable`, "Yes"),
		item(`account.${index}.name`, line.label ?? line.registerUser),
		item(`account.${index}.sip.server.1.address`, server),
		item(`account.${index}.sip.userid`, line.registerUser),
		item(`account.${index}.sip.subscriber.userid`, line.authUser),
		item(`account.${index}.sip.subscriber.password`, line.password),
		item(`account.${index}.sip.subscriber.name`, line.displayName),
		item(`account.${index}.sip.registration`, "Yes"),
		item(`account.${index}.sip.transport`, transportWord(line.transport)),
		// MINUTES. See the class comment.
		item(`account.${index}.sip.registerExpiration`, clampMinutes(line.registerExpiresSeconds)),
	];
	if (line.outboundProxy !== undefined) {
		items.push(item(`account.${index}.sip.outboundProxy.1.address`, line.outboundProxy));
	}
	return items;
}

/**
 * `pks.vpk.N.*` — contiguous, with a 0-indexed account.
 *
 * Our `keyIndex` is sparse by design (memory key 7 is a specific button on every other vendor
 * here), so the VPK slot is the key's POSITION in the sorted list. `keyIndex` still decides the
 * order, which is what makes the position deterministic; what it cannot do on this vendor is decide
 * the slot.
 */
function renderKeys(keys: readonly RenderKey[]): readonly string[] {
	return keys
		.filter((key) => key.keyType !== "none")
		.flatMap((key, position) => {
			const index = position + 1;
			const items = [
				item(`pks.vpk.${index}.keyMode`, keyMode(key)),
				// 0-indexed. Line 1 is account 0.
				item(`pks.vpk.${index}.account`, Math.max(0, key.lineNumber - 1)),
			];
			if (key.value !== undefined) {
				items.push(item(`pks.vpk.${index}.value`, key.value));
			}
			if (key.label !== undefined) {
				items.push(item(`pks.vpk.${index}.description`, key.label));
			}
			return items;
		});
}

/**
 * Auto-answer — the one vendor of the five that does not read `Alert-Info` at all.
 *
 * Grandstream's feature is named "Allow Auto Answer by Call-Info", and what it matches is
 * `answer-after=` on a **`Call-Info`** header: the Broadsoft/Cisco convention rather than the
 * Yealink/Snom one. That is a header difference and not a token difference, which is why
 * `packages/…/auto-answer.ts` exports a second constant rather than trying to pick a spelling that
 * satisfies everybody. A switch paging a mixed fleet has to send both headers; a phone ignores the
 * one it was not configured for, so sending both costs nothing.
 *
 * ## Why P-NAMES in an alias document, which this template otherwise never writes
 *
 * The two parameters are corroborated as `P298` ("Allow Auto Answer by Call-Info", 0/1) and `P2356`
 * ("Custom Call-Info for Auto Answer"). Their ALIAS names are not — they appear in no Grandstream
 * document this build could read, and the class comment above explains at length what a template
 * that invents a parameter name buys: a setting the phone silently ignores, indistinguishable from
 * one it applied. So the corroborated names are written and the uncorroborated ones are not, which
 * is the same trade `fanvil.ts` makes when it renders an unverified key as `Type 0`.
 *
 * The risk this takes is bounded and worth stating. A `<config version="2">` document is a list of
 * independent `<item>` elements; an item whose NAME the firmware does not recognise is dropped on
 * its own, and does not invalidate the account credentials three lines above it. The "mixing the
 * dialects breaks the document" warning in the class comment is about writing ALIAS names under
 * `version="1"`, which is a whole-document dialect mismatch. This is the other direction and is
 * per-item. Still UNVERIFIED — see `caveats`.
 */
function autoAnswerItems(): readonly string[] {
	return [
		// "Allow Auto Answer by Call-Info" — 0 No, 1 Yes, default 0.
		item("P298", 1),
		/*
		 * "Custom Call-Info for Auto Answer": the string the phone looks for in the Call-Info header.
		 * Set explicitly rather than left empty, because an empty value on this parameter is
		 * documented as "any Call-Info", and a handset that auto-answers on ANY Call-Info header will
		 * eventually be opened by a carrier or an SBC that adds one for its own reasons.
		 */
		item("P2356", AUTO_ANSWER_CALL_INFO),
	];
}

export const GRANDSTREAM_TEMPLATE: VendorTemplate = {
	id: "0192a1c0-0000-7000-8000-000000000003",
	vendor: "grandstream",
	name: "Grandstream GRP26xx / GXP (gs_provision alias dialect)",
	models: ["GRP", "GXP", "GXV", "DP", "WP", "HT"],
	defaults: {},
	contentType: "application/xml; charset=utf-8",
	filename: (macAddress) => `cfg${macAddress}.xml`,
	render: (context: RenderContext): string => {
		const settings = renderSettingsAsXmlElements(context.settings, "\t\t");
		return [
			'<?xml version="1.0" encoding="UTF-8"?>',
			`<!-- Optimiq Voice — rendered ${context.renderedAt.toISOString()} -->`,
			'<gs_provision version="1">',
			`\t<mac>${xmlValue(context.macAddress)}</mac>`,
			// version="2" selects the ALIAS dialect. Changing it to "1" without rewriting every name
			// below to a P-value produces a document the phone silently ignores.
			'\t<config version="2">',
			...context.lines.flatMap((line) => renderAccount(line)),
			...autoAnswerItems(),
			...renderKeys(context.keys),
			...(settings.length === 0 ? [] : [settings]),
			"\t</config>",
			"</gs_provision>",
			"",
		].join("\n");
	},
	sources: [
		'Grandstream SIP Device Provisioning Guide — `<gs_provision version="1">` root, `<mac>` validation, AES-256-CBC whole-file encryption (P1359)',
		"Grandstream GRP261x/262x/263x Administration Guide — alias dialect, filename request order `cfg<mac>.xml → cfg<mac> → cfg<model>.xml → cfg.xml → dev<mac>.cfg → external.cfg`, P8467",
		"Grandstream GXP21xx Administration Guide, Table 24 — VPK mode table (string and integer forms)",
		"Grandstream-authored configuration templates — account P-value cross-check (P271/P270/P47/P48/P35/P36/P34/P3/P31/P32/P130), the `(N+2)×100` per-account block, VPK P1363/P1364/P1465/P1466",
		'Grandstream P-code tables and the GXP/GRP administration guides — `P298` "Allow Auto Answer by Call-Info" (0 No / 1 Yes, default 0) and `P2356` "Custom Call-Info for Auto Answer"; the feature reads the Call-Info header and not Alert-Info',
	],
	caveats: [
		"String key modes are used specifically to avoid the VPK integer conflict: the GXP21xx table gives Line=0/SpeedDial=10/BLF=11 while the dynamic-VPK scale gives SpeedDial=0/BLF=1/Line=31. Which scale a GRP26xx uses for fixed line VPKs is UNVERIFIED and contradictory across Grandstream's own documents.",
		"Firmware predating the alias dialect understands only P-values and will ignore this document. A P-value template is a follow-up with its own template id, not a branch inside this one.",
		"`registerExpiration` is MINUTES (1–64800), converted and clamped from the line's seconds.",
		"A VPK's `account` is 0-indexed while account parameters are 1-indexed.",
		"Dynamic VPKs must be contiguous, so a key's slot is its position among configured keys rather than its `keyIndex` — unlike every other vendor in this catalogue.",
		"A non-default registrar port is written into `sip.server.1.address` as `host:port`; `sip.localPort` is the phone's own listener and is deliberately not used for it.",
		"This is the ONLY vendor in the catalogue that does not auto-answer on `Alert-Info`. Its feature reads `Call-Info` and matches `answer-after=0`, so an originator that sends only the Alert-Info header will page every other vendor and ring this one.",
		"UNVERIFIED: the two auto-answer parameters are written as the corroborated P-NAMES `P298` and `P2356` because their alias-dialect names could not be found in any Grandstream document. An unrecognised `<item name>` is expected to be dropped on its own rather than to invalidate the document, but that per-item behaviour has not been confirmed on hardware. Configure auto-answer in the phone's web UI, export the configuration, and read back the names it uses.",
		"Not validated against physical hardware.",
	],
};

export const grandstreamTransportWord = transportWord;
export const grandstreamKeyMode = keyMode;
