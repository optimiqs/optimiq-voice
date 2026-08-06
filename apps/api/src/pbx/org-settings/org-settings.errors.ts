import { HttpException, HttpStatus } from "@nestjs/common";
import { CATALOGUED_CATEGORIES } from "./org-settings.catalog";
import type { CategoryPatchIssue } from "./org-settings.dto";

/**
 * The category facade's HTTP errors.
 *
 * Plain `HttpException`s in the shape the rest of the PBX area uses — `statusCode`, a `code` a
 * client can switch on, a sentence, and per-field `issues` where there are any — so `apps/web`'s
 * error reader needs no special case. The raw CRUD half of this resource goes through the Effect
 * repository and raises the area's typed failures; only the two operations that exist ABOVE the
 * repository (resolve a category, upsert a category) need errors of their own.
 */

/**
 * A category the platform does not declare.
 *
 * A 404 rather than an empty object: `GET /categories/notifcations` returning `{}` would look
 * exactly like a category with nothing set, and the caller would render a settings screen with no
 * settings on it and no way to tell why.
 */
export class UnknownSettingCategoryException extends HttpException {
	constructor(category: string) {
		super(
			{
				statusCode: HttpStatus.NOT_FOUND,
				code: "SETTING_CATEGORY_UNKNOWN",
				message:
					`"${category}" is not a catalogued settings category. Known categories: ` +
					`${CATALOGUED_CATEGORIES.join(", ")}. Uncatalogued settings are written one row ` +
					"at a time through POST /api/v1/org-settings.",
				category,
				known: CATALOGUED_CATEGORIES,
			},
			HttpStatus.NOT_FOUND,
		);
	}
}

/** A patch whose keys or values the catalogue refuses. Carries every issue, not just the first. */
export class InvalidSettingPatchException extends HttpException {
	constructor(category: string, issues: readonly CategoryPatchIssue[]) {
		super(
			{
				statusCode: HttpStatus.BAD_REQUEST,
				code: "SETTING_PATCH_INVALID",
				message: issues.map((issue) => `${issue.field}: ${issue.message}`).join("; "),
				category,
				issues,
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}
