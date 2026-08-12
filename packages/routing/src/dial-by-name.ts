/**
 * Dial-by-name: turning a person's name into the digits a caller presses.
 *
 * # Why the map is compiled and not searched
 *
 * The engine holds no database handle, which is the reason every index in the artifact exists. It is
 * also what makes the one interesting diagnostic possible: two people whose names collide on the
 * keypad is invisible at runtime — the caller simply hears two options and picks one — and is
 * obvious at compile time, when both entries are being built.
 *
 * # The mapping is ITU E.161 and has no options
 *
 * `2 = ABC`, `3 = DEF`, … `9 = WXYZ`, which is what is printed on every telephone made since 1963
 * and therefore what a caller's fingers already know. `Q` and `Z` are on `7` and `9` — the North
 * American assignment — rather than absent, which is the older British layout no handset has carried
 * for decades.
 *
 * Everything that is not a letter is DROPPED rather than mapped: spaces, hyphens, apostrophes and
 * accents in "O'Brien-Smith" have no keys, and a caller spelling that name presses `627436`. Digits
 * inside a label are kept as themselves, because "Meeting Room 2" is a real label and a caller
 * looking at it would press the 2.
 *
 * Accented letters are folded to their base letter first (`é` → `e` → `3`), because a caller has no
 * way to press an accent and a directory that excluded every European surname would be a directory
 * nobody could use.
 */

/** ITU E.161. The letters of one keypad digit, in the order they are printed on it. */
const KEYPAD: Readonly<Record<string, string>> = {
	a: "2",
	b: "2",
	c: "2",
	d: "3",
	e: "3",
	f: "3",
	g: "4",
	h: "4",
	i: "4",
	j: "5",
	k: "5",
	l: "5",
	m: "6",
	n: "6",
	o: "6",
	p: "7",
	q: "7",
	r: "7",
	s: "7",
	t: "8",
	u: "8",
	v: "8",
	w: "9",
	x: "9",
	y: "9",
	z: "9",
} as const;

/** Bound on a compiled entry's digits. Long enough for any name; short enough to bound the work. */
export const MAX_DIRECTORY_DIGITS = 32;

/**
 * Splits a label into the parts a directory can be searched by.
 *
 * The whole of the naming policy, and it is deliberately naive: the first whitespace-separated token
 * is the given name and the LAST is the family name, with anything between belonging to neither.
 * That is right for "Jane Smith" and for "Jane van der Berg" (family name `Berg`), and wrong for
 * "Maria Garcia Lopez", where the family name is `Garcia Lopez`.
 *
 * The alternative is a pair of columns on `extension`, which is a real answer and a bigger change
 * than this one: it needs a migration, two DTO fields, an import path and a UI that asks every
 * tenant to re-enter names they have already typed. A `full-name` search field is available in the
 * meantime and matches the whole label, which is the escape hatch for exactly the case the naive
 * split gets wrong.
 */
export function nameParts(label: string): {
	readonly first: string;
	readonly last: string;
	readonly full: string;
} {
	const tokens = label
		.trim()
		.split(/\s+/u)
		.filter((token) => token.length > 0);
	const first = tokens[0] ?? "";
	const last = tokens.length > 1 ? (tokens.at(-1) ?? "") : first;
	return { first, last, full: tokens.join("") };
}

/**
 * Maps text to keypad digits.
 *
 * Returns an empty string when nothing in the input has a key, which is a name the directory cannot
 * offer — the compiler treats that as a skip with a diagnostic rather than as an entry matching
 * every caller's first keypress.
 */
export function nameToDigits(text: string): string {
	// NFD then strip the combining marks: `é` becomes `e` + U+0301, and dropping the mark leaves the
	// base letter the keypad knows. Without it every accented name maps to nothing.
	const folded = text.normalize("NFD").replaceAll(/[̀-ͯ]/gu, "");
	let digits = "";
	for (const character of folded.toLowerCase()) {
		if (digits.length >= MAX_DIRECTORY_DIGITS) {
			break;
		}
		const key = KEYPAD[character];
		if (key !== undefined) {
			digits += key;
			continue;
		}
		if (character >= "0" && character <= "9") {
			// A digit in a label is already a key. "Meeting Room 2" is a real name and a caller looking
			// at the sign on the door would press the 2.
			digits += character;
		}
	}
	return digits;
}

/** The searchable digits of one label, for a directory's chosen search field. */
export function directoryDigits(
	label: string,
	searchField: "last-name" | "first-name" | "full-name",
): string {
	const parts = nameParts(label);
	switch (searchField) {
		case "first-name": {
			return nameToDigits(parts.first);
		}
		case "full-name": {
			return nameToDigits(parts.full);
		}
		default: {
			return nameToDigits(parts.last);
		}
	}
}

/**
 * The entries a caller's digits select, in the artifact's order.
 *
 * A PREFIX match, because that is the whole interaction: a caller presses three digits and hears
 * everybody whose name starts that way. An exact match would mean spelling the entire name, which is
 * both slower and unusable for anybody who does not know how it is spelled — which is most of the
 * reason somebody is using a directory.
 *
 * The table is pre-sorted by the compiler, so this is a linear scan that preserves that order rather
 * than a search that imposes its own.
 */
export function matchDirectory<TEntry extends { readonly digits: string }>(
	entries: readonly TEntry[],
	dialed: string,
): readonly TEntry[] {
	if (dialed.length === 0) {
		return [];
	}
	return entries.filter((entry) => entry.digits.startsWith(dialed));
}
