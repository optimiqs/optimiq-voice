import { describe, expect, it } from "bun:test";
import { directoryDigits, matchDirectory, nameParts, nameToDigits } from "./dial-by-name";

/**
 * The keypad mapping, and the naming policy it sits on.
 *
 * The mapping itself is not interesting — it is printed on every telephone — so what is asserted
 * here is the handful of decisions around it that a caller would notice: that accents fold rather
 * than vanish (or every European surname would be undialable), that punctuation drops (a caller has
 * no apostrophe key), that digits in a label survive (the sign on the meeting-room door says 2), and
 * that the naive first/last split is honest about what it gets wrong.
 */

describe("nameToDigits", () => {
	it("maps the ITU keypad", () => {
		expect(nameToDigits("smith")).toBe("76484");
		expect(nameToDigits("SMITH")).toBe("76484");
		// `q` on 7 and `z` on 9 — the North American assignment every handset has carried for decades,
		// not the older British layout where both were absent.
		expect(nameToDigits("quiz")).toBe("7849");
	});

	it("folds accents to their base letter, because a caller cannot press one", () => {
		expect(nameToDigits("Ferré")).toBe(nameToDigits("Ferre"));
		expect(nameToDigits("Müller")).toBe(nameToDigits("Muller"));
	});

	it("drops the characters with no key", () => {
		expect(nameToDigits("O'Brien-Smith")).toBe(nameToDigits("OBrienSmith"));
		expect(nameToDigits("  van der Berg ")).toBe(nameToDigits("vanderBerg"));
	});

	/** "Meeting Room 2" is a real label, and a caller looking at the door would press the 2. */
	it("keeps digits as themselves", () => {
		expect(nameToDigits("Room 2")).toBe("76662");
	});

	it("returns nothing for a name with no keys at all", () => {
		expect(nameToDigits("---")).toBe("");
		expect(nameToDigits("")).toBe("");
	});
});

describe("nameParts", () => {
	it("splits a two-token name into given and family", () => {
		expect(nameParts("Jane Smith")).toEqual({ first: "Jane", last: "Smith", full: "JaneSmith" });
	});

	it("takes the LAST token as the family name, which handles a particle", () => {
		expect(nameParts("Jane van der Berg").last).toBe("Berg");
	});

	it("treats a single token as both", () => {
		expect(nameParts("Cher")).toEqual({ first: "Cher", last: "Cher", full: "Cher" });
	});

	/**
	 * The case the naive split gets WRONG, asserted rather than hidden: "Maria Garcia Lopez" has the
	 * family name `Garcia Lopez` and this reports `Lopez`. `full-name` is the escape hatch, and a
	 * pair of columns on `extension` is the real fix — see `dial-by-name.ts` for why that is a bigger
	 * change than this one.
	 */
	it("takes only the last token for a two-part family name", () => {
		expect(nameParts("Maria Garcia Lopez").last).toBe("Lopez");
		expect(nameParts("Maria Garcia Lopez").full).toBe("MariaGarciaLopez");
	});
});

describe("directoryDigits", () => {
	it("uses the field the directory chose", () => {
		expect(directoryDigits("Jane Smith", "last-name")).toBe(nameToDigits("Smith"));
		expect(directoryDigits("Jane Smith", "first-name")).toBe(nameToDigits("Jane"));
		expect(directoryDigits("Jane Smith", "full-name")).toBe(nameToDigits("JaneSmith"));
	});
});

describe("matchDirectory", () => {
	const entries = [
		{ digits: "76484", extensionNumber: "1001" },
		{ digits: "764843", extensionNumber: "1002" },
		{ digits: "5263", extensionNumber: "1003" },
	];

	/**
	 * A PREFIX match, because that is the whole interaction: three digits and the caller hears
	 * everybody whose name starts that way. An exact match would mean spelling the entire name,
	 * which is unusable for anybody who does not know how it is spelled — most of the reason somebody
	 * is using a directory at all.
	 */
	it("returns every entry the digits are a prefix of", () => {
		expect(matchDirectory(entries, "764").map((entry) => entry.extensionNumber)).toEqual([
			"1001",
			"1002",
		]);
	});

	it("returns nothing for no digits, rather than everybody", () => {
		expect(matchDirectory(entries, "")).toEqual([]);
	});

	it("preserves the compiled order rather than imposing one", () => {
		expect(matchDirectory(entries, "7").map((entry) => entry.digits)).toEqual(["76484", "764843"]);
	});
});
