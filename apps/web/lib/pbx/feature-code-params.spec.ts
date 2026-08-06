import { describe, expect, it } from "bun:test";
import { FEATURE_CODE_ACTIONS } from "./contracts";
import {
	buildParamsBody,
	missingRequiredParam,
	paramFieldsFor,
	readParamValues,
} from "./feature-code-params";
import type { FeatureCodeParamField, FeatureCodeParamFields, FeatureCodeRow } from "./contracts";

/**
 * `contracts.spec.ts` pins the mirrored closed sets by importing the real package. This file cannot
 * do the same: `FEATURE_CODE_PARAM_FIELDS` lives in `apps/api`, which is a Nest application rather
 * than a workspace package, and reaching into it by relative path would make a frontend unit test
 * fail whenever a backend file moves.
 *
 * So the declaration is fixtured here, and the live one is checked where it can be checked properly
 * — `scripts/smoke-pbx.ts` calls `GET /feature-codes/param-fields` against the running API and
 * asserts the shape these functions are written against. What is tested HERE is the conversion, and
 * specifically the two things that are easy to get quietly wrong: an untouched control must send
 * `null` rather than `{}`, and switching the action must not carry the old action's keys across.
 */

const DECLARATION = {
	...(Object.fromEntries(
		FEATURE_CODE_ACTIONS.map((action) => [action, [] as readonly FeatureCodeParamField[]]),
	) as FeatureCodeParamFields),
	"call-park": [
		{
			name: "lotId",
			label: "Park lot",
			description:
				"Which orbit this code parks into. Leave it empty to park in the first lot with a free slot.",
			kind: "entity",
			entityType: "park",
			/** Optional: a code with no lot parks in the first one with a free slot. */
			required: false,
		},
	] as readonly FeatureCodeParamField[],
} as FeatureCodeParamFields;

function row(params: FeatureCodeRow["params"]): FeatureCodeRow {
	return {
		id: "0193f2aa-0000-7000-8000-000000000001",
		organizationId: "0193f2aa-0000-7000-8000-0000000000ff",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		code: "*5",
		action: "call-park",
		params,
		label: "Park a call",
		enabled: true,
	};
}

describe("paramFieldsFor", () => {
	it("returns what the declaration says an action accepts", () => {
		expect(paramFieldsFor(DECLARATION, "call-park").map((field) => field.name)).toEqual(["lotId"]);
		expect(paramFieldsFor(DECLARATION, "redial")).toEqual([]);
	});

	/**
	 * The declaration is fetched, and the fetch can be pending — or forbidden, for a caller without
	 * `feature-codes.read`. Rendering no controls is right in both cases; throwing would take the
	 * whole dialog down over a parameter that is optional anyway.
	 */
	it("survives a declaration that has not arrived", () => {
		expect(paramFieldsFor(undefined, "call-park")).toEqual([]);
	});
});

describe("readParamValues", () => {
	const fields = paramFieldsFor(DECLARATION, "call-park");

	it("reads a stored value into form state as a string", () => {
		const values = readParamValues(row({ lotId: "0193f2aa-0000-7000-8000-00000000000a" }), fields);
		expect(values.lotId).toBe("0193f2aa-0000-7000-8000-00000000000a");
	});

	it("gives a new code an empty control rather than an absent one", () => {
		expect(readParamValues(null, fields)).toEqual({ lotId: "" });
		expect(readParamValues(row(null), fields)).toEqual({ lotId: "" });
	});

	/**
	 * A row can hold a key from before an action's parameters were narrowed. Echoing it back on the
	 * next save would be the form re-asserting configuration the server would now reject — and the
	 * 400 would name a control the user never saw.
	 */
	it("drops a stored key the declaration does not mention", () => {
		const values = readParamValues(row({ lotId: "abc", legacyOrbit: "701" }), fields);
		expect(values).toEqual({ lotId: "abc" });
	});

	/** `jsonb` may hold a number or a boolean; a control holds a string. */
	it("stringifies a non-string stored value", () => {
		expect(readParamValues(row({ lotId: 701 }), fields).lotId).toBe("701");
	});
});

describe("buildParamsBody", () => {
	const fields = paramFieldsFor(DECLARATION, "call-park");

	it("sends the keys the user filled in", () => {
		expect(buildParamsBody(fields, { lotId: "0193f2aa-0000" })).toEqual({ lotId: "0193f2aa-0000" });
	});

	/**
	 * `null`, never `{}`. The two are not the same on the wire: `null` clears the column, and an
	 * empty object reads back as a payload that exists and has no keys.
	 */
	it("collapses an untouched form to null rather than to an empty object", () => {
		expect(buildParamsBody(fields, { lotId: "" })).toBeNull();
		expect(buildParamsBody(fields, { lotId: "   " })).toBeNull();
		expect(buildParamsBody(fields, {})).toBeNull();
	});

	/**
	 * How switching the action retires the old one's parameters: an action with no declared fields
	 * builds `null`, which is exactly what the server means by "the action replaced the parameters".
	 * Without this, a code moved from `call-park` to `redial` would carry a `lotId` the server
	 * rejects with `"redial" takes no parameter called "lotId"`.
	 */
	it("sends null for an action that declares no parameters, even with stale values in state", () => {
		const none = paramFieldsFor(DECLARATION, "redial");
		expect(buildParamsBody(none, { lotId: "0193f2aa-0000" })).toBeNull();
	});
});

describe("missingRequiredParam", () => {
	const required: readonly FeatureCodeParamField[] = [
		{
			name: "lotId",
			label: "Park lot",
			description: "Which orbit.",
			kind: "entity",
			entityType: "park",
			required: true,
		},
	];

	it("names the field so the message can quote its label", () => {
		expect(missingRequiredParam(required, { lotId: "" })?.label).toBe("Park lot");
		expect(missingRequiredParam(required, { lotId: "abc" })).toBeUndefined();
	});

	/** Nothing is required in the declaration as it stands, so it never blocks a save today. */
	it("never blocks on an optional parameter", () => {
		for (const action of FEATURE_CODE_ACTIONS) {
			expect(missingRequiredParam(paramFieldsFor(DECLARATION, action), {})).toBeUndefined();
		}
	});
});
