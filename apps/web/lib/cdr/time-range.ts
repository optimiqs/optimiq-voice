/**
 * The reporting time window, as data.
 *
 * Pure and in `lib/` rather than beside the control that renders it, because these two decisions
 * are testable and worth testing: what a preset resolves to, and what a HALF-FILLED custom range
 * means. The hook that puts them in the URL lives with the screen.
 */

export const RANGE_PRESETS = ["24h", "7d", "30d", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_PRESET_LABELS: Readonly<Record<RangePreset, string>> = {
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	custom: "Custom range",
};

const PRESET_HOURS: Readonly<Record<Exclude<RangePreset, "custom">, number>> = {
	"24h": 24,
	"7d": 24 * 7,
	"30d": 24 * 30,
};

export interface ResolvedRange {
	/** ISO instant, or `undefined` to let the server apply its own default. */
	readonly from: string | undefined;
	readonly to: string | undefined;
}

/** `Date` → the local-time string a `datetime-local` input accepts. */
export function toLocalInputValue(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The instants a preset resolves to, relative to `now`.
 *
 * A `custom` range with one end missing resolves to NOTHING rather than to a half-range: the
 * server would refuse `from` without `to` as an inverted window or silently default the other end,
 * and neither is what a user mid-keystroke meant. Falling back to the server's own default keeps
 * the table populated while the second field is being filled in.
 */
export function resolveRange(
	preset: RangePreset,
	custom: { readonly from: string; readonly to: string },
	now: Date,
): ResolvedRange {
	if (preset === "custom") {
		const from = custom.from.length > 0 ? new Date(custom.from) : undefined;
		const to = custom.to.length > 0 ? new Date(custom.to) : undefined;
		if (
			from === undefined ||
			to === undefined ||
			Number.isNaN(from.getTime()) ||
			Number.isNaN(to.getTime())
		) {
			return { from: undefined, to: undefined };
		}
		return { from: from.toISOString(), to: to.toISOString() };
	}
	const hours = PRESET_HOURS[preset];
	return {
		from: new Date(now.getTime() - hours * 3600_000).toISOString(),
		to: now.toISOString(),
	};
}
