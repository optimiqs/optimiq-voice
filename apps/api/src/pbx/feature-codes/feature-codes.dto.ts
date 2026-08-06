import { z } from "zod/v4";
import { FEATURE_CODE_ACTIONS } from "@optimiq-voice/pbx-db";
import { patchOf } from "../shared/dto";
import type { FeatureCodeAction } from "@optimiq-voice/pbx-db";

/**
 * Star codes, and what each action is allowed to be parameterised with.
 *
 * ## Why `params` is not a free-form bag
 *
 * The column is `jsonb` and the schema's comment offers `{ "lotId": "…" }` as an example, so the
 * first version of this DTO accepted `Record<string, string | number | boolean>` and wrote whatever
 * arrived. That is a bag with two failure modes and no upside:
 *
 * 1. **A typo is silently accepted.** `{ "lot_id": "…" }` saves, compiles, and parks in a random
 *    orbit forever; nothing in the stack ever reads the key, so nothing ever complains.
 * 2. **A form cannot render it.** "Parameters" as a raw JSON textarea is what an admin UI puts on
 *    screen when the server declines to say what the field means — and the P4 wave asked for this
 *    specifically so the feature-code form could show a park-lot picker instead.
 *
 * So the accepted keys are declared **per action**, in {@link FEATURE_CODE_PARAM_SCHEMAS}, and the
 * list is derived from what `packages/routing` actually reads. Today that is exactly one key:
 * `call-park` may pin a lot with `params.lotId`, which the compiler resolves into a park node
 * (`compile.ts`, `featureCodeTarget`). Every other action takes no parameters — not "none yet, so
 * anything goes", but none: a key the compiler and the engine both ignore is dead configuration
 * that reads as a setting. Teaching an action a parameter means teaching `packages/routing` to read
 * it first, and then adding it here.
 *
 * ## What a PATCH may say about the pair
 *
 * `params` is only meaningful against an action — `{ lotId }` is valid for `call-park` and
 * meaningless for `redial` — so the two halves are not independent, and the PATCH rules follow from
 * that rather than from convenience:
 *
 * - **`params` without `action`** is refused. There is nothing to validate it against: the DTO
 *   cannot see the stored row, and accepting it would mean deferring the check into the write
 *   transaction where the 400 can no longer name a field.
 * - **`action` without `params`** clears the parameters. They described the action that is being
 *   replaced, so keeping them would leave a `redial` row carrying a `lotId` — configuration nobody
 *   wrote and nothing reads. This is also what the admin UI's feature-code form sends, and clearing
 *   is what it means by it.
 */

const featureCodeAction = z.enum(FEATURE_CODE_ACTIONS);

/** No parameters. `strictObject({})` refuses keys rather than dropping them, which is the point. */
const noParams = z.strictObject({});

/**
 * The accepted `params` shape per action.
 *
 * Exhaustive by construction: adding an action to `pbx-db` without deciding its parameters is a
 * TypeScript error here, the same guarantee `FEATURE_CODE_ARGUMENT_MODE` gives in
 * `packages/routing`.
 */
export const FEATURE_CODE_PARAM_SCHEMAS: Readonly<Record<FeatureCodeAction, z.ZodType>> = {
	"voicemail-check": noParams,
	"voicemail-direct": noParams,
	"voicemail-record-greeting": noParams,
	/** The one parameterised action: pin the orbit, or omit it and take any free slot. */
	"call-park": z.strictObject({ lotId: z.uuid().optional() }),
	"call-pickup": noParams,
	"group-pickup": noParams,
	"call-forward-all": noParams,
	"call-forward-busy": noParams,
	"call-forward-no-answer": noParams,
	"do-not-disturb": noParams,
	"follow-me": noParams,
	intercom: noParams,
	paging: noParams,
	"record-toggle": noParams,
	redial: noParams,
	"echo-test": noParams,
	"queue-toggle": noParams,
	"agent-status": noParams,
	eavesdrop: noParams,
	transfer: noParams,
};

/**
 * One parameter, described well enough for a form to render the right control.
 *
 * `entity` carries the destination type whose list populates the picker, which is the same
 * vocabulary `destinationType` uses — so the web app reuses the picker it already has rather than
 * learning a second way to choose a park lot.
 */
export interface FeatureCodeParamField {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly kind: "entity";
	readonly entityType: "park";
	readonly required: boolean;
}

/** The renderable description of every action's parameters, served at `GET …/param-fields`. */
export const FEATURE_CODE_PARAM_FIELDS: Readonly<
	Record<FeatureCodeAction, readonly FeatureCodeParamField[]>
> = {
	"voicemail-check": [],
	"voicemail-direct": [],
	"voicemail-record-greeting": [],
	"call-park": [
		{
			name: "lotId",
			label: "Park lot",
			description:
				"Which orbit this code parks into. Leave it empty to park in the first lot with a free slot.",
			kind: "entity",
			entityType: "park",
			required: false,
		},
	],
	"call-pickup": [],
	"group-pickup": [],
	"call-forward-all": [],
	"call-forward-busy": [],
	"call-forward-no-answer": [],
	"do-not-disturb": [],
	"follow-me": [],
	intercom: [],
	paging: [],
	"record-toggle": [],
	redial: [],
	"echo-test": [],
	"queue-toggle": [],
	"agent-status": [],
	eavesdrop: [],
	transfer: [],
};

/** Validates `params` against the action it was sent with, reporting at `params.<key>`. */
function checkParams(action: FeatureCodeAction, params: unknown, context: z.RefinementCtx): void {
	if (params === undefined || params === null) {
		return;
	}
	const result = FEATURE_CODE_PARAM_SCHEMAS[action].safeParse(params);
	if (result.success) {
		return;
	}
	for (const issue of result.error.issues) {
		if (issue.code === "unrecognized_keys") {
			// `unrecognized_keys` reports the offending names in `keys` and leaves `path` at the object
			// itself, so one issue per key is built here — otherwise every typo would land on
			// "params" and the form could not point at the control the user actually filled in.
			for (const key of issue.keys) {
				context.addIssue({
					code: "custom",
					path: ["params", key],
					message: `"${action}" takes no parameter called "${key}".`,
				});
			}
			continue;
		}
		context.addIssue({ code: "custom", path: ["params", ...issue.path], message: issue.message });
	}
}

const featureCodeShape = {
	/** Dialed string including the leading star, e.g. `*97`. */
	code: z
		.string()
		.min(2)
		.max(16)
		.regex(/^\*[0-9*#]+$/u, "must start with * and contain only digits, * or #"),
	/** Closed set, so the engine can switch on it exhaustively. */
	action: featureCodeAction,
	/**
	 * Whatever the action accepts, per {@link FEATURE_CODE_PARAM_SCHEMAS}. `null` clears it.
	 *
	 * Only `call-park` accepts anything today (`{ lotId }`); every other action rejects every key.
	 */
	params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullish(),
	label: z.string().max(128).nullish(),
	enabled: z.boolean().optional(),
};

export const createFeatureCodeDto = z
	.strictObject(featureCodeShape)
	.superRefine((value, context) => {
		checkParams(value.action, value.params, context);
	});

export const updateFeatureCodeDto = patchOf(z.strictObject(featureCodeShape))
	.superRefine((value, context) => {
		const patch = value as { action?: FeatureCodeAction; params?: unknown };
		if ("params" in patch && !("action" in patch)) {
			context.addIssue({
				code: "custom",
				path: ["action"],
				message:
					"Send the action alongside the parameters: parameters are only meaningful against one, " +
					"and the server will not guess which action these were written for.",
			});
			return;
		}
		if (patch.action !== undefined) {
			checkParams(patch.action, patch.params, context);
		}
	})
	.transform((value) => {
		const patch = { ...(value as Record<string, unknown>) };
		// Replacing the action retires whatever the old one was parameterised with.
		if ("action" in patch && !("params" in patch)) {
			patch.params = null;
		}
		return patch;
	});
