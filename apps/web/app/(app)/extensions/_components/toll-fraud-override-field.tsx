"use client";

import { focusRing } from "~/components/ui/focus-ring";
import { cn } from "~/lib/cn";
import {
	EMPTY_OVERRIDE_FORM,
	type TollFraudOverrideFormValues,
} from "~/lib/toll-fraud/override-form";

/**
 * One extension's departures from the organization's toll-fraud policy.
 *
 * ## "Inherit" is the default state, and an untouched extension sends nothing
 *
 * Every control here has three states rather than two, because an override row's `null` means
 * INHERIT and not "no ceiling" — the opposite of what `null` means on the organization policy, an
 * asymmetry `toll-fraud.dto.ts` calls out and this control has to render. A switch would collapse
 * "inherit" and "off" into one position and quietly pin every extension somebody opened the dialog
 * on to whatever the org policy said that day.
 *
 * The dialog only writes anything at all when this section differs from what was loaded, so editing
 * a caller ID on an extension that has never had an override still creates no override row.
 *
 * ## Zero is a value, and it is the one that stops a phone
 *
 * An empty box means inherit; `0` means "no international calling at all". That is what an
 * administrator writes to stop one compromised extension without touching anybody else's ceilings,
 * and it is why the boxes below say so rather than treating a blank and a zero as the same thing.
 */
export function TollFraudOverrideField({
	value,
	onChange,
	disabled,
}: {
	value: TollFraudOverrideFormValues;
	onChange: (next: TollFraudOverrideFormValues) => void;
	disabled?: boolean;
}) {
	const set = <K extends keyof TollFraudOverrideFormValues>(
		key: K,
		next: TollFraudOverrideFormValues[K],
	) => {
		onChange({ ...value, [key]: next });
	};

	const untouched =
		value.enabled === "inherit" &&
		value.maxConcurrentInternationalCalls === "" &&
		value.maxInternationalMinutesPerHour === "" &&
		value.maxInternationalMinutesPerDay === "" &&
		value.holdFirstCallToNewCountry === "inherit" &&
		value.offHoursInternationalLock === "inherit";

	return (
		<div className="flex flex-col gap-4 sm:col-span-2">
			<p className="text-xs text-muted-foreground">
				Everything here overrides the organization's fraud policy for this extension alone.
				“Inherit” is the organization's answer, and an empty ceiling inherits it too — a zero is a
				ceiling of none, which is how one compromised phone is stopped without moving anybody else's
				limits.
			</p>

			<TriState
				label="Apply fraud controls"
				value={value.enabled}
				onChange={(next) => set("enabled", next)}
				disabled={disabled}
				offLabel="Exempt this extension"
				onLabel="Always apply"
				hint="Exempting an extension beats an enabled organization policy — for the conference phone in a lobby that legitimately calls abroad all day."
			/>

			<div className="grid gap-4 sm:grid-cols-3">
				<Ceiling
					label="Concurrent calls"
					value={value.maxConcurrentInternationalCalls}
					onChange={(next) => set("maxConcurrentInternationalCalls", next)}
					disabled={disabled}
				/>
				<Ceiling
					label="Minutes per hour"
					value={value.maxInternationalMinutesPerHour}
					onChange={(next) => set("maxInternationalMinutesPerHour", next)}
					disabled={disabled}
				/>
				<Ceiling
					label="Minutes per day"
					value={value.maxInternationalMinutesPerDay}
					onChange={(next) => set("maxInternationalMinutesPerDay", next)}
					disabled={disabled}
				/>
			</div>

			<TriState
				label="Hold the first call to a new country"
				value={value.holdFirstCallToNewCountry}
				onChange={(next) => set("holdFirstCallToNewCountry", next)}
				disabled={disabled}
			/>
			<TriState
				label="Lock international calling out of hours"
				value={value.offHoursInternationalLock}
				onChange={(next) => set("offHoursInternationalLock", next)}
				disabled={disabled}
			/>

			<p className="text-xs text-muted-foreground">
				{untouched
					? "Nothing overridden — this extension follows the organization's policy, and saving writes no override."
					: "This extension departs from the organization's policy. Saving writes the override."}
			</p>

			<p className="text-xs text-muted-foreground">
				The allowed and denied country lists can be overridden per extension too, but only from the
				API — this form does not offer them, because a per-phone geography list is a rule nobody can
				audit from the extension list. Set the organization's lists on Security → Fraud controls
				instead.
			</p>
		</div>
	);
}

function TriState({
	label,
	value,
	onChange,
	disabled,
	hint,
	offLabel = "Off",
	onLabel = "On",
}: {
	label: string;
	value: TollFraudOverrideFormValues["enabled"];
	onChange: (next: TollFraudOverrideFormValues["enabled"]) => void;
	disabled?: boolean;
	hint?: string;
	offLabel?: string;
	onLabel?: string;
}) {
	const options: readonly {
		readonly value: TollFraudOverrideFormValues["enabled"];
		readonly label: string;
	}[] = [
		{ value: "inherit", label: "Inherit" },
		{ value: "on", label: onLabel },
		{ value: "off", label: offLabel },
	];

	return (
		<fieldset className="flex flex-col gap-1.5">
			<legend className="text-sm font-medium text-foreground">{label}</legend>
			{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
			<div className="flex flex-wrap gap-3">
				{options.map((option) => (
					<label
						key={option.value}
						className={cn(
							"flex items-center gap-1.5 text-sm text-foreground",
							disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
						)}
					>
						<input
							type="radio"
							name={`override-${label}`}
							checked={value === option.value}
							disabled={disabled}
							onChange={() => onChange(option.value)}
							className={cn("size-4 shrink-0 accent-primary", focusRing)}
						/>
						{option.label}
					</label>
				))}
			</div>
		</fieldset>
	);
}

function Ceiling({
	label,
	value,
	onChange,
	disabled,
}: {
	label: string;
	value: string;
	onChange: (next: string) => void;
	disabled?: boolean;
}) {
	return (
		<label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
			{label}
			<input
				type="text"
				inputMode="numeric"
				value={value}
				disabled={disabled}
				placeholder="Inherit"
				onChange={(event) => onChange(event.target.value)}
				className={cn(
					"h-9 rounded-md border border-border bg-background px-3 text-sm font-normal",
					focusRing,
				)}
			/>
		</label>
	);
}

export { EMPTY_OVERRIDE_FORM };
