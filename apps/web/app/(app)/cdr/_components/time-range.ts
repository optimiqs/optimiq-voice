"use client";

import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useMemo } from "react";
import { RANGE_PRESETS, resolveRange, type RangePreset } from "~/lib/cdr/time-range";

export { RANGE_PRESET_LABELS, RANGE_PRESETS, toLocalInputValue } from "~/lib/cdr/time-range";
export type { RangePreset } from "~/lib/cdr/time-range";

/**
 * The time window, held in the URL.
 *
 * ## Why presets AND a custom pair
 *
 * Ninety-five per cent of the time the question is "what happened today" or "what happened this
 * week", and making someone pick two datetimes to ask it is a tax on the common case. The other
 * five per cent is "what happened between 14:05 and 14:20 last Tuesday, when the customer says
 * their call dropped", and a preset list cannot express that. So the control is a preset selector
 * that also has a `custom` mode, and the mode is in the URL alongside the dates.
 *
 * ## Why the preset stays a preset instead of resolving to timestamps in the URL
 *
 * A link that says `range=24h` means "the last day" to whoever opens it; a link that resolved to
 * fixed timestamps at the moment it was copied means "that particular day" forever. Support
 * conversations want the first — "look at the last day of calls for this tenant" — so the preset is
 * carried and resolved at render.
 *
 * The consequence is that a preset window would MOVE on every render, which makes a cursor
 * meaningless: page two would be computed against a different window than page one, so rows could
 * repeat or vanish. `useMemo` on the preset and the custom bounds is what pins it — within one
 * browsing session the window is a fixed pair of instants, and it only moves when the user changes
 * the control, which is also when paging resets.
 */

export interface TimeRangeState {
	readonly preset: RangePreset;
	readonly setPreset: (value: RangePreset) => void;
	/** `YYYY-MM-DDTHH:mm`, the value a `datetime-local` input round trips. */
	readonly customFrom: string;
	readonly setCustomFrom: (value: string) => void;
	readonly customTo: string;
	readonly setCustomTo: (value: string) => void;
	/** ISO instants to send to the API. `undefined` lets the server apply its own default. */
	readonly from: string | undefined;
	readonly to: string | undefined;
}

export function useTimeRangeState(): TimeRangeState {
	const [preset, setPresetState] = useQueryState(
		"range",
		parseAsStringLiteral(RANGE_PRESETS).withDefault("24h").withOptions({ clearOnDefault: true }),
	);
	const [customFrom, setCustomFromState] = useQueryState(
		"from",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);
	const [customTo, setCustomToState] = useQueryState(
		"to",
		parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
	);

	const resolved = useMemo(
		() => resolveRange(preset, { from: customFrom, to: customTo }, new Date()),
		[preset, customFrom, customTo],
	);

	return {
		preset,
		setPreset: (value) => {
			void setPresetState(value);
		},
		customFrom,
		setCustomFrom: (value) => {
			void setCustomFromState(value);
		},
		customTo,
		setCustomTo: (value) => {
			void setCustomToState(value);
		},
		from: resolved.from,
		to: resolved.to,
	};
}
