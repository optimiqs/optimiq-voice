import { describe, expect, it } from "bun:test";
import {
	dialableString,
	e164,
	extensionFormSchema,
	featureCodeFormSchema,
	inboundRouteFormSchema,
	internalNumber,
	outboundRouteFormSchema,
	parseDialPatterns,
	timeRuleFormSchema,
	timezoneName,
	voicemailBoxFormSchema,
} from "./schemas";

/**
 * These schemas MIRROR `apps/api/src/pbx/shared/dto.ts` rather than importing it, so the mirror
 * is what needs proving: the same inputs the server accepts and rejects, asserted here.
 *
 * Where a client rule is STRICTER than the server's, that is called out — a client-only rule is a
 * product decision (an unreachable route, a mailbox that deletes every message) and has to be
 * deliberate rather than accidental.
 */

describe("shared primitives, mirrored from shared/dto.ts", () => {
	it("internalNumber is digits only — the * space belongs to feature codes", () => {
		expect(internalNumber.safeParse("1001").success).toBe(true);
		expect(internalNumber.safeParse("*97").success).toBe(false);
		expect(internalNumber.safeParse("10a1").success).toBe(false);
		expect(internalNumber.safeParse("").success).toBe(false);
		expect(internalNumber.safeParse("12345678901234567").success).toBe(false);
	});

	it("e164 requires the plus and a non-zero country code", () => {
		expect(e164.safeParse("+12125550100").success).toBe(true);
		expect(e164.safeParse("12125550100").success).toBe(false);
		expect(e164.safeParse("+02125550100").success).toBe(false);
		expect(e164.safeParse("+1").success).toBe(false);
	});

	it("dialableString allows what a PBX actually dials", () => {
		expect(dialableString.safeParse("*97").success).toBe(true);
		expect(dialableString.safeParse("+12125550100").success).toBe(true);
		expect(dialableString.safeParse("sip:alice@example.com").success).toBe(false);
	});

	it("timezoneName wants an IANA zone, because an unknown one fails the compile", () => {
		expect(timezoneName.safeParse("America/New_York").success).toBe(true);
		expect(timezoneName.safeParse("UTC").success).toBe(true);
		expect(timezoneName.safeParse("EST").success).toBe(false);
		expect(timezoneName.safeParse("").success).toBe(false);
	});
});

describe("optional text", () => {
	/**
	 * Blank means "clear it", which on a PATCH is `null` — not `""`. An empty string would be
	 * stored verbatim, so a caller-id name the user cleared would come back zero-length rather
	 * than absent.
	 */
	it("turns a blank control into null, and trims what is left", () => {
		const parsed = extensionFormSchema.parse({
			number: "1001",
			label: "Alice",
			sipSecretRef: "secret://x",
			callerIdName: "   ",
			callerIdNumber: " 1001 ",
			outboundCallerIdNumber: "",
			tollClass: "national",
			recordPolicy: "none",
			callTimeoutSeconds: "",
			maxRegistrations: "",
			voicemailEnabled: true,
			doNotDisturb: false,
			enabled: true,
		});
		expect(parsed.callerIdName).toBeNull();
		expect(parsed.callerIdNumber).toBe("1001");
		expect(parsed.outboundCallerIdNumber).toBeNull();
	});

	/**
	 * `callTimeoutSeconds` is `.optional()` on the server, not `.nullish()` — so a blank field has
	 * to become an ABSENT key, and `null` here is the signal the form turns into `undefined`.
	 */
	it("turns a blank optional number into null, for the form to omit", () => {
		const values = {
			number: "1001",
			label: "Alice",
			sipSecretRef: "secret://x",
			callerIdName: "",
			callerIdNumber: "",
			outboundCallerIdNumber: "",
			tollClass: "national" as const,
			recordPolicy: "none" as const,
			callTimeoutSeconds: "",
			maxRegistrations: "",
			voicemailEnabled: true,
			doNotDisturb: false,
			enabled: true,
		};
		expect(extensionFormSchema.parse(values).callTimeoutSeconds).toBeNull();
		expect(
			extensionFormSchema.parse({ ...values, callTimeoutSeconds: "45" }).callTimeoutSeconds,
		).toBe(45);
	});

	it("holds an optional number to the server's own range", () => {
		const values = {
			number: "1001",
			label: "Alice",
			sipSecretRef: "secret://x",
			callerIdName: "",
			callerIdNumber: "",
			outboundCallerIdNumber: "",
			tollClass: "national" as const,
			recordPolicy: "none" as const,
			callTimeoutSeconds: "4",
			maxRegistrations: "",
			voicemailEnabled: true,
			doNotDisturb: false,
			enabled: true,
		};
		expect(extensionFormSchema.safeParse(values).success).toBe(false);
		expect(extensionFormSchema.safeParse({ ...values, callTimeoutSeconds: "5" }).success).toBe(
			true,
		);
		expect(extensionFormSchema.safeParse({ ...values, callTimeoutSeconds: "5.5" }).success).toBe(
			false,
		);
	});
});

describe("inboundRouteFormSchema", () => {
	const base = {
		name: "Main line",
		priority: "100",
		matchKind: "exact" as const,
		matchPattern: "",
		phoneNumberId: "",
		callerIdPattern: "",
		timeConditionId: "",
		recordEnabled: false,
		enabled: true,
	};

	/**
	 * Client-only rule, and a deliberate one: the server accepts a route with no pattern and no
	 * number, which compiles and then never fires. That is indistinguishable from a route that was
	 * never saved.
	 */
	it("refuses a route that can never match", () => {
		const result = inboundRouteFormSchema.safeParse(base);
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["matchPattern"]);
	});

	it("accepts a pattern, a narrowed number, or matching anything", () => {
		expect(inboundRouteFormSchema.safeParse({ ...base, matchPattern: "+1212" }).success).toBe(true);
		expect(
			inboundRouteFormSchema.safeParse({
				...base,
				phoneNumberId: "0193f2aa-0000-7000-8000-000000000001",
			}).success,
		).toBe(true);
		expect(inboundRouteFormSchema.safeParse({ ...base, matchKind: "any" }).success).toBe(true);
	});
});

describe("outboundRouteFormSchema", () => {
	const base = {
		name: "National",
		priority: "100",
		matchKind: "prefix" as const,
		dialPatterns: ["0XXXXXXXXX"],
		stripDigits: "1",
		prependDigits: "+1",
		tollClass: "national" as const,
		trunkIds: [],
		timeConditionId: "",
		callerIdNumberOverride: "",
		recordEnabled: false,
		enabled: true,
	};

	/** The anti-toll-fraud gate. The server never defaults it, so neither does this. */
	it("requires a toll class", () => {
		expect(outboundRouteFormSchema.safeParse({ ...base, tollClass: "" }).success).toBe(false);
		expect(outboundRouteFormSchema.safeParse(base).success).toBe(true);
	});

	it("requires at least one dial pattern", () => {
		expect(outboundRouteFormSchema.safeParse({ ...base, dialPatterns: [] }).success).toBe(false);
	});

	/** A route with no trunks compiles and every call on it fails — the server allows it, so do we. */
	it("allows a route with no trunks", () => {
		expect(outboundRouteFormSchema.safeParse({ ...base, trunkIds: [] }).success).toBe(true);
	});

	it("rejects a trunk id that is not a uuid, before the server has to", () => {
		expect(outboundRouteFormSchema.safeParse({ ...base, trunkIds: ["not-a-uuid"] }).success).toBe(
			false,
		);
	});
});

describe("parseDialPatterns", () => {
	it("splits on newlines and commas, and drops the blanks a textarea leaves behind", () => {
		expect(parseDialPatterns("0XXXXXXXXX\n\n 00X. ,\n1NXXNXXXXXX")).toEqual([
			"0XXXXXXXXX",
			"00X.",
			"1NXXNXXXXXX",
		]);
		expect(parseDialPatterns("   ")).toEqual([]);
	});
});

describe("timeRuleFormSchema", () => {
	const base = {
		label: "Office hours",
		ordinal: "0",
		weekdays: [1, 2, 3, 4, 5],
		fromTime: "09:00",
		toTime: "17:00",
		fromDate: "",
		toDate: "",
		enabled: true,
	};

	it("accepts a weekday window", () => {
		expect(timeRuleFormSchema.safeParse(base).success).toBe(true);
	});

	/** `from > to` wraps midnight — 22:00 to 06:00 is the night shift, not an error. */
	it("accepts a window that crosses midnight", () => {
		expect(
			timeRuleFormSchema.safeParse({ ...base, fromTime: "22:00", toTime: "06:00" }).success,
		).toBe(true);
	});

	it("requires both ends of a window, or neither", () => {
		const result = timeRuleFormSchema.safeParse({ ...base, toTime: "" });
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["toTime"]);
	});

	it("rejects a clock value that is not HH:MM", () => {
		expect(timeRuleFormSchema.safeParse({ ...base, fromTime: "9am" }).success).toBe(false);
		expect(timeRuleFormSchema.safeParse({ ...base, fromTime: "24:00" }).success).toBe(false);
	});

	/**
	 * An empty predicate matches always — legitimate as a default branch, but as the ONLY rule it
	 * makes the no-match destination unreachable, which is never what "business hours" meant.
	 */
	it("refuses a rule with nothing in it", () => {
		const result = timeRuleFormSchema.safeParse({
			...base,
			weekdays: [],
			fromTime: "",
			toTime: "",
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["weekdays"]);
	});

	it("accepts a date range on its own, for a holiday", () => {
		expect(
			timeRuleFormSchema.safeParse({
				...base,
				weekdays: [],
				fromTime: "",
				toTime: "",
				fromDate: "2026-12-24",
				toDate: "2026-12-26",
			}).success,
		).toBe(true);
	});
});

describe("featureCodeFormSchema", () => {
	it("requires the leading star", () => {
		const base = { code: "97", action: "voicemail-check" as const, label: "", enabled: true };
		expect(featureCodeFormSchema.safeParse(base).success).toBe(false);
		expect(featureCodeFormSchema.safeParse({ ...base, code: "*97" }).success).toBe(true);
		expect(featureCodeFormSchema.safeParse({ ...base, code: "*9a" }).success).toBe(false);
	});
});

describe("voicemailBoxFormSchema", () => {
	const base = {
		mailboxNumber: "1001",
		label: "",
		emailAddress: "",
		emailMode: "none" as const,
		deleteAfterDelivery: false,
		transcriptionEnabled: false,
		mwiEnabled: true,
		maxMessages: "",
		maxMessageSeconds: "",
		enabled: true,
	};

	/**
	 * Client-only rule. The server accepts the combination — it is only unsound in context — but a
	 * box that deletes after delivering with nowhere to deliver destroys every message it takes.
	 */
	it("refuses delete-after-delivery with no email address", () => {
		const result = voicemailBoxFormSchema.safeParse({ ...base, deleteAfterDelivery: true });
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["emailAddress"]);

		expect(
			voicemailBoxFormSchema.safeParse({
				...base,
				deleteAfterDelivery: true,
				emailAddress: "alice@example.com",
			}).success,
		).toBe(true);
	});

	it("treats a blank email as absent rather than as an invalid address", () => {
		expect(voicemailBoxFormSchema.parse(base).emailAddress).toBeNull();
		expect(voicemailBoxFormSchema.safeParse({ ...base, emailAddress: "nope" }).success).toBe(false);
	});
});
