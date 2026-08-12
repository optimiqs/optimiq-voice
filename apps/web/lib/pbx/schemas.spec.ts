import { describe, expect, it } from "bun:test";
import {
	callBlockRuleFormSchema,
	conferenceFormSchema,
	dialableString,
	e164,
	emergencyAddressFormSchema,
	extensionFormSchema,
	featureCodeFormSchema,
	greetingUploadFormSchema,
	inboundRouteFormSchema,
	internalNumber,
	ivrMenuFormSchema,
	keypadPinIssue,
	mohClassFormSchema,
	mohClassName,
	outboundRouteFormSchema,
	pagingGroupFormSchema,
	pagingGroupMemberFormSchema,
	parkLotFormSchema,
	parseDialPatterns,
	phoneNumberFormSchema,
	promptFormSchema,
	queueAgentFormSchema,
	queueFormSchema,
	queueTierFormSchema,
	ringGroupFormSchema,
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
			pickupGroup: "",
			callScreening: false,
			callTimeoutSeconds: "",
			maxRegistrations: "",
			mohClassId: "",
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
			pickupGroup: "",
			callScreening: false,
			callTimeoutSeconds: "",
			maxRegistrations: "",
			mohClassId: "",
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
			pickupGroup: "",
			callScreening: false,
			callTimeoutSeconds: "4",
			maxRegistrations: "",
			mohClassId: "",
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

/**
 * The pickup group, where blank and absent are not the same fact.
 *
 * Every other optional text column on an extension is cosmetic when it is empty — a caller-id name
 * nobody set. This one decides who may answer a ringing phone with `*8`, so the normalisation is
 * asserted rather than inherited: a group named `" "` would be a real group with one accidental
 * member, and `null` is the documented "no group, fall back to organization-wide pickup".
 */
describe("the pickup group", () => {
	const base = {
		number: "1001",
		label: "Alice",
		sipSecretRef: "secret://x",
		callerIdName: "",
		callerIdNumber: "",
		outboundCallerIdNumber: "",
		tollClass: "national" as const,
		recordPolicy: "none" as const,
		pickupGroup: "",
		callScreening: false,
		callTimeoutSeconds: "",
		maxRegistrations: "",
		mohClassId: "",
		voicemailEnabled: true,
		doNotDisturb: false,
		enabled: true,
	};

	it("sends a blank group as null, so the extension leaves the group it was in", () => {
		expect(extensionFormSchema.parse(base).pickupGroup).toBeNull();
	});

	it("treats a whitespace-only group as no group, not as a group named with spaces", () => {
		expect(extensionFormSchema.parse({ ...base, pickupGroup: "   " }).pickupGroup).toBeNull();
	});

	it("trims, because a stray space would be a one-member group nobody meant to make", () => {
		expect(extensionFormSchema.parse({ ...base, pickupGroup: " sales " }).pickupGroup).toBe(
			"sales",
		);
	});

	it("keeps case, because Sales and sales are two groups to the compiler", () => {
		expect(extensionFormSchema.parse({ ...base, pickupGroup: "Sales" }).pickupGroup).toBe("Sales");
	});

	it("holds the group to the server's own 64-character bound", () => {
		expect(extensionFormSchema.safeParse({ ...base, pickupGroup: "g".repeat(64) }).success).toBe(
			true,
		);
		expect(extensionFormSchema.safeParse({ ...base, pickupGroup: "g".repeat(65) }).success).toBe(
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

describe("queueFormSchema", () => {
	const base = {
		name: "Support",
		extensionNumber: "",
		strategy: "longest-idle" as const,
		mohClassId: "",
		greetingPromptId: "",
		announcePromptId: "",
		agentWhisperPromptId: "",
		maxWaitSeconds: "",
		maxWaitNoAgentSeconds: "",
		wrapUpSeconds: "",
		announcePositionEnabled: false,
		announceFrequencySeconds: "",
		abandonedResumeAllowed: false,
		discardAbandonedAfterSeconds: "",
		tierRulesApply: true,
		tierRuleWaitSeconds: "",
		tierRuleNoAgentNoWait: false,
		recordEnabled: false,
		enabled: true,
	};

	/**
	 * The whole point of `resettable` on the server: an emptied numeric control means "put it back
	 * to the default", which is `null` on the wire — not `""`, and not the column's current value.
	 */
	it("turns every emptied number into a null rather than a zero", () => {
		const parsed = queueFormSchema.parse(base);
		expect(parsed.maxWaitSeconds).toBeNull();
		expect(parsed.wrapUpSeconds).toBeNull();
		expect(parsed.tierRuleWaitSeconds).toBeNull();
	});

	/** 0 is a REAL value here — it disables the cap and makes callers wait indefinitely. */
	it("keeps a zero wait cap, which is not the same as leaving it empty", () => {
		expect(queueFormSchema.parse({ ...base, maxWaitSeconds: "0" }).maxWaitSeconds).toBe(0);
	});

	it("bounds the announcement interval at the server's own floor of 5 seconds", () => {
		expect(queueFormSchema.safeParse({ ...base, announceFrequencySeconds: "4" }).success).toBe(
			false,
		);
		expect(queueFormSchema.safeParse({ ...base, announceFrequencySeconds: "5" }).success).toBe(
			true,
		);
	});

	it("refuses a wait cap past a day and an internal number with letters in it", () => {
		expect(queueFormSchema.safeParse({ ...base, maxWaitSeconds: "86401" }).success).toBe(false);
		expect(queueFormSchema.safeParse({ ...base, extensionNumber: "70a0" }).success).toBe(false);
		expect(queueFormSchema.parse({ ...base, extensionNumber: "" }).extensionNumber).toBeNull();
	});
});

describe("queueAgentFormSchema", () => {
	const base = {
		name: "Alice Chen",
		contactKind: "extension" as const,
		extensionId: "0193f2aa-0000-7000-8000-000000000001",
		contact: "",
		status: "logged-out" as const,
		wrapUpSeconds: "",
		maxNoAnswer: "",
		noAnswerDelaySeconds: "",
		busyDelaySeconds: "",
		rejectDelaySeconds: "",
		enabled: true,
	};

	/**
	 * The reachability pair, mirrored from the server's `assertReachable`. An agent the engine
	 * cannot dial is a seat that silently never rings — the queue simply times out — so both layers
	 * refuse it, and this one puts the message on the control the user was editing.
	 */
	it("an extension-backed agent needs an extension", () => {
		const result = queueAgentFormSchema.safeParse({ ...base, extensionId: "" });
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["extensionId"]);
	});

	it("an external agent needs a number, and is happy without an extension", () => {
		const external = { ...base, contactKind: "external" as const, extensionId: "" };
		const result = queueAgentFormSchema.safeParse(external);
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["contact"]);

		expect(queueAgentFormSchema.safeParse({ ...external, contact: "+12125550100" }).success).toBe(
			true,
		);
	});

	it("rejects a contact that is not dialable", () => {
		const external = { ...base, contactKind: "external" as const, extensionId: "" };
		expect(queueAgentFormSchema.safeParse({ ...external, contact: "call alice" }).success).toBe(
			false,
		);
	});

	it("keeps at least one no-answer attempt — zero would never offer the agent a call", () => {
		expect(queueAgentFormSchema.safeParse({ ...base, maxNoAnswer: "0" }).success).toBe(false);
		expect(queueAgentFormSchema.safeParse({ ...base, maxNoAnswer: "1" }).success).toBe(true);
	});
});

describe("queueTierFormSchema", () => {
	const base = {
		queueId: "0193f2aa-0000-7000-8000-000000000002",
		queueAgentId: "0193f2aa-0000-7000-8000-000000000003",
		level: "",
		position: "",
	};

	/**
	 * `queueId` is validated here and never sent: it is the endpoint's path segment. The dialog is
	 * opened from a queue's page (where it is context) AND from the agent list (where it is a
	 * choice), and the second case is the one that needs a "pick a queue" message.
	 */
	it("requires both ends of the membership", () => {
		expect(queueTierFormSchema.safeParse({ ...base, queueId: "" }).success).toBe(false);
		expect(queueTierFormSchema.safeParse({ ...base, queueAgentId: "" }).success).toBe(false);
		expect(queueTierFormSchema.safeParse(base).success).toBe(true);
	});

	/** Level and position are 1-based: there is no tier zero, and no agent at position zero. */
	it("keeps level and position 1-based, and lets both fall back to the server default", () => {
		expect(queueTierFormSchema.safeParse({ ...base, level: "0" }).success).toBe(false);
		expect(queueTierFormSchema.safeParse({ ...base, position: "0" }).success).toBe(false);
		expect(queueTierFormSchema.safeParse({ ...base, level: "101" }).success).toBe(false);

		const parsed = queueTierFormSchema.parse(base);
		expect(parsed.level).toBeNull();
		expect(parsed.position).toBeNull();
	});
});

/**
 * Paging groups, mirroring `paging-groups.dto.ts`.
 *
 * Two facts are asserted here rather than left to a round trip, because both are places where a
 * paging group looks like a ring group and is not.
 *
 * The first is the NUMBER: it is genuinely optional, because a group reachable only through `*81`
 * has none. A form that required one would make an operator invent digits, and the schema's unique
 * index would then have them collide with an extension.
 *
 * The second is the TIMEOUT's ceiling. 300, not the ring group's 600, and the difference is not a
 * rounding: a ring group's timeout is how long a HUMAN is given to pick up, while this is how long
 * an AUTO-ANSWERED leg may take to come up. Copying the ring group's bound here would let a typo
 * pin fan-out resources open for ten minutes on a group that never waits for anybody.
 */
describe("pagingGroupFormSchema", () => {
	const base = {
		name: "All handsets",
		extensionNumber: "",
		duplex: false,
		timeoutSeconds: "",
		enabled: true,
	};

	it("sends a blank number as null, because *81 is a complete way to reach a group", () => {
		expect(pagingGroupFormSchema.parse(base).extensionNumber).toBeNull();
		expect(pagingGroupFormSchema.parse({ ...base, extensionNumber: "8100" }).extensionNumber).toBe(
			"8100",
		);
	});

	it("refuses a number with letters in it", () => {
		expect(pagingGroupFormSchema.safeParse({ ...base, extensionNumber: "81a0" }).success).toBe(
			false,
		);
	});

	/** `resettable` on the server: an emptied control means "put the default back", which is `null`. */
	it("turns an emptied timeout into null rather than a zero", () => {
		expect(pagingGroupFormSchema.parse(base).timeoutSeconds).toBeNull();
		expect(pagingGroupFormSchema.parse({ ...base, timeoutSeconds: "30" }).timeoutSeconds).toBe(30);
	});

	it("holds the timeout to the server's 5 and 300, which are not the ring group's", () => {
		expect(pagingGroupFormSchema.safeParse({ ...base, timeoutSeconds: "4" }).success).toBe(false);
		expect(pagingGroupFormSchema.safeParse({ ...base, timeoutSeconds: "5" }).success).toBe(true);
		expect(pagingGroupFormSchema.safeParse({ ...base, timeoutSeconds: "300" }).success).toBe(true);
		expect(pagingGroupFormSchema.safeParse({ ...base, timeoutSeconds: "301" }).success).toBe(false);
		expect(pagingGroupFormSchema.safeParse({ ...base, timeoutSeconds: "600" }).success).toBe(false);
	});

	/**
	 * There is no destination trio on this form and there must not be one. A page has nowhere to
	 * continue to, and a strict object is what stops a copied block from adding one silently.
	 */
	it("refuses a destination, because a page does not go anywhere when it ends", () => {
		expect(
			pagingGroupFormSchema.safeParse({ ...base, timeoutDestinationType: "voicemail" }).success,
		).toBe(false);
	});
});

/**
 * A member, where the difference from a ring-group member is the whole design.
 *
 * A ring group's member is a DESTINATION and may be a mobile over a trunk. A paging member is an
 * `extension_id` and may not be anything else, because the engine originates an auto-answered leg
 * to it — an external number cannot be told to pick up. So the reference is REQUIRED here where
 * every other selector on a PBX form treats blank as "clear it".
 */
describe("pagingGroupMemberFormSchema", () => {
	const id = "019fd5fb-de54-700b-8826-8cf8ab5199af";
	const base = { extensionId: id, ordinal: "0", enabled: true };

	it("requires an extension, because a member with none pages nobody", () => {
		expect(pagingGroupMemberFormSchema.safeParse({ ...base, extensionId: "" }).success).toBe(false);
		expect(pagingGroupMemberFormSchema.safeParse({ ...base, extensionId: "  " }).success).toBe(
			false,
		);
	});

	it("refuses anything that is not a uuid, since the options ARE ids", () => {
		expect(pagingGroupMemberFormSchema.safeParse({ ...base, extensionId: "1001" }).success).toBe(
			false,
		);
		expect(pagingGroupMemberFormSchema.parse({ ...base, extensionId: ` ${id} ` }).extensionId).toBe(
			id,
		);
	});

	it("holds the ordinal to the server's 0 and 1000, and keeps a zero", () => {
		expect(pagingGroupMemberFormSchema.parse(base).ordinal).toBe(0);
		expect(pagingGroupMemberFormSchema.safeParse({ ...base, ordinal: "1000" }).success).toBe(true);
		expect(pagingGroupMemberFormSchema.safeParse({ ...base, ordinal: "1001" }).success).toBe(false);
		expect(pagingGroupMemberFormSchema.safeParse({ ...base, ordinal: "-1" }).success).toBe(false);
	});

	/** A member carries no destination and no timing of its own — both live on the group. */
	it("refuses a destination and a per-member timeout", () => {
		expect(
			pagingGroupMemberFormSchema.safeParse({ ...base, destinationType: "extension" }).success,
		).toBe(false);
		expect(pagingGroupMemberFormSchema.safeParse({ ...base, timeoutSeconds: "10" }).success).toBe(
			false,
		);
	});
});

/**
 * The screening rule, where what the schema does NOT do is the whole design.
 *
 * `pattern` is bounded by length and by nothing else, because `compilePattern` runs inside the
 * server's write transaction and is the only opinion that decides whether a rule can be enforced.
 * These tests pin that absence: a regex the browser refuses is a rule the engine would have
 * happily enforced, and a form that refused it would be lying about what the platform accepts.
 */
describe("callBlockRuleFormSchema", () => {
	const base = {
		pattern: "+12125550100",
		matchKind: "exact" as const,
		direction: "inbound" as const,
		action: "block" as const,
		label: "",
		enabled: true,
	};

	it("takes an exact number, a prefix and a regular expression through the same field", () => {
		expect(callBlockRuleFormSchema.safeParse(base).success).toBe(true);
		expect(
			callBlockRuleFormSchema.safeParse({ ...base, matchKind: "prefix", pattern: "+1212555" })
				.success,
		).toBe(true);
		expect(
			callBlockRuleFormSchema.safeParse({
				...base,
				matchKind: "regex",
				pattern: "^\\+1212555\\d{4}$",
			}).success,
		).toBe(true);
	});

	/**
	 * The rule this schema deliberately does not have. A regex is legal against `matchKind: "exact"`
	 * as far as the edge is concerned — the compiler will treat it as a literal and say so — and a
	 * client-side pairing check would refuse a save the server accepts.
	 */
	it("does not check the pattern against the match kind; the compiler does that", () => {
		expect(
			callBlockRuleFormSchema.safeParse({ ...base, matchKind: "exact", pattern: "^\\+1[0-9]+$" })
				.success,
		).toBe(true);
		expect(
			callBlockRuleFormSchema.safeParse({ ...base, matchKind: "regex", pattern: "(" }).success,
		).toBe(true);
	});

	it("holds the pattern to the server's 1 and 256", () => {
		expect(callBlockRuleFormSchema.safeParse({ ...base, pattern: "" }).success).toBe(false);
		expect(callBlockRuleFormSchema.safeParse({ ...base, pattern: "   " }).success).toBe(false);
		expect(callBlockRuleFormSchema.safeParse({ ...base, pattern: "9".repeat(256) }).success).toBe(
			true,
		);
		expect(callBlockRuleFormSchema.safeParse({ ...base, pattern: "9".repeat(257) }).success).toBe(
			false,
		);
	});

	/** `label` is `nullish` on the server, so a cleared note is `null` and never a zero-length one. */
	it("sends a blank label as null", () => {
		expect(callBlockRuleFormSchema.parse(base).label).toBeNull();
		expect(callBlockRuleFormSchema.parse({ ...base, label: " Robocaller " }).label).toBe(
			"Robocaller",
		);
	});

	it("offers no match kind the server has not got, including routes' `any`", () => {
		expect(callBlockRuleFormSchema.safeParse({ ...base, matchKind: "any" }).success).toBe(false);
		expect(callBlockRuleFormSchema.safeParse({ ...base, action: "hangup" }).success).toBe(false);
		expect(callBlockRuleFormSchema.safeParse({ ...base, direction: "internal" }).success).toBe(
			false,
		);
	});

	/**
	 * The two counters the enforcement side owns. The server answers a body carrying one with a 400
	 * naming the field rather than dropping it, so a form that offered them would fail the whole
	 * save — and a destination is refused for the reason `call_block_rule` has no trio at all: the
	 * compiler maps `voicemail` to the CALLEE's own mailbox, not to somewhere a rule chose.
	 */
	it("refuses the hit counters and a destination, which the DTO would answer with a 400", () => {
		expect(callBlockRuleFormSchema.safeParse({ ...base, hitCount: 4 }).success).toBe(false);
		expect(
			callBlockRuleFormSchema.safeParse({ ...base, lastHitAt: "2026-01-01T00:00:00.000Z" }).success,
		).toBe(false);
		expect(
			callBlockRuleFormSchema.safeParse({ ...base, destinationType: "voicemail" }).success,
		).toBe(false);
	});
});

describe("conferenceFormSchema", () => {
	const base = {
		name: "All hands",
		roomNumber: "8000",
		maxMembers: "",
		mohClassId: "",
		recordEnabled: false,
		announceJoinLeave: true,
		waitForModerator: false,
		enabled: true,
	};

	it("needs a dialable room number", () => {
		expect(conferenceFormSchema.safeParse(base).success).toBe(true);
		expect(conferenceFormSchema.safeParse({ ...base, roomNumber: "" }).success).toBe(false);
		expect(conferenceFormSchema.safeParse({ ...base, roomNumber: "80a0" }).success).toBe(false);
	});

	/** A room of one is a phone call. The server's floor is 2 and this mirrors it. */
	it("keeps a room at two seats or more", () => {
		expect(conferenceFormSchema.safeParse({ ...base, maxMembers: "1" }).success).toBe(false);
		expect(conferenceFormSchema.safeParse({ ...base, maxMembers: "2" }).success).toBe(true);
		expect(conferenceFormSchema.safeParse({ ...base, maxMembers: "1001" }).success).toBe(false);
	});

	/**
	 * There are no PIN fields, and that is load-bearing: the API does not accept a digest in a JSON
	 * body, so a form offering one would store nothing while looking like it had.
	 */
	it("has no PIN fields at all", () => {
		expect(conferenceFormSchema.safeParse({ ...base, pinHash: "whatever" } as never).success).toBe(
			false,
		);
	});
});

describe("parkLotFormSchema", () => {
	const base = {
		name: "Reception",
		slotStart: "701",
		slotEnd: "720",
		timeoutSeconds: "",
		mohClassId: "",
		enabled: true,
	};

	/**
	 * The only REQUIRED integers in the PBX area. Every other number on a PBX form has a server
	 * default, so blank means "use it"; here blank is a missing column and a 400 with no field.
	 */
	it("requires both ends of the slot range", () => {
		expect(parkLotFormSchema.safeParse({ ...base, slotStart: "" }).success).toBe(false);
		expect(parkLotFormSchema.safeParse({ ...base, slotEnd: "" }).success).toBe(false);
		expect(parkLotFormSchema.parse(base).slotStart).toBe(701);
	});

	/** Mirrors the server's refinement, which mirrors a check constraint. */
	it("refuses a range that runs backwards, and lands the message on the last slot", () => {
		const result = parkLotFormSchema.safeParse({ ...base, slotStart: "720", slotEnd: "701" });
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["slotEnd"]);
	});

	it("allows a lot of exactly one slot", () => {
		expect(parkLotFormSchema.safeParse({ ...base, slotStart: "701", slotEnd: "701" }).success).toBe(
			true,
		);
	});

	it("bounds the park timeout at the server's floor of 5 seconds", () => {
		expect(parkLotFormSchema.safeParse({ ...base, timeoutSeconds: "4" }).success).toBe(false);
		expect(parkLotFormSchema.safeParse({ ...base, timeoutSeconds: "5" }).success).toBe(true);
		expect(parkLotFormSchema.parse(base).timeoutSeconds).toBeNull();
	});
});

// ---------------------------------------------------------------------------------------------
// The media library
// ---------------------------------------------------------------------------------------------

describe("mohClassName, which becomes a section name in the media server's configuration", () => {
	/**
	 * Stricter than `displayName`, and the reason is not cosmetic.
	 *
	 * The compiler resolves every `mohClassId` in a tenant's configuration to this NAME, and the
	 * media server looks it up as a section in `musiconhold.conf`. A `]` or a newline in it is a
	 * configuration file that does not parse — which takes hold music away from every extension,
	 * queue, conference and park lot on the box, not just this class.
	 */
	it("accepts what a media server will take as a class name", () => {
		expect(mohClassName.safeParse("default").success).toBe(true);
		expect(mohClassName.safeParse("office-hours_v2.1").success).toBe(true);
		expect(mohClassName.safeParse("8bit").success).toBe(true);
	});

	it("refuses anything that could break the configuration file it lands in", () => {
		expect(mohClassName.safeParse("hold]music").success).toBe(false);
		expect(mohClassName.safeParse("hold music").success).toBe(false);
		expect(mohClassName.safeParse("hold\nmusic").success).toBe(false);
		expect(mohClassName.safeParse("-leading-dash").success).toBe(false);
		expect(mohClassName.safeParse("").success).toBe(false);
	});
});

describe("mohClassFormSchema", () => {
	const base = {
		name: "office-hours",
		description: "",
		source: "library" as const,
		streamUri: "",
		shuffle: true,
		sampleRateHz: 8000 as const,
		isDefault: false,
		enabled: true,
	};

	it("accepts a library class with no stream URI", () => {
		const result = mohClassFormSchema.parse(base);
		expect(result.streamUri).toBeNull();
		expect(result.description).toBeNull();
	});

	/**
	 * Mirrors the server's refinement. A streaming class with no URI plays silence to everyone on
	 * hold and the media server has no way to report it, so both layers refuse — on the field that
	 * is missing, so the message lands on the control that produced it.
	 */
	it("refuses a streaming class with no URI, on streamUri", () => {
		const result = mohClassFormSchema.safeParse({ ...base, source: "stream" });
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["streamUri"]);
	});

	it("accepts a streaming class that names its source", () => {
		expect(
			mohClassFormSchema.safeParse({
				...base,
				source: "stream",
				streamUri: "http://ice.example.test/hold",
			}).success,
		).toBe(true);
	});

	/**
	 * A LIBRARY class with a stream URI is deliberately allowed.
	 *
	 * Switching a class back and forth while keeping the URI on the row is a normal thing to do, and
	 * losing it on every switch would be hostile.
	 */
	it("allows a library class to keep a stream URI it is not using", () => {
		expect(
			mohClassFormSchema.safeParse({ ...base, streamUri: "http://ice.example.test/hold" }).success,
		).toBe(true);
	});

	it("offers only the three sample rates the stack can serve without surprise", () => {
		expect(mohClassFormSchema.safeParse({ ...base, sampleRateHz: 8000 }).success).toBe(true);
		expect(mohClassFormSchema.safeParse({ ...base, sampleRateHz: 44_100 }).success).toBe(false);
	});
});

describe("promptFormSchema", () => {
	it("requires a name and a well-formed language tag", () => {
		expect(promptFormSchema.safeParse({ name: "Welcome", language: "en-US" }).success).toBe(true);
		expect(promptFormSchema.safeParse({ name: "Welcome", language: "en" }).success).toBe(true);
		expect(promptFormSchema.safeParse({ name: "", language: "en-US" }).success).toBe(false);
		// The grammar is BCP 47's, not a list of known tags: `english` is a well-formed 7-letter
		// primary subtag and is accepted, `en_US` is not a tag at all. Checking the shape rather than
		// the registry is deliberate — a hard-coded list of languages is a list that goes stale.
		expect(promptFormSchema.safeParse({ name: "Welcome", language: "en_US" }).success).toBe(false);
		expect(promptFormSchema.safeParse({ name: "Welcome", language: "e" }).success).toBe(false);
	});

	/**
	 * The object key is not here and never will be.
	 *
	 * It is the only thing standing between a row and a file, and RLS does not protect the
	 * filesystem: accepting one from a client would let an admin re-point a library entry at another
	 * tenant's audio by editing a string. `z.strictObject` is what makes that a parse failure here
	 * rather than a silently dropped key.
	 */
	it("refuses an object key, so a prompt cannot be re-pointed at another file", () => {
		expect(
			promptFormSchema.safeParse({
				name: "Welcome",
				language: "en-US",
				objectKey: "prompts/somebody-else/secret.wav",
			}).success,
		).toBe(false);
	});
});

describe("greetingUploadFormSchema", () => {
	it("takes one of the four slots, an optional label and an explicit active flag", () => {
		const result = greetingUploadFormSchema.parse({
			kind: "temporary",
			label: "",
			active: true,
		});
		expect(result.kind).toBe("temporary");
		expect(result.label).toBeNull();
		expect(result.active).toBe(true);
	});

	it("refuses a kind the server does not model", () => {
		expect(
			greetingUploadFormSchema.safeParse({ kind: "holiday", label: "", active: true }).success,
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------
// E911
// ---------------------------------------------------------------------------------------------

describe("emergencyAddressFormSchema", () => {
	const base = {
		label: "Head office",
		streetLine1: "1 Telephone Road",
		streetLine2: "",
		locationDetail: "Floor 3, Room 314",
		locality: "Springfield",
		administrativeArea: "IL",
		postalCode: "62701",
		country: "us",
	};

	it("upper-cases the country so one address is not stored twice", () => {
		expect(emergencyAddressFormSchema.parse(base).country).toBe("US");
	});

	it("requires the four fields that are wrong to omit in every jurisdiction", () => {
		expect(emergencyAddressFormSchema.safeParse({ ...base, streetLine1: "  " }).success).toBe(
			false,
		);
		expect(emergencyAddressFormSchema.safeParse({ ...base, locality: "" }).success).toBe(false);
		expect(emergencyAddressFormSchema.safeParse({ ...base, administrativeArea: "" }).success).toBe(
			false,
		);
		expect(emergencyAddressFormSchema.safeParse({ ...base, postalCode: "" }).success).toBe(false);
	});

	/**
	 * The dispatchable-location detail is optional, and that is a product decision rather than an
	 * oversight: a single-occupancy building genuinely has none. The screen marks it strongly
	 * recommended and says why — a responder given a twelve-floor office block and no floor number
	 * is the failure RAY BAUM'S Act was written about.
	 */
	it("allows an address with no floor or room, because some buildings have none", () => {
		expect(emergencyAddressFormSchema.safeParse({ ...base, locationDetail: "" }).success).toBe(
			true,
		);
		expect(
			emergencyAddressFormSchema.parse({ ...base, locationDetail: "" }).locationDetail,
		).toBeNull();
	});

	it("refuses a country code that is not two letters", () => {
		expect(emergencyAddressFormSchema.safeParse({ ...base, country: "USA" }).success).toBe(false);
		expect(emergencyAddressFormSchema.safeParse({ ...base, country: "12" }).success).toBe(false);
	});

	/**
	 * `validated` is a fact a CARRIER asserted, never a value an admin may set.
	 *
	 * Accepting it here would let anyone with `numbers.emergency` mark an unverified address as
	 * verified, which for a field whose entire purpose is regulatory assurance is not a validation
	 * bug but a compliance one. The server refuses it too; this is the client half of the same rule.
	 */
	it("refuses a self-declared `validated`", () => {
		expect(emergencyAddressFormSchema.safeParse({ ...base, validated: true }).success).toBe(false);
	});
});

describe("phoneNumberFormSchema, now carrying a dispatchable location", () => {
	const base = {
		e164: "+12125550100",
		label: "",
		callerIdNamePrefix: "",
		recordEnabled: false,
		emergencyAddressId: "",
		voiceEnabled: true,
		faxEnabled: false,
		enabled: true,
	};

	/**
	 * Blank clears it, which on a `PATCH` is `null` rather than `""` — the column is a uuid foreign
	 * key and an empty string is a `22P02` the user cannot act on.
	 */
	it("clears the emergency address to null rather than to an empty string", () => {
		expect(phoneNumberFormSchema.parse(base).emergencyAddressId).toBeNull();
	});

	it("keeps an assigned address", () => {
		const id = "019fd5fb-de54-700b-8826-8cf8ab5199af";
		expect(
			phoneNumberFormSchema.parse({ ...base, emergencyAddressId: id }).emergencyAddressId,
		).toBe(id);
	});
});

// ---------------------------------------------------------------------------------------------
// The audio selectors: every column that names a hold-music class or a prompt
// ---------------------------------------------------------------------------------------------

/**
 * The complete set of `moh_class` and `prompt` references on a PBX form, held in one table.
 *
 * A table rather than twelve near-identical `it` blocks, because the claim being made is the same
 * for every one of them and the risk being guarded against is a column being ADDED to the schema
 * with the wrong helper. A loop over a list that names each column is the only shape where adding
 * the thirteenth means adding one line here rather than remembering that this file exists.
 *
 * The bases carry a blank string in every selector, which is what `defaultsFor(null)` produces in
 * each dialog — so what these tests parse is what a freshly opened create form would submit.
 */
const AUDIO_REFERENCE_FORMS = [
	{
		label: "extensionFormSchema",
		schema: extensionFormSchema,
		base: {
			number: "1001",
			label: "Alice",
			sipSecretRef: "secret://x",
			callerIdName: "",
			callerIdNumber: "",
			outboundCallerIdNumber: "",
			tollClass: "national",
			recordPolicy: "none",
			pickupGroup: "",
			callScreening: false,
			callTimeoutSeconds: "",
			maxRegistrations: "",
			mohClassId: "",
			voicemailEnabled: true,
			doNotDisturb: false,
			enabled: true,
		},
		columns: ["mohClassId"],
	},
	{
		label: "queueFormSchema",
		schema: queueFormSchema,
		base: {
			name: "Support",
			extensionNumber: "",
			strategy: "longest-idle",
			mohClassId: "",
			greetingPromptId: "",
			announcePromptId: "",
			agentWhisperPromptId: "",
			maxWaitSeconds: "",
			maxWaitNoAgentSeconds: "",
			wrapUpSeconds: "",
			announcePositionEnabled: false,
			announceFrequencySeconds: "",
			abandonedResumeAllowed: false,
			discardAbandonedAfterSeconds: "",
			tierRulesApply: true,
			tierRuleWaitSeconds: "",
			tierRuleNoAgentNoWait: false,
			recordEnabled: false,
			enabled: true,
		},
		/**
		 * `agentWhisperPromptId` is the fourth, and it is the one that plays to the OTHER side of the
		 * bridge — the answering agent alone, never the caller. Same helper, same null-on-blank rule.
		 */
		columns: ["mohClassId", "greetingPromptId", "announcePromptId", "agentWhisperPromptId"],
	},
	{
		label: "ringGroupFormSchema",
		schema: ringGroupFormSchema,
		base: {
			name: "Sales",
			extensionNumber: "",
			strategy: "simultaneous",
			ringTimeoutSeconds: "",
			callerIdNamePrefix: "",
			ignoreBusy: false,
			confirmEnabled: false,
			confirmPromptId: "",
			mohClassId: "",
			ringbackPromptId: "",
			enabled: true,
		},
		columns: ["confirmPromptId", "mohClassId", "ringbackPromptId"],
	},
	{
		label: "ivrMenuFormSchema",
		schema: ivrMenuFormSchema,
		base: {
			name: "Main menu",
			extensionNumber: "",
			digitTimeoutMs: "",
			interDigitTimeoutMs: "",
			maxDigits: "",
			maxFailures: "",
			maxTimeouts: "",
			greetingPromptId: "",
			shortGreetingPromptId: "",
			invalidPromptId: "",
			timeoutPromptId: "",
			directDialEnabled: false,
			enabled: true,
		},
		columns: ["greetingPromptId", "shortGreetingPromptId", "invalidPromptId", "timeoutPromptId"],
	},
	{
		label: "conferenceFormSchema",
		schema: conferenceFormSchema,
		base: {
			name: "All hands",
			roomNumber: "8000",
			maxMembers: "",
			mohClassId: "",
			recordEnabled: false,
			announceJoinLeave: true,
			waitForModerator: false,
			enabled: true,
		},
		columns: ["mohClassId"],
	},
	{
		label: "parkLotFormSchema",
		schema: parkLotFormSchema,
		base: {
			name: "Reception",
			slotStart: "701",
			slotEnd: "720",
			timeoutSeconds: "",
			mohClassId: "",
			enabled: true,
		},
		columns: ["mohClassId"],
	},
] as const;

describe("optionalReference, on every column that names a class or a prompt", () => {
	const id = "019fd5fb-de54-700b-8826-8cf8ab5199af";

	/**
	 * The behaviour change these tests exist to pin down.
	 *
	 * Before there was a picker, these columns were absent from the schemas entirely, so a save left
	 * whatever was stored alone. Now an emptied selector means "play nothing" and has to reach the
	 * server as `null` — an absent key would let an operator clear the hold music, press Save, and
	 * hear the old class on the next call with nothing on screen disagreeing.
	 */
	for (const form of AUDIO_REFERENCE_FORMS) {
		it(`${form.label}: an emptied selector parses to null, not to "" and not to undefined`, () => {
			const parsed = form.schema.parse(form.base) as Record<string, unknown>;
			for (const column of form.columns) {
				expect(parsed[column]).toBeNull();
			}
		});

		it(`${form.label}: a chosen row survives the parse unchanged`, () => {
			for (const column of form.columns) {
				const parsed = form.schema.parse({ ...form.base, [column]: id }) as Record<string, unknown>;
				expect(parsed[column]).toBe(id);
			}
		});

		/**
		 * Anything that is not a uuid in one of these controls is a bug in this app — the options ARE
		 * ids — so it is refused here rather than sent for the server to answer with a 400 that names
		 * no field. Surrounding whitespace is trimmed first, because a select whose value was pasted
		 * in by a test or a browser extension should not fail on it.
		 */
		it(`${form.label}: refuses a value that is not a uuid`, () => {
			for (const column of form.columns) {
				expect(form.schema.safeParse({ ...form.base, [column]: "the-default-one" }).success).toBe(
					false,
				);
				expect(form.schema.safeParse({ ...form.base, [column]: ` ${id} ` }).success).toBe(true);
			}
		});
	}
});

// ---------------------------------------------------------------------------------------------
// PINs
// ---------------------------------------------------------------------------------------------

/**
 * One policy for the mailbox PIN and both conference PINs, mirroring `voicemailPinIssue` on the
 * server — which is itself one function serving all three.
 *
 * The two refused SHAPES exist because of the engine's three-attempt limit rather than because of
 * entropy: a PIN drawn from the handful of sequences every attacker tries FIRST is materially
 * weaker than one that is not. The blocklist stops there deliberately; a longer one starts guessing
 * at what a user meant and produces "rejected, and I do not know why".
 */
describe("keypadPinIssue, mirrored from voicemail-boxes.dto.ts", () => {
	it("accepts a PIN a telephone keypad can enter", () => {
		expect(keypadPinIssue("80412")).toBeUndefined();
		expect(keypadPinIssue("5193")).toBeUndefined();
		expect(keypadPinIssue("9042317685")).toBeUndefined();
	});

	it("refuses anything but digits, because the keypad has ten keys", () => {
		expect(keypadPinIssue("12ab")).toBeDefined();
		expect(keypadPinIssue("80 12")).toBeDefined();
	});

	it("bounds the length at the server's four and ten", () => {
		expect(keypadPinIssue("123")).toBeDefined();
		expect(keypadPinIssue("12345678901")).toBeDefined();
	});

	it("refuses one repeated digit and a straight run in either direction", () => {
		expect(keypadPinIssue("0000")).toBeDefined();
		expect(keypadPinIssue("9999")).toBeDefined();
		expect(keypadPinIssue("1234")).toBeDefined();
		expect(keypadPinIssue("4321")).toBeDefined();
		expect(keypadPinIssue("98765")).toBeDefined();
	});

	/** Two adjacent digits are not a run. The rule is about the WHOLE PIN counting. */
	it("does not refuse a PIN that merely contains consecutive digits", () => {
		expect(keypadPinIssue("1245")).toBeUndefined();
	});
});
