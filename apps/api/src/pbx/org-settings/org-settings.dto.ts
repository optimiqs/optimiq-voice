import { z } from "zod/v4";
import { SETTING_VALUE_TYPES } from "@optimiq-voice/pbx-db";
import { patchOf } from "../shared/dto";
import { findSetting } from "./org-settings.catalog";

/**
 * The settings DTOs.
 *
 * ## Two shapes, because the table has two kinds of row
 *
 * {@link createOrgSettingDto} / {@link updateOrgSettingDto} are the RAW form — one row, addressed
 * by its id, with the caller stating `category`, `name`, `value` and `valueType`. That is the
 * shape an operator tool and the uncatalogued categories (`provision`, `sip`) need.
 *
 * {@link categoryPatchDto} is the shape a settings SCREEN sends: a partial object of
 * `{ [name]: value }` for one category, upserted as a unit. It carries no ids, because a form
 * whose fields are settings does not know whether each one has a row yet — and making it find out
 * first would turn one save into N GETs and a race.
 *
 * ## The catalogue is what validates a value
 *
 * `parseCategoryPatch` is a function rather than a static schema because the accepted keys and
 * their types are per category and live in `org-settings.catalog.ts`. Every catalogued key is
 * validated against its own schema; an uncatalogued key in a catalogued category is REFUSED, which
 * is the one place this resource is closed rather than open: a category the platform declares is a
 * category whose names the platform reads, and accepting a name it does not read would save
 * configuration nothing can ever observe.
 */

/** `null` is a legitimate stored value (a cleared caller id), so the column is nullable JSON. */
const settingValue = z.json().nullable();

export const createOrgSettingDto = z.strictObject({
	category: z.string().trim().min(1).max(64),
	name: z.string().trim().min(1).max(128),
	value: settingValue,
	valueType: z.enum(SETTING_VALUE_TYPES).optional(),
	description: z.string().trim().max(512).nullish(),
	enabled: z.boolean().optional(),
});

export type CreateOrgSetting = z.infer<typeof createOrgSettingDto>;

/**
 * A raw PATCH.
 *
 * `category` and `name` are deliberately NOT patchable: they are the row's identity — the unique
 * index is `(organization_id, category, name)` — and renaming a setting in place would silently
 * move a value from a name something reads to a name nothing does. Delete and recreate is the
 * honest spelling, and it leaves the intent in the audit trail.
 */
export const updateOrgSettingDto = patchOf(
	z.strictObject({
		value: settingValue,
		valueType: z.enum(SETTING_VALUE_TYPES),
		description: z.string().trim().max(512).nullish(),
		enabled: z.boolean(),
	}),
);

export type UpdateOrgSetting = z.infer<typeof updateOrgSettingDto>;

/** A category upsert: `{ voicemailToEmailEnabled: false, fromName: "Support" }`. */
export const categoryPatchDto = z.record(z.string().trim().min(1).max(128), z.json().nullable());

export type CategoryPatch = z.infer<typeof categoryPatchDto>;

export interface CategoryPatchIssue {
	readonly field: string;
	readonly code: string;
	readonly message: string;
}

/**
 * A string discriminant rather than `ok: true | false`.
 *
 * `apps/api`'s tooling tsconfig still relaxes `strictNullChecks` for its ~180 legacy files, and
 * without it TypeScript does not narrow a union on a boolean literal member — `if (!result.ok)`
 * compiles but leaves the type un-narrowed, so `result.issues` is an error at the one place the
 * union exists to make safe. A string tag narrows under either setting.
 */
export type CategoryPatchResult =
	| { readonly outcome: "valid"; readonly values: ReadonlyMap<string, unknown> }
	| { readonly outcome: "invalid"; readonly issues: readonly CategoryPatchIssue[] };

/**
 * Validates one category's patch against the catalogue.
 *
 * Returns every issue rather than throwing on the first, so a form can attach a message to each
 * offending input in one round trip — the same contract `parseDto` gives for a body.
 */
export function parseCategoryPatch(category: string, patch: CategoryPatch): CategoryPatchResult {
	const issues: CategoryPatchIssue[] = [];
	const values = new Map<string, unknown>();

	for (const [name, raw] of Object.entries(patch)) {
		const descriptor = findSetting(category, name);
		if (descriptor === undefined) {
			issues.push({
				field: name,
				code: "unrecognized_keys",
				message: `"${name}" is not a setting in the "${category}" category`,
			});
			continue;
		}
		const parsed = descriptor.schema.safeParse(raw);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				issues.push({
					field: issue.path.length === 0 ? name : `${name}.${issue.path.join(".")}`,
					code: issue.code,
					message: issue.message,
				});
			}
			continue;
		}
		values.set(name, parsed.data);
	}

	return issues.length > 0 ? { outcome: "invalid", issues } : { outcome: "valid", values };
}
