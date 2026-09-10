import { isE164, normalizeE164 } from "@optimiq-voice/telephony";

/**
 * Which jurisdictions a phone number plausibly touches — the input to the all-party consent gate.
 *
 * ## What this is, stated before anything else: a policy default, not legal advice
 *
 * Recording law is not a lookup table. Whether a call may be recorded depends on where each party
 * physically is, what they were told, what the parties agreed to in advance, whether the call is a
 * business call, and on case law that moves. Nothing in this file is a legal determination and
 * nothing here should be read as one. It exists so a tenant can express a DEFAULT — "treat these
 * regions as requiring both sides to be told" — and have the engine apply it consistently instead
 * of leaving it to whoever configured the last DID. `docs/recording-compliance.md` says the same
 * thing at greater length, and says it to the person who has to sign off on the setting. Confirm
 * your obligations with counsel.
 *
 * The tenant's configured region list is what actually decides. This module answers only "which
 * regions does this number look like it belongs to", and {@link requiresAllParty} intersects that
 * with the list the tenant configured. Ship a different list and the behaviour changes with no code
 * change; ship an empty list and this module decides nothing at all.
 *
 * ## Why an NPA is an approximation and is used anyway
 *
 * `+1 415…` used to mean San Francisco because the number was welded to a copper pair in San
 * Francisco. Local number portability broke that in 1997 and mobility finished the job: a person
 * keeps their number through a move across the country, a VoIP DID can be ordered in any rate
 * centre from anywhere, and an entire generation now carries the area code of the city they went to
 * college in. An NPA therefore proves nothing about where a human being is sitting when the phone
 * rings.
 *
 * The alternative is worse. The platform does not know where the parties are — it has a SIP
 * signalling address, which is the carrier's edge, and a caller ID, which is this. Geolocating an
 * IP would be a stronger claim on weaker evidence, and asking the caller is a question no caller
 * answers honestly under time pressure. So the NPA is used as a HINT that biases toward telling
 * people more often than strictly required: a false positive plays an announcement to someone who
 * did not need to hear one, which costs three seconds; a false negative is a recording made without
 * a disclosure someone was owed. Those two errors are not the same size, and the mapping is
 * deliberately tuned toward the cheap one.
 *
 * ## Why the tables are compiled in
 *
 * `@optimiq-voice/telephony` carries no runtime dependencies and explains at length why it holds no
 * libphonenumber metadata. This module keeps that promise: two frozen `ReadonlyMap`s built once at
 * module load, looked up by `Map.get` rather than scanned. The consent gate runs on the call path
 * before a recording tap exists, and a linear scan of two thousand NPAs per leg is a cost paid on
 * every recorded call for an answer that never changes.
 *
 * The tables are a snapshot of the NANP assignment set and the ITU calling-code list as of writing.
 * They will drift. Drift in the NPA table degrades gracefully — an unrecognised NPA returns `[]`,
 * which means "no all-party region matched", which means the tenant's explicit policy still applies
 * unchanged. That is the right failure: an unknown number never silently suppresses an announcement
 * a tenant asked for, it only fails to add one they did not.
 */

/** The regions a NANP NPA resolves to, most specific first. Frozen once, shared by every lookup. */
type Regions = readonly string[];

/**
 * US NPAs by USPS state code. Non-geographic NPAs (toll-free, premium, personal communications) are
 * deliberately ABSENT rather than mapped to `"US"`: a toll-free number is reachable from anywhere
 * and dialled by someone whose location it says nothing about, so claiming a US jurisdiction from
 * `+1 800…` would be a fabricated fact. Those return `[]`.
 */
const US_NPAS: Readonly<Record<string, readonly string[]>> = {
	AK: ["907"],
	AL: ["205", "251", "256", "334", "659", "938"],
	AR: ["327", "479", "501", "870"],
	AZ: ["480", "520", "602", "623", "928"],
	CA: [
		"209",
		"213",
		"279",
		"310",
		"323",
		"341",
		"350",
		"408",
		"415",
		"424",
		"442",
		"510",
		"530",
		"559",
		"562",
		"619",
		"626",
		"628",
		"650",
		"657",
		"661",
		"669",
		"707",
		"714",
		"747",
		"760",
		"805",
		"818",
		"820",
		"831",
		"840",
		"858",
		"909",
		"916",
		"925",
		"949",
		"951",
	],
	CO: ["303", "719", "720", "970", "983"],
	CT: ["203", "475", "860", "959"],
	DC: ["202"],
	DE: ["302"],
	FL: [
		"239",
		"305",
		"321",
		"324",
		"352",
		"386",
		"407",
		"448",
		"561",
		"656",
		"689",
		"727",
		"754",
		"772",
		"786",
		"813",
		"850",
		"863",
		"904",
		"941",
		"954",
	],
	GA: ["229", "404", "470", "478", "678", "706", "762", "770", "912", "943"],
	HI: ["808"],
	IA: ["319", "515", "563", "641", "712"],
	ID: ["208", "986"],
	IL: [
		"217",
		"224",
		"309",
		"312",
		"331",
		"447",
		"464",
		"618",
		"630",
		"708",
		"730",
		"773",
		"779",
		"815",
		"847",
		"861",
		"872",
	],
	IN: ["219", "260", "317", "463", "574", "765", "812", "930"],
	KS: ["316", "620", "785", "913"],
	KY: ["270", "364", "502", "606", "859"],
	LA: ["225", "318", "337", "504", "985"],
	MA: ["339", "351", "413", "508", "617", "774", "781", "857", "978"],
	MD: ["227", "240", "301", "410", "443", "667"],
	ME: ["207"],
	MI: ["231", "248", "269", "313", "517", "586", "616", "679", "734", "810", "906", "947", "989"],
	MN: ["218", "320", "507", "612", "651", "763", "924", "952"],
	MO: ["235", "314", "417", "557", "573", "636", "660", "816", "975"],
	MS: ["228", "601", "662", "769"],
	MT: ["406"],
	NC: ["252", "336", "472", "704", "743", "828", "910", "919", "980", "984"],
	ND: ["701"],
	NE: ["308", "402", "531"],
	NH: ["603"],
	NJ: ["201", "551", "609", "640", "732", "848", "856", "862", "908", "973"],
	NM: ["505", "575"],
	NV: ["702", "725", "775"],
	NY: [
		"212",
		"315",
		"329",
		"332",
		"347",
		"363",
		"516",
		"518",
		"585",
		"607",
		"631",
		"646",
		"680",
		"716",
		"718",
		"838",
		"845",
		"914",
		"917",
		"929",
		"934",
	],
	OH: [
		"216",
		"220",
		"234",
		"283",
		"326",
		"330",
		"380",
		"419",
		"436",
		"440",
		"513",
		"567",
		"614",
		"740",
		"937",
	],
	OK: ["405", "539", "572", "580", "918"],
	OR: ["458", "503", "541", "971"],
	PA: [
		"215",
		"223",
		"267",
		"272",
		"412",
		"445",
		"484",
		"570",
		"582",
		"610",
		"717",
		"724",
		"814",
		"835",
		"878",
	],
	RI: ["401"],
	SC: ["803", "821", "839", "843", "854", "864"],
	SD: ["605"],
	TN: ["423", "615", "629", "731", "865", "901", "931"],
	TX: [
		"210",
		"214",
		"254",
		"281",
		"325",
		"346",
		"361",
		"409",
		"430",
		"432",
		"469",
		"512",
		"682",
		"713",
		"726",
		"737",
		"806",
		"817",
		"830",
		"832",
		"903",
		"915",
		"936",
		"940",
		"945",
		"956",
		"972",
		"979",
	],
	UT: ["385", "435", "801"],
	VA: ["276", "434", "540", "571", "686", "703", "757", "804", "826", "948"],
	VT: ["802"],
	WA: ["206", "253", "360", "425", "509", "564"],
	WI: ["262", "274", "353", "414", "534", "608", "715", "920"],
	WV: ["304", "681"],
	WY: ["307"],
};

/**
 * Canadian NPAs by province code.
 *
 * Two assignments are genuinely ambiguous and are handled below rather than here: `902`/`782` cover
 * Nova Scotia AND Prince Edward Island, and `867` covers all three territories. Naming one of them
 * would be a guess presented as a fact, so those numbers resolve to the country alone.
 */
const CA_NPAS: Readonly<Record<string, readonly string[]>> = {
	AB: ["368", "403", "587", "780", "825"],
	BC: ["236", "250", "257", "604", "672", "778"],
	MB: ["204", "431", "584"],
	NB: ["428", "506"],
	NL: ["709", "879"],
	ON: [
		"226",
		"249",
		"289",
		"343",
		"365",
		"382",
		"416",
		"437",
		"519",
		"548",
		"613",
		"647",
		"683",
		"705",
		"742",
		"753",
		"807",
		"905",
		"942",
	],
	QC: ["263", "354", "367", "418", "438", "450", "468", "514", "579", "581", "819", "873"],
	SK: ["306", "474", "639"],
};

/** NANP NPAs that are a country of their own — the Caribbean members and the US territories. */
const NANP_TERRITORY_NPAS: Readonly<Record<string, readonly string[]>> = {
	AG: ["268"],
	AI: ["264"],
	AS: ["684"],
	BB: ["246"],
	BM: ["441"],
	BS: ["242"],
	DM: ["767"],
	DO: ["809", "829", "849"],
	GD: ["473"],
	GU: ["671"],
	JM: ["658", "876"],
	KN: ["869"],
	KY: ["345"],
	LC: ["758"],
	MP: ["670"],
	MS: ["664"],
	PR: ["787", "939"],
	SX: ["721"],
	TC: ["649"],
	TT: ["868"],
	VC: ["784"],
	VG: ["284"],
	VI: ["340"],
};

/** Canada-wide NPAs whose province cannot be determined. See {@link CA_NPAS}. */
const CANADA_ONLY_NPAS: readonly string[] = ["782", "867", "902"];

/**
 * NPAs that name no place at all: toll-free, premium rate, personal communications, and the
 * carrier-internal codes. Present as an explicit set so an unrecognised NPA and a deliberately
 * non-geographic one are the same answer for the caller (`[]`) but different facts in this file.
 */
const NON_GEOGRAPHIC_NPAS: readonly string[] = [
	"500",
	"521",
	"522",
	"523",
	"524",
	"525",
	"526",
	"527",
	"528",
	"529",
	"532",
	"533",
	"535",
	"538",
	"542",
	"543",
	"544",
	"545",
	"546",
	"547",
	"549",
	"550",
	"552",
	"553",
	"554",
	"555",
	"556",
	"558",
	"566",
	"569",
	"577",
	"578",
	"588",
	"589",
	"600",
	"622",
	"700",
	"710",
	"800",
	"833",
	"844",
	"855",
	"866",
	"877",
	"888",
	"900",
];

/** The 27 member states of the European Union, listed rather than derived. */
const EU_MEMBERS: readonly string[] = [
	"AT",
	"BE",
	"BG",
	"CY",
	"CZ",
	"DE",
	"DK",
	"EE",
	"ES",
	"FI",
	"FR",
	"GR",
	"HR",
	"HU",
	"IE",
	"IT",
	"LT",
	"LU",
	"LV",
	"MT",
	"NL",
	"PL",
	"PT",
	"RO",
	"SE",
	"SI",
	"SK",
];

/**
 * ITU-T E.164 country calling codes to ISO 3166-1 alpha-2, for everything that is not `+1`.
 *
 * Three codes are shared by more than one country and resolve to the largest occupant, because a
 * wrong-but-consistent answer is auditable and a missing answer is not: `7` (Russia, also
 * Kazakhstan), `212` (Morocco, also Western Sahara) and `599` (Curaçao, formerly the wider
 * Netherlands Antilles).
 */
const CALLING_CODES: Readonly<Record<string, string>> = {
	"7": "RU",
	"20": "EG",
	"27": "ZA",
	"30": "GR",
	"31": "NL",
	"32": "BE",
	"33": "FR",
	"34": "ES",
	"36": "HU",
	"39": "IT",
	"40": "RO",
	"41": "CH",
	"43": "AT",
	"44": "GB",
	"45": "DK",
	"46": "SE",
	"47": "NO",
	"48": "PL",
	"49": "DE",
	"51": "PE",
	"52": "MX",
	"53": "CU",
	"54": "AR",
	"55": "BR",
	"56": "CL",
	"57": "CO",
	"58": "VE",
	"60": "MY",
	"61": "AU",
	"62": "ID",
	"63": "PH",
	"64": "NZ",
	"65": "SG",
	"66": "TH",
	"81": "JP",
	"82": "KR",
	"84": "VN",
	"86": "CN",
	"90": "TR",
	"91": "IN",
	"92": "PK",
	"93": "AF",
	"94": "LK",
	"95": "MM",
	"98": "IR",
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
	"290": "SH",
	"291": "ER",
	"297": "AW",
	"298": "FO",
	"299": "GL",
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
	"370": "LT",
	"371": "LV",
	"372": "EE",
	"373": "MD",
	"374": "AM",
	"375": "BY",
	"376": "AD",
	"377": "MC",
	"378": "SM",
	"379": "VA",
	"380": "UA",
	"381": "RS",
	"382": "ME",
	"383": "XK",
	"385": "HR",
	"386": "SI",
	"387": "BA",
	"389": "MK",
	"420": "CZ",
	"421": "SK",
	"423": "LI",
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
	"850": "KP",
	"852": "HK",
	"853": "MO",
	"855": "KH",
	"856": "LA",
	"880": "BD",
	"886": "TW",
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
	"992": "TJ",
	"993": "TM",
	"994": "AZ",
	"995": "GE",
	"996": "KG",
	"998": "UZ",
};

/**
 * NPA → regions, built once. The value is the finished, frozen answer — `["US-CA", "US"]` — so a
 * lookup on the call path allocates nothing and the caller cannot mutate the table by holding onto
 * what it returned.
 */
const NPA_REGIONS: ReadonlyMap<string, Regions> = buildNpaRegions();

/** Calling code → regions, built once. `["DE", "EU"]` for a member state, `["GB"]` otherwise. */
const CALLING_CODE_REGIONS: ReadonlyMap<string, Regions> = buildCallingCodeRegions();

/** The non-geographic NPAs as a set, so "known to be placeless" is one `has` and not a scan. */
const NON_GEOGRAPHIC: ReadonlySet<string> = new Set(NON_GEOGRAPHIC_NPAS);

const NO_REGIONS: Regions = Object.freeze([]);

function buildNpaRegions(): ReadonlyMap<string, Regions> {
	const table = new Map<string, Regions>();
	for (const [state, npas] of Object.entries(US_NPAS)) {
		const regions = Object.freeze([`US-${state}`, "US"]);
		for (const npa of npas) {
			table.set(npa, regions);
		}
	}
	for (const [province, npas] of Object.entries(CA_NPAS)) {
		const regions = Object.freeze([`CA-${province}`, "CA"]);
		for (const npa of npas) {
			table.set(npa, regions);
		}
	}
	const canadaOnly = Object.freeze(["CA"]);
	for (const npa of CANADA_ONLY_NPAS) {
		table.set(npa, canadaOnly);
	}
	for (const [country, npas] of Object.entries(NANP_TERRITORY_NPAS)) {
		const regions = Object.freeze([country]);
		for (const npa of npas) {
			table.set(npa, regions);
		}
	}
	return table;
}

function buildCallingCodeRegions(): ReadonlyMap<string, Regions> {
	const members = new Set(EU_MEMBERS);
	const table = new Map<string, Regions>();
	for (const [code, country] of Object.entries(CALLING_CODES)) {
		table.set(code, Object.freeze(members.has(country) ? [country, "EU"] : [country]));
	}
	return table;
}

/**
 * Every jurisdiction an E.164 number resolves to, most specific first. Empty when unknown.
 *
 * "Most specific first" is the contract the consent gate depends on: a tenant that configures
 * `US-CA` and a tenant that configures `US` both match a Los Angeles number, and a log line that
 * says which region matched should name the state rather than the country when both were on the
 * list. Empty is returned for anything that cannot be read as a number, for a non-geographic NANP
 * code, and for a calling code this table does not carry — all three mean the same thing to the
 * caller, which is "decide from the tenant's explicit policy alone".
 *
 * The input is normalised rather than merely validated, because callers hand this whatever the
 * carrier put in a SIP From header and that is not reliably canonical. A national number with no
 * country context stays unknown: `normalizeE164` refuses to guess `+1`, and guessing here would be
 * worse than refusing, since the guess would silently produce a US jurisdiction for a number that
 * has none.
 */
export function regionsForNumber(input: string | undefined): Regions {
	if (input === undefined || input.length === 0) {
		return NO_REGIONS;
	}
	const e164 = isE164(input) ? input : normalizeToE164(input);
	if (e164 === null) {
		return NO_REGIONS;
	}

	const digits = e164.slice(1);
	if (digits.startsWith("1")) {
		// NANP is fixed-length: country code, three-digit NPA, seven-digit subscriber number.
		// Anything else carrying a `+1` is not a number this table can speak about.
		if (digits.length !== 11) {
			return NO_REGIONS;
		}
		const npa = digits.slice(1, 4);
		if (NON_GEOGRAPHIC.has(npa)) {
			return NO_REGIONS;
		}
		return NPA_REGIONS.get(npa) ?? NO_REGIONS;
	}

	// Longest prefix wins, and the search is bounded at three digits because E.164 assigns no
	// longer country code. Three `Map.get` calls, no iteration over the table.
	for (let length = 3; length >= 1; length -= 1) {
		const match = CALLING_CODE_REGIONS.get(digits.slice(0, length));
		if (match !== undefined) {
			return match;
		}
	}
	return NO_REGIONS;
}

/**
 * The configured all-party regions this call touches. Empty when none do.
 *
 * The result is ordered by the TENANT's list, not by the numbers, and deduplicated. Both choices
 * are about what the record means afterwards: `regions` lands on the consent record, on
 * `channel.record.started` and on the CDR leg, where it is read by a person asking "why did this
 * call announce". A stable order sourced from the configured list makes two calls with the same
 * cause produce the same string, and deduplication stops a caller and callee in the same state from
 * reading as two separate reasons.
 *
 * Matching is case-insensitive because the region list is a free-text tenant setting: someone will
 * type `us-ca`, and refusing to match it would silently disable a control they believe they turned
 * on. `undefined` entries are skipped rather than rejected — an unknown caller ID is the normal
 * shape of an anonymous inbound call, not an error.
 */
export function requiresAllParty(
	numbers: readonly (string | undefined)[],
	allPartyRegions: readonly string[],
): Regions {
	if (allPartyRegions.length === 0 || numbers.length === 0) {
		return NO_REGIONS;
	}

	const touched = new Set<string>();
	for (const number of numbers) {
		for (const region of regionsForNumber(number)) {
			touched.add(region.toUpperCase());
		}
	}
	if (touched.size === 0) {
		return NO_REGIONS;
	}

	const matched: string[] = [];
	const seen = new Set<string>();
	for (const configured of allPartyRegions) {
		const key = configured.toUpperCase();
		if (touched.has(key) && !seen.has(key)) {
			seen.add(key);
			matched.push(configured);
		}
	}
	return matched;
}

function normalizeToE164(input: string): string | null {
	const result = normalizeE164(input);
	return result.ok ? result.e164 : null;
}
