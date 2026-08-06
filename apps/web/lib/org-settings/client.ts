import { apiFetch } from "../api-client";

/**
 * The organization settings cascade — `/api/v1/org-settings`.
 *
 * ## Why this is not a `PBX_RESOURCES` descriptor
 *
 * The generic machinery in `lib/pbx/client.ts` is paged-list CRUD addressed by row id, and that is
 * the wrong shape for a settings SCREEN. A settings form does not know whether each of its fields
 * already has a row — the cascade's whole point is that an unset setting has no row at all — so
 * saving through `PATCH /path/:id` would mean a GET per field to find out, and a race with anyone
 * else saving the same form.
 *
 * The API answers that with a category facade: `GET …/categories/:category` returns every setting
 * in the category already resolved through `code default → org_setting`, and
 * `PATCH …/categories/:category` upserts a partial `{ name: value }` object as a unit. Two calls,
 * no ids, and hand-written like `lib/carrier/client.ts` for the same reason it is.
 *
 * The raw row CRUD still exists on the same prefix for operator tooling; nothing in `apps/web`
 * needs it yet, so nothing here mirrors it.
 */

/** Mirrors `SETTING_VALUE_TYPES` in `packages/pbx-db`. Restated, not imported — see `lib/pbx/contracts.ts`. */
export const SETTING_VALUE_TYPES = ["string", "number", "boolean", "json", "array"] as const;
export type SettingValueType = (typeof SETTING_VALUE_TYPES)[number];

/** One entry of `GET /org-settings/catalog` — what exists, what type it is, what the default is. */
export interface SettingDescriptor {
	readonly category: string;
	readonly name: string;
	readonly valueType: SettingValueType;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: unknown;
}

export interface SettingCategoryEnvelope {
	readonly category: string;
	readonly data: Record<string, unknown>;
}

export interface SettingCategoryMutation extends SettingCategoryEnvelope {
	/** The names that actually reached a row, so a caller can say what it saved. */
	readonly written: readonly string[];
}

/**
 * The notification settings, typed.
 *
 * The names are the API catalogue's (`org-settings.catalog.ts`), and the shape is restated here
 * rather than derived, on the same terms as every other contract mirror in `lib/`: importing the
 * server's zod schemas would drag `zod/v4`, `@nestjs/common` and `@optimiq-voice/pbx-db` into the
 * browser bundle.
 */
export interface NotificationSettings {
	readonly voicemailToEmailEnabled: boolean;
	readonly voicemailToEmailIncludeLink: boolean;
	readonly voicemailToEmailIncludeTranscription: boolean;
	readonly fromName: string | null;
	readonly replyTo: string | null;
}

export const NOTIFICATIONS_CATEGORY = "notifications";

export async function fetchSettingCatalog(): Promise<readonly SettingDescriptor[]> {
	const { data } = await apiFetch<{ data: readonly SettingDescriptor[] }>("/org-settings/catalog");
	return data;
}

export async function fetchSettingCategory(category: string): Promise<SettingCategoryEnvelope> {
	return await apiFetch<SettingCategoryEnvelope>(
		`/org-settings/categories/${encodeURIComponent(category)}`,
	);
}

export async function patchSettingCategory(
	category: string,
	patch: Readonly<Record<string, unknown>>,
): Promise<SettingCategoryMutation> {
	return await apiFetch<SettingCategoryMutation>(
		`/org-settings/categories/${encodeURIComponent(category)}`,
		{ method: "PATCH", body: JSON.stringify(patch) },
	);
}

/**
 * Narrows the category's untyped answer to {@link NotificationSettings}.
 *
 * Every catalogued name is always present in the response — the API guarantees it, because a key
 * missing from a settings payload is indistinguishable from one whose value is `undefined`, and a
 * form binding to the second renders an uncontrolled input. The fallbacks here are therefore
 * belt-and-braces against a version skew, not an expected path, and they repeat the API's own
 * defaults rather than inventing new ones.
 */
export function toNotificationSettings(data: Record<string, unknown>): NotificationSettings {
	return {
		voicemailToEmailEnabled: data.voicemailToEmailEnabled !== false,
		voicemailToEmailIncludeLink: data.voicemailToEmailIncludeLink !== false,
		voicemailToEmailIncludeTranscription: data.voicemailToEmailIncludeTranscription !== false,
		fromName: typeof data.fromName === "string" ? data.fromName : null,
		replyTo: typeof data.replyTo === "string" ? data.replyTo : null,
	};
}
