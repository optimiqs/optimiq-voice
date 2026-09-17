/**
 * E.164 number → ISO-3166 alpha-2, and nothing else.
 *
 * ## Why a table and not a dependency
 *
 * `libphonenumber` answers this properly and is not in the lockfile. Adding it for this would pull
 * a multi-megabyte metadata bundle into the control plane's image to answer one question — "which
 * country is this number in" — that a two-hundred-line table answers for the purpose it is needed
 * for. This is a FRAUD control, and the fraud question is coarse by nature: a geo block on Latvia
 * and a hold on a first call to Cuba do not need to know that a number is mobile, or that it is
 * valid, or which carrier holds the range. They need the country code.
 *
 * ## What it does not do, stated so nobody builds on it
 *
 * - It does NOT validate. A number this returns `LV` for may not exist.
 * - It does NOT split shared codes below the NANP. `+1` is the one code shared by twenty-odd
 *   countries, and the NANP area codes ARE split here because the difference between "a call to
 *   Canada" and "a call to the 900-number-adjacent Caribbean" is the single most common toll-fraud
 *   pattern on a North American tenant. Every other shared code (`+7` for Russia and Kazakhstan,
 *   `+61` for Australia and its territories) resolves to the dominant country, because no fraud
 *   control anybody would write distinguishes them.
 * - It does NOT know about `+882` / `+883` (global networks) or `+979` (premium audiotext) as
 *   countries, because they are not countries. They resolve to `undefined`, and a caller that wants
 *   to treat "unresolvable" as high-risk can — {@link resolveE164Country} returning `undefined` is
 *   information, not a failure.
 *
 * ## Longest-prefix, and why the table is ordered by length at build time
 *
 * Calling codes are a prefix code in principle and not in practice: `+1` and `+1242` both exist, as
 * do `+7` and `+76`. The lookup therefore tries the longest prefix first, over a map built once at
 * module load. Four probes (four digits down to one) rather than a walk of the table.
 */

/**
 * ISO country for each E.164 calling code, longest-prefix wins.
 *
 * Codes are the ITU-T E.164 assignments. NANP entries below are AREA codes, which are three digits
 * after the `1` and therefore four-digit prefixes here.
 */
const COUNTRY_BY_CALLING_CODE: Readonly<Record<string, string>> = {
	// --- NANP, split by area code -------------------------------------------------------------
	// Only the non-US/Canada members are listed. `+1` itself falls through to `US`, which is the
	// honest default for a platform whose NANP tenants are overwhelmingly American: Canada would be
	// the alternative and it is not separable from the US by anything a fraud control cares about
	// (same rates, same regulator relationship, no revenue share), whereas the Caribbean members
	// below are exactly the ranges that appear on every fraud advisory.
	"1242": "BS",
	"1246": "BB",
	"1264": "AI",
	"1268": "AG",
	"1284": "VG",
	"1340": "VI",
	"1345": "KY",
	"1441": "BM",
	"1473": "GD",
	"1649": "TC",
	"1664": "MS",
	"1670": "MP",
	"1671": "GU",
	"1684": "AS",
	"1721": "SX",
	"1758": "LC",
	"1767": "DM",
	"1784": "VC",
	"1809": "DO",
	"1829": "DO",
	"1849": "DO",
	"1868": "TT",
	"1869": "KN",
	"1876": "JM",
	"1939": "PR",
	"1787": "PR",
	// --- Zone 1 default and zone 7 --------------------------------------------------------------
	"1": "US",
	"7": "RU",
	// --- Zone 2, Africa -------------------------------------------------------------------------
	"20": "EG",
	"211": "SS",
	"212": "MA",
	"213": "DZ",
	"216": "TN",
	"218": "LY",
	"220": "GM",
	"221": "SN",
	"222": "MR",
	"223": "ML",
	"224": "GN",
	"225": "CI",
	"226": "BF",
	"227": "NE",
	"228": "TG",
	"229": "BJ",
	"230": "MU",
	"231": "LR",
	"232": "SL",
	"233": "GH",
	"234": "NG",
	"235": "TD",
	"236": "CF",
	"237": "CM",
	"238": "CV",
	"239": "ST",
	"240": "GQ",
	"241": "GA",
	"242": "CG",
	"243": "CD",
	"244": "AO",
	"245": "GW",
	"246": "IO",
	"248": "SC",
	"249": "SD",
	"250": "RW",
	"251": "ET",
	"252": "SO",
	"253": "DJ",
	"254": "KE",
	"255": "TZ",
	"256": "UG",
	"257": "BI",
	"258": "MZ",
	"260": "ZM",
	"261": "MG",
	"262": "RE",
	"263": "ZW",
	"264": "NA",
	"265": "MW",
	"266": "LS",
	"267": "BW",
	"268": "SZ",
	"269": "KM",
	"27": "ZA",
	"290": "SH",
	"291": "ER",
	"297": "AW",
	"298": "FO",
	"299": "GL",
	// --- Zone 3 and 4, Europe -------------------------------------------------------------------
	"30": "GR",
	"31": "NL",
	"32": "BE",
	"33": "FR",
	"34": "ES",
	"350": "GI",
	"351": "PT",
	"352": "LU",
	"353": "IE",
	"354": "IS",
	"355": "AL",
	"356": "MT",
	"357": "CY",
	"358": "FI",
	"359": "BG",
	"36": "HU",
	"370": "LT",
	"371": "LV",
	"372": "EE",
	"373": "MD",
	"374": "AM",
	"375": "BY",
	"376": "AD",
	"377": "MC",
	"378": "SM",
	"380": "UA",
	"381": "RS",
	"382": "ME",
	"383": "XK",
	"385": "HR",
	"386": "SI",
	"387": "BA",
	"389": "MK",
	"39": "IT",
	"40": "RO",
	"41": "CH",
	"420": "CZ",
	"421": "SK",
	"423": "LI",
	"43": "AT",
	"44": "GB",
	"45": "DK",
	"46": "SE",
	"47": "NO",
	"48": "PL",
	"49": "DE",
	// --- Zone 5, Latin America ------------------------------------------------------------------
	"500": "FK",
	"501": "BZ",
	"502": "GT",
	"503": "SV",
	"504": "HN",
	"505": "NI",
	"506": "CR",
	"507": "PA",
	"508": "PM",
	"509": "HT",
	"51": "PE",
	"52": "MX",
	"53": "CU",
	"54": "AR",
	"55": "BR",
	"56": "CL",
	"57": "CO",
	"58": "VE",
	"590": "GP",
	"591": "BO",
	"592": "GY",
	"593": "EC",
	"594": "GF",
	"595": "PY",
	"596": "MQ",
	"597": "SR",
	"598": "UY",
	"599": "CW",
	// --- Zone 6, South-East Asia and Oceania ----------------------------------------------------
	"60": "MY",
	"61": "AU",
	"62": "ID",
	"63": "PH",
	"64": "NZ",
	"65": "SG",
	"66": "TH",
	"670": "TL",
	"672": "NF",
	"673": "BN",
	"674": "NR",
	"675": "PG",
	"676": "TO",
	"677": "SB",
	"678": "VU",
	"679": "FJ",
	"680": "PW",
	"681": "WF",
	"682": "CK",
	"683": "NU",
	"685": "WS",
	"686": "KI",
	"687": "NC",
	"688": "TV",
	"689": "PF",
	"690": "TK",
	"691": "FM",
	"692": "MH",
	// --- Zone 8 and 9, Asia ---------------------------------------------------------------------
	"81": "JP",
	"82": "KR",
	"84": "VN",
	"850": "KP",
	"852": "HK",
	"853": "MO",
	"855": "KH",
	"856": "LA",
	"86": "CN",
	"880": "BD",
	"886": "TW",
	"90": "TR",
	"91": "IN",
	"92": "PK",
	"93": "AF",
	"94": "LK",
	"95": "MM",
	"960": "MV",
	"961": "LB",
	"962": "JO",
	"963": "SY",
	"964": "IQ",
	"965": "KW",
	"966": "SA",
	"967": "YE",
	"968": "OM",
	"970": "PS",
	"971": "AE",
	"972": "IL",
	"973": "BH",
	"974": "QA",
	"975": "BT",
	"976": "MN",
	"977": "NP",
	"98": "IR",
	"992": "TJ",
	"993": "TM",
	"994": "AZ",
	"995": "GE",
	"996": "KG",
	"998": "UZ",
};

/** The longest calling code in the table, so the probe knows where to start. */
const LONGEST_CODE = Object.keys(COUNTRY_BY_CALLING_CODE).reduce(
	(longest, code) => Math.max(longest, code.length),
	0,
);

/**
 * The ISO-3166 alpha-2 country an E.164 number belongs to, or `undefined`.
 *
 * `undefined` for a number that is not E.164 (no leading `+`, non-digits, too short) and for a
 * calling code the table does not carry — a global-network `+882`, a satellite `+881`, an
 * audiotext `+979`. That is information rather than an error, and the toll-fraud gate treats it as
 * such: an unresolvable INTERNATIONAL destination is exactly the shape of a revenue-share number,
 * so it is held by the same rule that holds a first call to a new country rather than waved through.
 */
export function resolveE164Country(number: string): string | undefined {
	const digits = normalizeE164(number);
	if (digits === undefined) {
		return undefined;
	}
	for (let length = Math.min(LONGEST_CODE, digits.length); length > 0; length -= 1) {
		const country = COUNTRY_BY_CALLING_CODE[digits.slice(0, length)];
		if (country !== undefined) {
			return country;
		}
	}
	return undefined;
}

/**
 * The digits of an E.164 number, or `undefined` when it is not one.
 *
 * Deliberately strict about the leading `+`. Every number that reaches the toll-fraud gate has been
 * through the dial plan's own canonicalisation, so a bare national number arriving here is a bug
 * upstream — and guessing a country code for it is how a British tenant's fraud controls start
 * evaluating Manhattan. The same argument `e164-ingest.ts` makes for refusing rather than guessing.
 */
export function normalizeE164(number: string): string | undefined {
	const trimmed = number.trim();
	if (!trimmed.startsWith("+")) {
		return undefined;
	}
	const digits = trimmed.slice(1);
	// E.164 caps at fifteen digits; the shortest real one is about seven. Both bounds exist to keep
	// an attacker-chosen string from reaching the prefix probe as something enormous.
	if (!/^[0-9]{5,15}$/.test(digits)) {
		return undefined;
	}
	return digits;
}

/** Every country the table can produce, sorted. Exported so a DTO can refuse a code nobody serves. */
export function knownCountries(): readonly string[] {
	return [...new Set(Object.values(COUNTRY_BY_CALLING_CODE))].sort();
}
