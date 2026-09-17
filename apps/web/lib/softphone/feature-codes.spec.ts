import { describe, expect, it } from "bun:test";
import { NO_FEATURE_CODES, softphoneFeatureCodes } from "./feature-codes";
import type { FeatureCodeRow } from "../pbx/contracts";

/**
 * The lookup behind the DND and park buttons.
 *
 * These assertions exist because the alternative — a hardcoded `*76` — produces a button that
 * dials into the dial plan's no-match branch on every deployment that chose different digits, and
 * looks like a platform bug rather than a configuration one.
 */
function row(overrides: Partial<FeatureCodeRow> = {}): FeatureCodeRow {
	return {
		id: "fc-1",
		organizationId: "org-1",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		code: "*76",
		action: "do-not-disturb",
		params: null,
		label: null,
		enabled: true,
		...overrides,
	};
}

describe("softphoneFeatureCodes", () => {
	it("reads the organization's own digits rather than a convention", () => {
		const codes = softphoneFeatureCodes([
			row({ code: "#22", action: "do-not-disturb" }),
			row({ id: "fc-2", code: "700", action: "call-park" }),
		]);
		expect(codes["do-not-disturb"]).toBe("#22");
		expect(codes["call-park"]).toBe("700");
		expect(codes["call-pickup"]).toBeNull();
	});

	it("treats a disabled code as absent, because the engine will not route it either", () => {
		expect(softphoneFeatureCodes([row({ enabled: false })])["do-not-disturb"]).toBeNull();
	});

	it("ignores actions the softphone has no control for", () => {
		expect(softphoneFeatureCodes([row({ code: "*97", action: "voicemail-check" })])).toEqual(
			NO_FEATURE_CODES,
		);
	});

	it("takes the first enabled row when an action has several, deterministically", () => {
		const codes = softphoneFeatureCodes([row({ code: "*76" }), row({ id: "fc-2", code: "#22" })]);
		expect(codes["do-not-disturb"]).toBe("*76");
	});

	it("answers with nothing at all when the list is missing or the caller was refused it", () => {
		expect(softphoneFeatureCodes(undefined)).toEqual(NO_FEATURE_CODES);
		expect(softphoneFeatureCodes([])).toEqual(NO_FEATURE_CODES);
	});
});
