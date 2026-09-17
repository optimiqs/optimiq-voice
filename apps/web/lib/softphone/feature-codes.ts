/**
 * Which feature codes this organization actually has, for the controls that dial one.
 *
 * The softphone's DND and park buttons are not features of their own — they DIAL a code the
 * organization configured (`feature_code`, compiled into the routing artifact the engine walks).
 * There is no platform default: `*76` is a convention, not a contract, and hardcoding one would
 * produce a button that dials into the dial plan's "no match" branch on every deployment that
 * chose different digits.
 *
 * So the codes are read from `GET /api/v1/feature-codes` and a control that has no code behind it
 * is not rendered. Disabled rows count as absent for the same reason: the engine will not route
 * them either.
 */

import type { FeatureCodeAction, FeatureCodeRow } from "../pbx/contracts";

/** The actions the softphone offers a button for. */
export const SOFTPHONE_FEATURE_ACTIONS = ["do-not-disturb", "call-park", "call-pickup"] as const;

export type SoftphoneFeatureAction = (typeof SOFTPHONE_FEATURE_ACTIONS)[number];

export type SoftphoneFeatureCodes = Readonly<Record<SoftphoneFeatureAction, string | null>>;

export const NO_FEATURE_CODES: SoftphoneFeatureCodes = {
	"do-not-disturb": null,
	"call-park": null,
	"call-pickup": null,
};

/**
 * Index the rows the softphone cares about, in one pass.
 *
 * Ties go to the FIRST enabled row in the list the API returned, which is its own deterministic
 * order. Two enabled codes for one action is a configuration the admin surface allows and the
 * engine resolves by dial-plan match; picking either here is honest, picking a different one on
 * every render is not — hence first-wins rather than last-wins.
 */
export function softphoneFeatureCodes(
	rows: readonly FeatureCodeRow[] | undefined,
): SoftphoneFeatureCodes {
	if (!rows || rows.length === 0) {
		return NO_FEATURE_CODES;
	}
	const wanted = new Set<string>(SOFTPHONE_FEATURE_ACTIONS);
	const found = new Map<FeatureCodeAction, string>();
	for (const row of rows) {
		if (!row.enabled || !wanted.has(row.action) || found.has(row.action)) {
			continue;
		}
		const code = row.code.trim();
		if (code.length > 0) {
			found.set(row.action, code);
		}
	}
	return {
		"do-not-disturb": found.get("do-not-disturb") ?? null,
		"call-park": found.get("call-park") ?? null,
		"call-pickup": found.get("call-pickup") ?? null,
	};
}
