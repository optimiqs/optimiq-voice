import { z } from "zod/v4";
import { SETTING_VALUE_TYPES } from "@optimiq-voice/pbx-db";
import { ROUTING_SETTINGS_CATEGORY } from "../routing/snapshot-loader";
import type { SettingValueType } from "@optimiq-voice/pbx-db";

/**
 * What `org_setting` is allowed to hold, declared in code.
 *
 * ## The table models a cascade, not a record
 *
 * `packages/pbx-db`'s `settings-schema.ts` states the design: platform defaults live in CODE, not
 * in a table, because "a default row nobody wrote is indistinguishable from a deliberate override,
 * and a code-owned default is versioned, typed and reviewable". The resolution order is
 * `code default → org_setting → user_setting`, and the row is `(category, name, jsonb value,
 * value_type)` — five columns that can express anything, which is exactly the problem this file
 * solves.
 *
 * A free-form `(category, name, value)` write endpoint has the failure mode `feature-codes.dto.ts`
 * records for its `params` bag, one level worse: a typo is accepted, saved, and read by nothing,
 * forever, while looking on screen exactly like a setting that works. So the settings this
 * platform actually reads are declared here — with a type, a default, and a sentence — and the
 * write path validates against the declaration.
 *
 * ## Uncatalogued rows are still writable, and that is deliberate
 *
 * The cascade is genuinely open-ended: `provision.repository.ts` reads whatever is in the
 * `provision` category and hands it to a device template, and a deployment's own tooling may keep
 * rows here that this codebase knows nothing about. Refusing those would turn a general-purpose
 * table into a closed enum and break a working feature.
 *
 * The rule is therefore: a **catalogued** `(category, name)` is validated against its schema and
 * its `valueType` is derived — a wrong-typed value is a 400, not a row nothing can read. An
 * **uncatalogued** pair is accepted with whatever `valueType` the caller declares. The API says
 * which is which through `GET /api/v1/org-settings/catalog`, so a form can render a checkbox for
 * the first and a JSON box for the second.
 */

export const NOTIFICATION_SETTINGS_CATEGORY = "notifications";

export interface SettingDescriptor {
	readonly category: string;
	/** camelCase, matching the names `readRoutingSettings` already reads. */
	readonly name: string;
	readonly valueType: SettingValueType;
	readonly label: string;
	readonly description: string;
	/** What a write must satisfy. Also what `GET …/categories/:category` coerces a row through. */
	readonly schema: z.ZodType;
	/** The platform default — the first level of the cascade, and why a tenant needs no rows. */
	readonly defaultValue: unknown;
}

function descriptor(input: SettingDescriptor): SettingDescriptor {
	return input;
}

/**
 * The notification settings — the org-level half of voicemail-to-email and anything else this
 * platform mails on a tenant's behalf.
 *
 * ## Why the org has a switch when the mailbox already has one
 *
 * `voicemail_box.email_mode` (`none` / `notify` / `attach`) is the per-mailbox decision and it
 * stays authoritative: a box set to `none` is never emailed regardless of what is here. This is
 * the ORGANIZATION's kill switch, and it exists because the two answer different questions. "Does
 * this mailbox want email?" is a user preference set on one row. "May this tenant send voicemail
 * content to external mailboxes at all?" is a policy — the answer changes for a whole organization
 * when its compliance posture changes, and expressing that as a bulk edit of every `voicemail_box`
 * row would be a migration rather than a setting, with no record of what the policy was.
 *
 * Both must be on. The org switch can only ever narrow.
 */
export const NOTIFICATION_SETTINGS: readonly SettingDescriptor[] = [
	descriptor({
		category: NOTIFICATION_SETTINGS_CATEGORY,
		name: "voicemailToEmailEnabled",
		valueType: "boolean",
		label: "Voicemail to email",
		description:
			"Send a message to a mailbox's email address when a caller leaves a voicemail. A " +
			"mailbox whose delivery mode is 'none' is never emailed regardless of this setting.",
		schema: z.boolean(),
		defaultValue: true,
	}),
	descriptor({
		category: NOTIFICATION_SETTINGS_CATEGORY,
		name: "voicemailToEmailIncludeLink",
		valueType: "boolean",
		label: "Include a playback link",
		description:
			"Include a signed, expiring link to the recording in the notification. The link carries " +
			"the message id inside the signature and expires within minutes.",
		schema: z.boolean(),
		defaultValue: true,
	}),
	descriptor({
		category: NOTIFICATION_SETTINGS_CATEGORY,
		name: "voicemailToEmailIncludeTranscription",
		valueType: "boolean",
		label: "Include the transcription",
		description:
			"Include the transcription in the notification when the mailbox has transcription " +
			"enabled and one is available.",
		schema: z.boolean(),
		defaultValue: true,
	}),
	descriptor({
		category: NOTIFICATION_SETTINGS_CATEGORY,
		name: "fromName",
		valueType: "string",
		label: "Notification from name",
		description:
			"The display name shown on notifications this organization sends. The envelope sender " +
			"address itself is platform configuration (MAIL_FROM) and is not settable per tenant.",
		schema: z.string().trim().min(1).max(128).nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: NOTIFICATION_SETTINGS_CATEGORY,
		name: "replyTo",
		valueType: "string",
		label: "Notification reply-to",
		description: "Where a reply to a notification goes. Leave empty to use the platform default.",
		schema: z.email().max(254).nullable(),
		defaultValue: null,
	}),
];

/**
 * The routing settings, restated as catalogue entries.
 *
 * The names and their meanings are `readRoutingSettings`'s — this adds nothing to what the
 * compiler reads and MUST NOT: a name here that the loader does not read is a setting a user can
 * save and no call will ever observe. They are catalogued so the same validated write path covers
 * them, because before this resource existed they had no write path at all.
 */
export const ROUTING_SETTINGS: readonly SettingDescriptor[] = [
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "defaultTimezone",
		valueType: "string",
		label: "Default time zone",
		description: "IANA zone a time condition falls back to when it does not carry one.",
		schema: z.string().trim().min(1).max(64),
		defaultValue: "UTC",
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "voicemailPrefix",
		valueType: "string",
		label: "Voicemail transfer prefix",
		description:
			"Dial prefix that sends a call straight to a mailbox's greeting, e.g. *99 + extension. " +
			"Empty disables the internal voicemail-prefix table.",
		schema: z.string().trim().min(1).max(16).nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "voicemailCheckPrefix",
		valueType: "string",
		label: "Voicemail check prefix",
		description: "Prefix that logs a caller into their own mailbox, e.g. *98 + mailbox number.",
		schema: z.string().trim().min(1).max(16).nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "outboundCallerIdNumber",
		valueType: "string",
		label: "Organization outbound caller id",
		description:
			"Used when neither the outbound route nor the extension supplies a caller id number.",
		schema: z
			.string()
			.trim()
			.regex(/^\+[1-9]\d{1,18}$/u, "must be E.164, e.g. +12125550100")
			.nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "outboundCallerIdName",
		valueType: "string",
		label: "Organization outbound caller name",
		description: "Display name presented outbound when nothing more specific supplies one.",
		schema: z.string().trim().min(1).max(64).nullable(),
		defaultValue: null,
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "outboundEnabled",
		valueType: "boolean",
		label: "Outbound calling",
		description: "Organization-wide kill switch for reaching outbound routes at all.",
		schema: z.boolean(),
		defaultValue: true,
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "trunkContinueOnCauses",
		valueType: "array",
		label: "Retryable hangup causes",
		description:
			"Hangup causes that let an outbound dial continue to the next trunk. Never 'all causes' " +
			"— retrying a CALL_REJECTED on every trunk is how toll-fraud loops start.",
		schema: z.array(z.string().trim().min(1).max(64)).max(32),
		defaultValue: [],
	}),
	descriptor({
		category: ROUTING_SETTINGS_CATEGORY,
		name: "emergencyNumbers",
		valueType: "array",
		label: "Additional emergency numbers",
		description:
			"Emergency dial strings recognised in addition to the compiled-in NANP set. Additive " +
			"only: no setting can remove 911.",
		schema: z.array(z.string().trim().min(1).max(16)).max(32),
		defaultValue: [],
	}),
];

/** Every catalogued setting, in one list. */
export const SETTING_CATALOG: readonly SettingDescriptor[] = [
	...NOTIFICATION_SETTINGS,
	...ROUTING_SETTINGS,
];

const BY_KEY = new Map(SETTING_CATALOG.map((entry) => [`${entry.category} ${entry.name}`, entry]));

/** The catalogued categories, in catalogue order. */
export const CATALOGUED_CATEGORIES: readonly string[] = [
	...new Set(SETTING_CATALOG.map((entry) => entry.category)),
];

export function findSetting(category: string, name: string): SettingDescriptor | undefined {
	return BY_KEY.get(`${category} ${name}`);
}

export function settingsInCategory(category: string): readonly SettingDescriptor[] {
	return SETTING_CATALOG.filter((entry) => entry.category === category);
}

/** Whether a string is one of the five `value_type` values the column accepts. */
export function isSettingValueType(value: string): value is SettingValueType {
	return (SETTING_VALUE_TYPES as readonly string[]).includes(value);
}

/**
 * The effective value of every setting in a category: the code default, overlaid by the rows.
 *
 * A DISABLED row is treated as absent, which is what the cascade means by `enabled` and what
 * `readRoutingSettings` already does — one rule, stated once, so "why is my setting not taking
 * effect?" has the same answer everywhere.
 *
 * A row whose stored value no longer satisfies its schema (the catalogue tightened, or the row
 * predates it) falls back to the default rather than propagating a value the reader cannot use.
 * Pure, so this is directly testable without a database.
 */
export function resolveCategory(
	category: string,
	rows: readonly {
		readonly name: string;
		readonly value: unknown;
		readonly enabled: boolean;
	}[],
): Record<string, unknown> {
	const stored = new Map(rows.filter((row) => row.enabled).map((row) => [row.name, row.value]));
	const resolved: Record<string, unknown> = {};
	for (const entry of settingsInCategory(category)) {
		if (!stored.has(entry.name)) {
			resolved[entry.name] = entry.defaultValue;
			continue;
		}
		const parsed = entry.schema.safeParse(stored.get(entry.name));
		resolved[entry.name] = parsed.success ? parsed.data : entry.defaultValue;
	}
	return resolved;
}

/** The catalogue as a client reads it: no zod, one entry per setting. */
export interface WireSettingDescriptor {
	readonly category: string;
	readonly name: string;
	readonly valueType: SettingValueType;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: unknown;
}

export function toWireCatalog(): readonly WireSettingDescriptor[] {
	return SETTING_CATALOG.map((entry) => ({
		category: entry.category,
		name: entry.name,
		valueType: entry.valueType,
		label: entry.label,
		description: entry.description,
		defaultValue: entry.defaultValue,
	}));
}
