import { MAX_PAGE_LIMIT } from "./client";

/**
 * The two pure decisions a searching reference picker makes, kept out of the component so they can
 * be asserted without a React renderer (this package has no hook test harness).
 *
 * A picker reads ONE page and the API caps that page at 100 rows, so a tenant with more than a
 * hundred extensions used to have the rest of them be unselectable — the control simply did not
 * offer them. Server-side search is the fix: the operator types, the term reaches `?search=`, and
 * the hundred rows on offer become the hundred that match rather than the hundred that sort first.
 *
 * That in turn creates the second problem this file answers. Once the page is a search result, the
 * row a field is ALREADY set to is usually not in it, and a select whose current value has no
 * matching option renders as blank or — worse — silently reads back as the first option. So the
 * selected row is merged in from what the picker has previously seen.
 */

/** One page, the largest the API will serve, because a picker has nowhere to put a second one. */
export const PICKER_PAGE_LIMIT = MAX_PAGE_LIMIT;

/**
 * What reaches `?search=`: the trimmed term, or nothing at all when it is blank.
 *
 * `undefined` rather than `""` because `pbxListSearchParams` only sets the parameter for a truthy
 * value, and because it is what keeps the unsearched query key identical to the one the picker
 * used before this existed.
 */
export function pickerSearchTerm(input: string): string | undefined {
	const trimmed = input.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export interface PickerOption {
	readonly id: string;
	readonly label: string;
}

/**
 * The options a searching select should render: the current page, plus the selected row when the
 * page does not hold it.
 *
 * `remembered` is every row the picker has seen on any page this session, so a value chosen before
 * the operator typed keeps its real label instead of degrading to a truncated id. When the id was
 * never seen — a stored reference to a row that was deleted, or a form opened straight onto a
 * search — it is still offered, labelled by `fallbackLabel`, because dropping it would rewrite the
 * field to whatever happened to sort first.
 *
 * The selected row goes FIRST when it is added, so it is visible without scrolling a hundred rows.
 */
export function mergeSelectedOption(
	options: readonly PickerOption[],
	value: string,
	remembered: ReadonlyMap<string, string>,
	fallbackLabel: (id: string) => string,
): readonly PickerOption[] {
	if (value.length === 0 || options.some((option) => option.id === value)) {
		return options;
	}
	return [{ id: value, label: remembered.get(value) ?? fallbackLabel(value) }, ...options];
}
