import { featureCode } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Star codes.
 *
 * Feature codes are matched first in the `internal` context, longest code first, because they
 * start with `*` and no internal number may. Two codes claiming the same string — or one being a
 * prefix of another — is a compile *error* (`conflicting-feature-code`), so the CRUD layer does
 * not need to police prefixes itself: the recompile inside the write transaction refuses the save
 * and names both codes.
 */
export const FEATURE_CODE_RESOURCE: PbxResource = {
	kind: "feature-code",
	tableName: "feature_code",
	table: featureCode,
	searchColumns: [featureCode.code, featureCode.label],
	orderBy: [featureCode.code, featureCode.id],
	enabledColumn: featureCode.enabled,
	destinations: [],
	destinationType: null,
};
