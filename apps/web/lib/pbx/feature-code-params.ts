/**
 * A feature code's `params`, as a form holds them.
 *
 * `feature_code.params` is a `jsonb` column, and the obvious admin UI for a `jsonb` column is a
 * textarea — which is what the server refused to make necessary. `GET /feature-codes/param-fields`
 * declares, per action, exactly which keys are accepted and what each one is: today `call-park`
 * takes `lotId`, an entity ref into the park-lot list, and every other action takes nothing at all.
 * Not "nothing yet, so anything goes" — nothing: a key the compiler and the engine both ignore is
 * dead configuration wearing the costume of a setting.
 *
 * So the form renders the declared controls and this module does the two conversions between them
 * and the wire. Both are pure, because the interesting part is not fetching the declaration — it is
 * that a control the user did not fill in must send `null` rather than `{}`, and that switching the
 * action must not carry the old action's keys across.
 */

import type {
	FeatureCodeAction,
	FeatureCodeParamField,
	FeatureCodeParamFields,
	FeatureCodeRow,
} from "./contracts";

/**
 * What one action accepts, tolerating a declaration that has not arrived — or that a caller without
 * `feature-codes.read` was refused.
 *
 * Rendering no controls is the right answer in both cases: a `call-park` code with no `lotId` parks
 * in the first lot with a free slot, which is a working configuration rather than a broken one.
 */
export function paramFieldsFor(
	fields: FeatureCodeParamFields | undefined,
	action: FeatureCodeAction,
): readonly FeatureCodeParamField[] {
	return fields?.[action] ?? [];
}

/**
 * The stored `params` as form state: one string per DECLARED field, and nothing else.
 *
 * Keys the declaration does not mention are dropped rather than carried. That is not tidiness — a
 * row can hold a key from before an action's parameters were narrowed, and echoing it back on the
 * next save would be the form re-asserting configuration the server would now reject.
 */
export function readParamValues(
	row: FeatureCodeRow | null,
	fields: readonly FeatureCodeParamField[],
): Record<string, string> {
	const values: Record<string, string> = {};
	for (const field of fields) {
		const stored = row?.params?.[field.name];
		values[field.name] = stored === undefined || stored === null ? "" : String(stored);
	}
	return values;
}

/**
 * The `params` value to send, given the declared fields and what the user chose.
 *
 * Returns `null` — never `{}` — when nothing is set. The two are not the same on the wire: `null`
 * clears the column, and an empty object reads back as a payload that exists and has no keys.
 * `null` is also what an action with no declared fields must send, which is how switching from
 * `call-park` to `redial` retires the `lotId` the old action was parameterised with.
 */
export function buildParamsBody(
	fields: readonly FeatureCodeParamField[],
	values: Readonly<Record<string, string>>,
): Record<string, string> | null {
	const params: Record<string, string> = {};
	for (const field of fields) {
		const value = values[field.name]?.trim() ?? "";
		if (value.length > 0) {
			params[field.name] = value;
		}
	}
	return Object.keys(params).length > 0 ? params : null;
}

/** Whether every required parameter of an action has been given a value. */
export function missingRequiredParam(
	fields: readonly FeatureCodeParamField[],
	values: Readonly<Record<string, string>>,
): FeatureCodeParamField | undefined {
	return fields.find((field) => field.required && (values[field.name]?.trim() ?? "") === "");
}
