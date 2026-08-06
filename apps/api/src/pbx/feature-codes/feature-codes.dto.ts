import { z } from "zod/v4";
import { FEATURE_CODE_ACTIONS } from "@optimiq-voice/pbx-db";
import { patchOf } from "../shared/dto";

export const createFeatureCodeDto = z.strictObject({
	/** Dialed string including the leading star, e.g. `*97`. */
	code: z
		.string()
		.min(2)
		.max(16)
		.regex(/^\*[0-9*#]+$/u, "must start with * and contain only digits, * or #"),
	/** Closed set, so the engine can switch on it exhaustively. */
	action: z.enum(FEATURE_CODE_ACTIONS),
	/** Whatever the action needs, e.g. `{ "lotId": "…" }` for `call-park`. */
	params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullish(),
	label: z.string().max(128).nullish(),
	enabled: z.boolean().optional(),
});

export const updateFeatureCodeDto = patchOf(createFeatureCodeDto);
