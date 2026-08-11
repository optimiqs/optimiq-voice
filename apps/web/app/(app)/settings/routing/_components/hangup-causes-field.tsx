"use client";

import { focusRing } from "~/components/ui/focus-ring";
import { cn } from "~/lib/cn";
import { RETRYABLE_HANGUP_CAUSES } from "~/lib/org-settings/client";
import type { ReactNode } from "react";
import type { FieldLike } from "~/components/ui/form-fields";

/**
 * `trunkContinueOnCauses`, as a closed set of checkboxes rather than a text box.
 *
 * ## Why not free text
 *
 * The compiler validates each name against its hangup-cause table and DROPS the ones it does not
 * recognise — with a warning, but the save still succeeds and the artifact still publishes. So a
 * typo here is not a validation error a user sees; it is a cause that silently stops being
 * retried, discovered weeks later as "calls fail over to the second trunk sometimes". A closed
 * list cannot be mistyped.
 *
 * ## Why an unknown stored cause is still shown
 *
 * The offered set is the platform's retryable list, which is deliberately narrower than the set of
 * causes the compiler will accept. If a row already holds something outside it — set by operator
 * tooling, or by a wider list in an older release — rendering only the offered names would drop it
 * from the form and then drop it from the row on the next save, which is a configuration change
 * nobody asked for. Anything stored appears as its own checked box, at the end, marked as such.
 */
export function HangupCausesField({
	field,
	label,
	description,
	disabled,
}: {
	field: FieldLike<string[]>;
	label: string;
	description?: ReactNode;
	disabled?: boolean;
}) {
	const selected = new Set(field.state.value);
	const offered = RETRYABLE_HANGUP_CAUSES;
	const extra = field.state.value.filter((cause) => !offered.includes(cause)).sort();

	const toggle = (cause: string, checked: boolean) => {
		const next = new Set(field.state.value);
		if (checked) {
			next.add(cause);
		} else {
			next.delete(cause);
		}
		field.handleChange([...next].sort());
	};

	return (
		<fieldset className="flex flex-col gap-2">
			<legend className="text-sm font-medium text-foreground">{label}</legend>
			{description ? <p className="text-xs text-muted-foreground">{description}</p> : null}

			<div className="mt-1 flex flex-col gap-2">
				<div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
					{offered.map((cause) => (
						<CauseCheckbox
							key={cause}
							cause={cause}
							checked={selected.has(cause)}
							disabled={disabled}
							onToggle={toggle}
						/>
					))}
				</div>

				{extra.length > 0 ? (
					<div className="flex flex-col gap-1.5 border-t border-border pt-2">
						<p className="text-xs text-muted-foreground">
							Already configured, outside the list above. Clearing one removes it for good.
						</p>
						<div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
							{extra.map((cause) => (
								<CauseCheckbox
									key={cause}
									cause={cause}
									checked
									disabled={disabled}
									onToggle={toggle}
								/>
							))}
						</div>
					</div>
				) : null}
			</div>

			<p className="text-xs text-muted-foreground">
				{field.state.value.length === 0
					? "Nothing selected."
					: `${field.state.value.length} selected.`}
			</p>
		</fieldset>
	);
}

function CauseCheckbox({
	cause,
	checked,
	disabled,
	onToggle,
}: {
	cause: string;
	checked: boolean;
	disabled?: boolean;
	onToggle: (cause: string, checked: boolean) => void;
}) {
	const id = `trunkContinueOnCauses-${cause}`;
	return (
		<label
			htmlFor={id}
			className={cn(
				"flex items-center gap-2 text-sm text-foreground",
				disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
			)}
		>
			<input
				id={id}
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(event) => onToggle(cause, event.target.checked)}
				className={cn(
					"size-4 shrink-0 rounded-[4px] border border-border accent-primary",
					focusRing,
				)}
			/>
			<span className="font-mono text-xs break-all">{cause}</span>
		</label>
	);
}
