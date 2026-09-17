"use client";

import { useId, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { focusRing } from "~/components/ui/focus-ring";
import { cn } from "~/lib/cn";
import {
	countryLabel,
	isResolvableCountry,
	regionDisplayNames,
	RESOLVABLE_COUNTRIES,
} from "~/lib/toll-fraud/countries";
import type { ReactNode } from "react";
import type { FieldLike } from "~/components/ui/form-fields";

/**
 * A country list, as chips over a `datalist`-backed box.
 *
 * ## Why not the checkbox grid `HangupCausesField` uses
 *
 * That control offers eleven values. This one offers 228, and a grid of 228 checkboxes is a control
 * nobody can find "Germany" in — the list is longer than the form it sits in. A chip input inverts
 * it: the SELECTED set is what is on screen, which is the set an administrator is actually reasoning
 * about ("we allow four countries"), and the unselected 224 stay behind a type-ahead.
 *
 * ## Why not a comma-separated text box
 *
 * The API refuses a code its E.164 resolver cannot produce, and a refusal on save names a code
 * rather than a field. Typing `UK` for the United Kingdom is the obvious way to get one, and the
 * only cure is to make the wrong value unpickable — which is the same argument `HangupCausesField`
 * makes for its closed list. The box below accepts a two-letter code or a country name, refuses
 * anything the platform cannot resolve on the spot, and says so under the input rather than after a
 * round trip.
 *
 * ## An already-stored code outside the offered set is still shown
 *
 * On the same terms as the hangup-cause field: a list written by operator tooling, or by a wider
 * table in an older release, would otherwise vanish from the form and then out of the row on the
 * next save. `PUT` makes that worse than it is there — the body is the complete list, so a dropped
 * chip is a dropped rule. Anything stored renders as a chip whether it is offered or not.
 */
export function CountryListField({
	field,
	label,
	description,
	disabled,
	emptyMeaning,
}: {
	field: FieldLike<string[]>;
	label: string;
	description?: ReactNode;
	disabled?: boolean;
	/** What an empty list means for THIS list — the two lists' empty states are not the same. */
	emptyMeaning: string;
}) {
	const inputId = useId();
	const listId = `${inputId}-options`;
	const [draft, setDraft] = useState("");
	const [problem, setProblem] = useState<string | null>(null);

	const display = useMemo(() => regionDisplayNames(), []);
	const selected = field.state.value;
	const selectedSet = useMemo(() => new Set(selected), [selected]);

	/**
	 * Name → code, so the box accepts "Germany" as well as "DE".
	 *
	 * Built from the platform's own list rather than from `Intl`'s, so a name this browser knows for
	 * a country the resolver cannot produce is not offered — which is the whole point of the list.
	 */
	const byName = useMemo(() => {
		const index = new Map<string, string>();
		for (const code of RESOLVABLE_COUNTRIES) {
			index.set(code.toLowerCase(), code);
			const label = countryLabel(code, display);
			if (label !== code) {
				index.set(label.slice(0, label.lastIndexOf(" (")).toLowerCase(), code);
			}
		}
		return index;
	}, [display]);

	const add = () => {
		const typed = draft.trim();
		if (typed.length === 0) {
			return;
		}
		const code = byName.get(typed.toLowerCase()) ?? typed.toUpperCase();
		if (!isResolvableCountry(code)) {
			setProblem(`This platform cannot resolve a number to “${typed}”.`);
			return;
		}
		setProblem(null);
		setDraft("");
		if (selectedSet.has(code)) {
			return;
		}
		field.handleChange([...selected, code].sort());
	};

	const remove = (code: string) => {
		field.handleChange(selected.filter((entry) => entry !== code));
	};

	return (
		<fieldset className="flex flex-col gap-2">
			<legend className="text-sm font-medium text-foreground">{label}</legend>
			{description ? <p className="text-xs text-muted-foreground">{description}</p> : null}

			<div className="mt-1 flex max-w-md gap-2">
				<input
					id={inputId}
					list={listId}
					value={draft}
					disabled={disabled}
					placeholder="Country or code, e.g. DE"
					aria-label={`Add a country to ${label}`}
					onChange={(event) => {
						setDraft(event.target.value);
						setProblem(null);
					}}
					onKeyDown={(event) => {
						// Enter adds a chip; it must not submit the form the field is sitting in.
						if (event.key === "Enter") {
							event.preventDefault();
							add();
						}
					}}
					className={cn(
						"h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm",
						focusRing,
						disabled ? "cursor-not-allowed opacity-60" : null,
					)}
				/>
				<datalist id={listId}>
					{RESOLVABLE_COUNTRIES.filter((code) => !selectedSet.has(code)).map((code) => (
						<option key={code} value={countryLabel(code, display)}>
							{countryLabel(code, display)}
						</option>
					))}
				</datalist>
				<Button type="button" variant="secondary" disabled={disabled} onClick={add}>
					Add
				</Button>
			</div>

			{problem === null ? null : <p className="text-xs text-danger">{problem}</p>}

			{selected.length === 0 ? (
				<p className="text-xs text-muted-foreground">{emptyMeaning}</p>
			) : (
				<ul className="flex flex-wrap gap-1.5">
					{selected.map((code) => (
						<li key={code}>
							<span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pr-1 pl-2 text-xs text-foreground">
								{countryLabel(code, display)}
								<button
									type="button"
									disabled={disabled}
									aria-label={`Remove ${countryLabel(code, display)}`}
									onClick={() => remove(code)}
									className={cn(
										"rounded-full px-1 text-muted-foreground hover:text-foreground",
										focusRing,
										disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
									)}
								>
									×
								</button>
							</span>
						</li>
					))}
				</ul>
			)}
		</fieldset>
	);
}
