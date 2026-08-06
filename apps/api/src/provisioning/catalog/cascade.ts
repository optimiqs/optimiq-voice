import type { ProvisioningSettings } from "@optimiq-voice/pbx-db";

/**
 * The settings cascade, resolved.
 *
 * ## The four levels, and why there are exactly four
 *
 * `packages/pbx-db`'s `settings-schema.ts` states the shape of the general cascade and then says
 * what provisioning adds to it:
 *
 * > the resolution order is `code default → org_setting → user_setting`, and provisioning extends
 * > it with `device_profile.settings → device.settings`
 *
 * A device has no user, so `user_setting` does not apply — a phone on a shared desk belongs to an
 * organization and a profile, not to whoever last sat at it. That leaves:
 *
 * 1. **Model defaults** — code, in the vendor catalog. Versioned, typed, reviewable, and the only
 *    level that can carry a comment explaining why a value is what it is.
 * 2. **`org_setting`** where `category = 'provision'` — the tenant's deployment-wide policy: NTP
 *    server, time zone, log level, firmware URL.
 * 3. **`device_profile.settings`** — the reusable template a fleet of identical phones shares.
 * 4. **`device.settings`** — the one handset that is different.
 *
 * Each level overrides the one before it **by key**, never by merge: a value is a scalar and
 * "half-overriding" one has no meaning. Later wins.
 *
 * ## Why the levels are collapsed before a template ever runs
 *
 * A template that could ask "did this come from the profile or the device?" would eventually
 * branch on it, and then the same phone would render differently depending on where an
 * administrator happened to type a value that resolved identically. So `resolveSettings` returns
 * one flat record and the provenance is discarded — recoverable from `explainSettings` for the UI,
 * which is the only caller that has a legitimate reason to want it.
 */

export type SettingsLevel = "model" | "organization" | "profile" | "device";

/** The levels in resolution order. Later overrides earlier. */
export const SETTINGS_LEVELS: readonly SettingsLevel[] = [
	"model",
	"organization",
	"profile",
	"device",
];

export interface SettingsCascadeInput {
	readonly model?: ProvisioningSettings | null | undefined;
	readonly organization?: ProvisioningSettings | null | undefined;
	readonly profile?: ProvisioningSettings | null | undefined;
	readonly device?: ProvisioningSettings | null | undefined;
}

export function resolveSettings(input: SettingsCascadeInput): ProvisioningSettings {
	const resolved: Record<string, string | number | boolean> = {};
	for (const level of SETTINGS_LEVELS) {
		const source = input[level];
		if (source === null || source === undefined) {
			continue;
		}
		for (const [key, value] of Object.entries(source)) {
			// An explicit `null` at a level is not expressible — the column type is
			// `Record<string, string | number | boolean>` — so there is no "unset this" operation and a
			// level can only ever add or replace. That is deliberate: an override that could *remove* a
			// model default would let a profile produce a config missing a field the vendor requires,
			// with no way for the renderer to notice.
			resolved[key] = value;
		}
	}
	return resolved;
}

export interface SettingProvenance {
	readonly key: string;
	readonly value: string | number | boolean;
	readonly level: SettingsLevel;
	/** The values this one shadows, nearest first. Empty when nothing was overridden. */
	readonly overrides: readonly {
		readonly level: SettingsLevel;
		readonly value: string | number | boolean;
	}[];
}

/**
 * The same resolution, with the provenance kept.
 *
 * Exists for one caller: the UI panel that has to answer "why is this phone's time zone
 * Europe/London when I set Europe/Dublin on the profile?". Without it the cascade is a black box
 * and the only debugging technique is deleting things until the output changes.
 */
export function explainSettings(input: SettingsCascadeInput): readonly SettingProvenance[] {
	const seen = new Map<string, { level: SettingsLevel; value: string | number | boolean }[]>();
	for (const level of SETTINGS_LEVELS) {
		const source = input[level];
		if (source === null || source === undefined) {
			continue;
		}
		for (const [key, value] of Object.entries(source)) {
			const history = seen.get(key) ?? [];
			history.push({ level, value });
			seen.set(key, history);
		}
	}

	return [...seen.entries()]
		.map(([key, history]) => {
			// The last write wins, so the winner is the last entry and everything before it, reversed,
			// is what it shadows nearest-first.
			const winner = history[history.length - 1] as {
				level: SettingsLevel;
				value: string | number | boolean;
			};
			return {
				key,
				value: winner.value,
				level: winner.level,
				overrides: history.slice(0, -1).reverse(),
			};
		})
		.sort((a, b) => a.key.localeCompare(b.key));
}
