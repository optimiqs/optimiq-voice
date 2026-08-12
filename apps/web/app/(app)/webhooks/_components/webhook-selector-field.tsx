"use client";

import { Textarea } from "~/components/ui/field";
import { focusRing } from "~/components/ui/focus-ring";
import { cn } from "~/lib/cn";
import { WEBHOOK_FAMILIES } from "~/lib/pbx/contracts";
import {
	MAX_WEBHOOK_SELECTORS,
	WEBHOOK_FAMILY_DESCRIPTIONS,
	WEBHOOK_FAMILY_LABELS,
	familyWildcard,
} from "~/lib/pbx/webhook-selectors";
import type { WebhookFamily } from "~/lib/pbx/contracts";

/**
 * What an endpoint receives: four families as checkboxes, and exact types as free text.
 *
 * ## Why two controls and not one
 *
 * The two questions are genuinely different. "Send me everything about calls" is a decision about
 * VOLUME — a family wildcard, and the commonest thing anybody wants — while
 * `calls.evt.v1.channel.answered` is a decision about one event, usually made by somebody who has
 * read the event reference. A single textarea would make the common case require knowing the
 * subject roots by heart; a single checkbox list could not express the second case at all.
 *
 * The wildcard is shown next to each label rather than hidden behind the checkbox, because it is
 * what gets STORED — an administrator comparing this form against a subscription they created with
 * the API needs to see the same string in both places.
 *
 * ## The exact types are validated by the dialog, not by this component
 *
 * The list that reaches the server is `buildSelectors(families, types)`, which drops an exact type a
 * chosen family already covers and orders the wildcards canonically. So there is no single field a
 * message could be attached to — the offending selector may have been typed here and refused because
 * of a box ticked above it — and `selectorListIssue` produces one sentence for the whole control.
 * That is the same division the destination picker makes.
 */
export function WebhookSelectorField({
	families,
	onFamiliesChange,
	typesText,
	onTypesTextChange,
	unknown,
	disabled,
	error,
}: {
	families: readonly WebhookFamily[];
	onFamiliesChange: (next: readonly WebhookFamily[]) => void;
	typesText: string;
	onTypesTextChange: (next: string) => void;
	/**
	 * Stored selectors the platform no longer serves.
	 *
	 * Surfaced rather than dropped: silently discarding one on edit would delete a subscription's
	 * filter as a side effect of opening a form. They stay in the textarea and the note explains why
	 * the form is refusing to save until they are dealt with.
	 */
	unknown: readonly string[];
	disabled?: boolean;
	error?: string | undefined;
}) {
	const selected = new Set(families);

	const toggle = (family: WebhookFamily, checked: boolean): void => {
		const next = new Set(families);
		if (checked) {
			next.add(family);
		} else {
			next.delete(family);
		}
		// Filtered through the platform's own order so the stored array does not depend on the order
		// the boxes were ticked in — see `buildSelectors`.
		onFamiliesChange(WEBHOOK_FAMILIES.filter((candidate) => next.has(candidate)));
	};

	return (
		<fieldset className="flex flex-col gap-3">
			<legend className="text-sm font-medium text-foreground">Events</legend>
			<p className="text-xs text-muted-foreground">
				At least one. A subscription that selects nothing never fires, and there is no symptom
				beyond an endpoint that stays quiet.
			</p>

			<div className="flex flex-col gap-2">
				{WEBHOOK_FAMILIES.map((family) => {
					const id = `webhookFamily-${family}`;
					return (
						<label
							key={family}
							htmlFor={id}
							className={cn(
								"flex items-start gap-2.5 rounded-field border border-border px-3 py-2",
								disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-hover",
							)}
						>
							<input
								id={id}
								type="checkbox"
								checked={selected.has(family)}
								disabled={disabled}
								onChange={(event) => toggle(family, event.target.checked)}
								className={cn(
									"mt-0.5 size-4 shrink-0 rounded-[4px] border border-border accent-primary",
									focusRing,
								)}
							/>
							<span className="flex min-w-0 flex-col gap-0.5">
								<span className="text-sm font-medium text-foreground">
									{WEBHOOK_FAMILY_LABELS[family]}{" "}
									<span className="font-mono text-xs font-normal text-muted-foreground">
										{familyWildcard(family)}
									</span>
								</span>
								<span className="text-xs text-muted-foreground">
									{WEBHOOK_FAMILY_DESCRIPTIONS[family]}
								</span>
							</span>
						</label>
					);
				})}
			</div>

			<div className="flex flex-col gap-1.5">
				<label htmlFor="webhookSelectorTypes" className="text-sm font-medium text-foreground">
					Exact event types
				</label>
				<Textarea
					id="webhookSelectorTypes"
					name="webhookSelectorTypes"
					rows={3}
					value={typesText}
					disabled={disabled}
					onChange={(event) => onTypesTextChange(event.target.value)}
					placeholder={"calls.evt.v1.channel.answered\nqueue.evt.v1.abandoned"}
					aria-invalid={error ? true : undefined}
					aria-describedby="webhookSelectorTypes-description"
				/>
				<p id="webhookSelectorTypes-description" className="text-xs text-muted-foreground">
					One per line, or separated by commas. Only needed for an endpoint that wants a few
					specific events — a family ticked above already covers every type in it, and a type it
					covers is dropped rather than stored twice. At most {MAX_WEBHOOK_SELECTORS} selectors in
					total.
				</p>
			</div>

			{unknown.length > 0 ? (
				<p className="rounded-panel border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-foreground">
					This subscription already holds {unknown.length === 1 ? "a selector" : "selectors"} this
					platform no longer serves: <span className="font-mono">{unknown.join(", ")}</span>. They
					have been left in the box above rather than dropped — remove them to save, or leave the
					subscription alone.
				</p>
			) : null}

			{error ? (
				<p role="alert" className="text-xs text-danger">
					{error}
				</p>
			) : null}
		</fieldset>
	);
}
