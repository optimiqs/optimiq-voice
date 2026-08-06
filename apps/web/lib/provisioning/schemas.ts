/**
 * Form schemas for the device screens, mirroring `apps/api/src/provisioning/**\/*.dto.ts`.
 *
 * Same trade as `lib/pbx/schemas.ts`: the server is the authority, and these exist so the common
 * mistakes are caught before a round trip. The MAC is the interesting one — it is normalized here
 * as well as on the server, so the field can show an administrator what will actually be stored
 * while they are still looking at the sticker they copied it from.
 */

import { z } from "zod";
import {
	DEVICE_KEY_CATEGORIES,
	DEVICE_KEY_TYPES,
	DEVICE_VENDORS,
	normalizeMacAddress,
} from "./contracts";

/** Any spelling in, the stored form out. */
export const macAddressField = z
	.string()
	.trim()
	.min(1, "Required")
	.transform((value, ctx) => {
		const normalized = normalizeMacAddress(value);
		if (normalized === undefined) {
			ctx.addIssue({
				code: "custom",
				message: "12 hex digits, with or without separators (e.g. 00:15:65:AB:CD:EF)",
			});
			return z.NEVER;
		}
		return normalized;
	});

function optionalText(max: number) {
	return z
		.string()
		.trim()
		.max(max, `At most ${max} characters`)
		.transform((value) => (value.length === 0 ? null : value));
}

/**
 * The settings bag, edited as `key = value` lines rather than as JSON.
 *
 * An administrator pasting vendor parameters out of a Yealink guide has `key = value` lines in their
 * clipboard, not a JSON object — asking them to quote and brace it is asking them to introduce a
 * syntax error into a field whose whole purpose is a quick override. Blank lines and `#` comments
 * are skipped so a pasted block from the documentation works verbatim.
 *
 * Values stay STRINGS. Guessing that `1` means the number one rather than the string "1" would be
 * wrong for the several vendors whose parameters are ordinal codes, and the renderer writes both
 * identically anyway.
 */
export const settingsTextField = z
	.string()
	.max(8192, "At most 8192 characters")
	.transform((value, ctx) => {
		const settings: Record<string, string> = {};
		for (const [index, rawLine] of value.split("\n").entries()) {
			const line = rawLine.trim();
			if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
				continue;
			}
			const separator = line.search(/[=:]/u);
			if (separator <= 0) {
				ctx.addIssue({
					code: "custom",
					message: `Line ${index + 1} is not "key = value"`,
				});
				return z.NEVER;
			}
			const key = line.slice(0, separator).trim();
			// Spaces are allowed because Fanvil's parameter names contain them (`SIP1 Register TTL`).
			// What is never allowed is a character that would break out of a config's syntax — the
			// server applies the stricter filter again for the XML formats, per `catalog/format.ts`.
			if (!/^[A-Za-z0-9._[\] -]+$/u.test(key)) {
				ctx.addIssue({ code: "custom", message: `Line ${index + 1} has an unusable key` });
				return z.NEVER;
			}
			settings[key] = line.slice(separator + 1).trim();
		}
		return settings;
	});

/** The inverse, for populating the textarea from a stored bag. Sorted, like the renderer's output. */
export function settingsToText(
	settings: Readonly<Record<string, unknown>> | null | undefined,
): string {
	if (!settings) {
		return "";
	}
	return Object.entries(settings)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key} = ${String(value)}`)
		.join("\n");
}

export const deviceFormSchema = z.object({
	macAddress: macAddressField,
	vendor: z.enum(DEVICE_VENDORS),
	model: optionalText(64),
	label: optionalText(128),
	deviceProfileId: z.string().transform((value) => (value.length === 0 ? null : value)),
	settings: settingsTextField,
	enabled: z.boolean(),
});

export type DeviceFormValues = z.input<typeof deviceFormSchema>;

export const deviceProfileFormSchema = z.object({
	name: z.string().trim().min(1, "Required").max(128, "At most 128 characters"),
	description: optionalText(512),
	vendor: z.enum(DEVICE_VENDORS),
	model: optionalText(64),
	settings: settingsTextField,
	enabled: z.boolean(),
});

export type DeviceProfileFormValues = z.input<typeof deviceProfileFormSchema>;

export const deviceLineFormSchema = z.object({
	lineNumber: z
		.string()
		.trim()
		.min(1, "Required")
		.transform((value) => Number(value))
		.refine((value) => Number.isInteger(value) && value >= 1 && value <= 64, "Between 1 and 64"),
	extensionId: z.string().transform((value) => (value.length === 0 ? null : value)),
	label: optionalText(128),
	sharedLine: z.boolean(),
	enabled: z.boolean(),
});

export type DeviceLineFormValues = z.input<typeof deviceLineFormSchema>;

export const deviceKeyFormSchema = z.object({
	category: z.enum(DEVICE_KEY_CATEGORIES),
	keyIndex: z
		.string()
		.trim()
		.min(1, "Required")
		.transform((value) => Number(value))
		.refine((value) => Number.isInteger(value) && value >= 1 && value <= 256, "Between 1 and 256"),
	keyType: z.enum(DEVICE_KEY_TYPES),
	value: optionalText(256),
	label: optionalText(64),
	lineNumber: z
		.string()
		.trim()
		.min(1, "Required")
		.transform((value) => Number(value))
		.refine((value) => Number.isInteger(value) && value >= 1 && value <= 64, "Between 1 and 64"),
});

export type DeviceKeyFormValues = z.input<typeof deviceKeyFormSchema>;
