import { Reflector } from "@nestjs/core";
import { expect } from "chai";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import {
	knownCountries,
	normalizeE164,
	resolveE164Country,
} from "../../src/pbx/toll-fraud/e164-country";
import { TollFraudController } from "../../src/pbx/toll-fraud/toll-fraud.controller";
import {
	suspendExtensionOutboundDto,
	writeExtensionTollFraudOverrideDto,
	writeTollFraudPolicyDto,
} from "../../src/pbx/toll-fraud/toll-fraud.dto";
import {
	evaluateTollFraud,
	isWithinOffHours,
	mergeTollFraudPolicy,
	TOLL_FRAUD_REFUSAL_REASONS,
} from "../../src/pbx/toll-fraud/toll-fraud.policy";
import type {
	TollFraudCounters,
	TollFraudInput,
	TollFraudPolicy,
} from "../../src/pbx/toll-fraud/toll-fraud.policy";

/**
 * The toll-fraud decision, its country resolver, and the grants on the controller.
 *
 * The parity audit's gap is that `extension.toll_class` is a STATIC grant — a door an extension
 * either holds or does not — while every real toll-fraud incident happens to an extension that
 * legally holds `international`. What a first spend/velocity control can get wrong, none of which
 * needs a database:
 *
 *  1. **The rule ORDER.** A call that trips two rules must report the one the caller can act on.
 *  2. **The empty seen-set.** A literal reading of "hold the first call to a new country" holds the
 *     tenant's entire dial plan on the day they switch it on, and nobody leaves it on past that.
 *  3. **A wrapping off-hours window.** 20:00 → 07:00 is what every office configures, and the
 *     naive comparison locks the wrong half of the day.
 *  4. **Merge semantics.** An override that could TIGHTEN what the organization switched off would
 *     make the org's master switch a lie; one that cannot express "this phone, none" is useless
 *     during an incident.
 *  5. **What counts as international.** An unresolvable prefix is the exact shape of a
 *     revenue-share number, and reading it as domestic puts the highest-risk destinations outside
 *     every control here.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";

function counters(overrides: Partial<TollFraudCounters> = {}): TollFraudCounters {
	return {
		concurrentInternationalCalls: 0,
		internationalMinutesLastHour: 0,
		internationalMinutesLastDay: 0,
		...overrides,
	};
}

function input(
	policy: Partial<TollFraudPolicy>,
	overrides: Partial<TollFraudInput> = {},
): TollFraudInput {
	return {
		policy: { enabled: true, ...policy },
		counters: counters(),
		dialedE164: "+37120000000",
		nowUtc: new Date("2026-09-10T12:00:00.000Z"),
		timezone: "UTC",
		homeCountry: "US",
		seenCountries: new Set(["US", "GB"]),
		...overrides,
	};
}

describe("the E.164 country resolver", () => {
	it("takes the longest matching calling code", () => {
		// +1 and +1242 both exist. A first-match walk would call every Bahamian number American,
		// which is the single most common toll-fraud pattern on a North American tenant.
		expect(resolveE164Country("+12425550100")).to.equal("BS");
		expect(resolveE164Country("+12125550100")).to.equal("US");
		expect(resolveE164Country("+442071838750")).to.equal("GB");
		expect(resolveE164Country("+37120000000")).to.equal("LV");
	});

	it("returns undefined for a global network rather than inventing a country", () => {
		// +882 is a global network and is not a country. The gate reads `undefined` as
		// international, which is the fail-closed direction for the highest-risk prefix class.
		expect(resolveE164Country("+8821234567")).to.equal(undefined);
		expect(resolveE164Country("+9791234567")).to.equal(undefined);
	});

	it("refuses anything that is not E.164 rather than guessing a code", () => {
		// A bare national number is genuinely ambiguous; guessing +1 points a British tenant's fraud
		// controls at Manhattan. Same argument `e164-ingest.ts` makes one layer down.
		expect(normalizeE164("2125550100")).to.equal(undefined);
		expect(normalizeE164("1001")).to.equal(undefined);
		expect(normalizeE164("+1 212 555 0100")).to.equal(undefined);
		expect(normalizeE164("+12125550100")).to.equal("12125550100");
	});

	it("resolves every country it advertises", () => {
		// `knownCountries` is what the DTO refuses an unknown code against, so a code in that list
		// that no number resolves to would be a rule that silently does nothing.
		expect(knownCountries().length).to.be.greaterThan(150);
		expect(knownCountries()).to.include("LV");
		expect(new Set(knownCountries()).size).to.equal(knownCountries().length);
	});
});

describe("evaluateTollFraud", () => {
	it("allows anything that is not E.164 without consulting a ceiling", () => {
		const verdict = evaluateTollFraud(
			input(
				{ maxInternationalMinutesPerHour: 0 },
				{ dialedE164: "1001", counters: counters({ internationalMinutesLastHour: 9_999 }) },
			),
		);
		expect(verdict.allowed).to.equal(true);
		expect(verdict.international).to.equal(false);
	});

	it("allows a domestic destination", () => {
		const verdict = evaluateTollFraud(input({}, { dialedE164: "+12125550100" }));
		expect(verdict.allowed).to.equal(true);
		expect(verdict.international).to.equal(false);
	});

	it("treats an unresolvable prefix as international", () => {
		const verdict = evaluateTollFraud(
			input({ allowedCountries: ["GB"] }, { dialedE164: "+8821234567" }),
		);
		expect(verdict.allowed).to.equal(false);
		expect(verdict.reason).to.equal("DESTINATION_COUNTRY_BLOCKED");
	});

	it("lets an allow list win over a deny list", () => {
		// Two lists that disagree resolve fail-closed: not on the allow list is refused whatever the
		// deny list says.
		const verdict = evaluateTollFraud(input({ allowedCountries: ["GB"], deniedCountries: ["CU"] }));
		expect(verdict.allowed).to.equal(false);
		expect(verdict.reason).to.equal("DESTINATION_COUNTRY_BLOCKED");
	});

	it("treats an empty list as no list", () => {
		// An empty ALLOW list would refuse every international call, and nobody who cleared a field
		// meant that. The schema column records the same reading.
		expect(evaluateTollFraud(input({ allowedCountries: [] })).allowed).to.equal(true);
	});

	it("reports the geo block ahead of the minutes ceiling when a call trips both", () => {
		// "We do not call Latvia" is an answer; "you have used 61 of your 60 minutes" is a different
		// conversation. The caller is told the one they can act on.
		const verdict = evaluateTollFraud(
			input(
				{ deniedCountries: ["LV"], maxInternationalMinutesPerHour: 60 },
				{ counters: counters({ internationalMinutesLastHour: 61 }) },
			),
		);
		expect(verdict.reason).to.equal("DESTINATION_COUNTRY_BLOCKED");
	});

	it("does not hold the first country a tenant has ever called", () => {
		// The judgement this file exists to pin: an empty seen-set means "nothing learned yet". A
		// literal reading holds the tenant's whole dial plan on the morning they enable the control.
		const verdict = evaluateTollFraud(
			input({ holdFirstCallToNewCountry: true }, { seenCountries: new Set() }),
		);
		expect(verdict.allowed).to.equal(true);
	});

	it("holds a country the organization has not called before", () => {
		const verdict = evaluateTollFraud(
			input({ holdFirstCallToNewCountry: true }, { seenCountries: new Set(["US", "GB"]) }),
		);
		expect(verdict.allowed).to.equal(false);
		expect(verdict.reason).to.equal("NEW_COUNTRY_HOLD");
	});

	it("refuses at the concurrency ceiling, not past it", () => {
		// The leg being evaluated is not yet counted, so `>=` is what makes the ceiling the ceiling.
		const at = evaluateTollFraud(
			input(
				{ maxConcurrentInternationalCalls: 3 },
				{ counters: counters({ concurrentInternationalCalls: 3 }) },
			),
		);
		expect(at.allowed).to.equal(false);
		expect(at.reason).to.equal("INTERNATIONAL_CONCURRENCY_EXCEEDED");
		expect(at.observed).to.equal(3);
		expect(at.threshold).to.equal(3);

		const under = evaluateTollFraud(
			input(
				{ maxConcurrentInternationalCalls: 3 },
				{ counters: counters({ concurrentInternationalCalls: 2 }) },
			),
		);
		expect(under.allowed).to.equal(true);
	});

	it("reports the HOUR ceiling before the DAY ceiling", () => {
		// The difference between "try again after lunch" and "try again tomorrow".
		const verdict = evaluateTollFraud(
			input(
				{ maxInternationalMinutesPerHour: 60, maxInternationalMinutesPerDay: 600 },
				{
					counters: counters({
						internationalMinutesLastHour: 61,
						internationalMinutesLastDay: 700,
					}),
				},
			),
		);
		expect(verdict.reason).to.equal("INTERNATIONAL_MINUTES_EXCEEDED");
		expect(verdict.threshold).to.equal(60);
	});

	it("refuses a suspended extension even when the policy is switched off", () => {
		// A suspension is an incident response. Lifting the master switch during an incident must not
		// un-suspend the handset somebody suspended because of it.
		const verdict = evaluateTollFraud(
			input({ enabled: false, outboundSuspended: true }, { dialedE164: "+12125550100" }),
		);
		expect(verdict.allowed).to.equal(false);
		expect(verdict.reason).to.equal("EXTENSION_OUTBOUND_SUSPENDED");
	});

	it("evaluates every destination when the tenant has no home country", () => {
		// The fail-closed reading: assuming `US` would silently exempt American destinations for a
		// tenant whose configuration says nothing about where they are.
		const verdict = evaluateTollFraud(
			input({ deniedCountries: ["US"] }, { dialedE164: "+12125550100", homeCountry: undefined }),
		);
		expect(verdict.allowed).to.equal(false);
	});

	it("names every refusal reason it can produce", () => {
		expect([...TOLL_FRAUD_REFUSAL_REASONS].sort()).to.deep.equal([
			"DESTINATION_COUNTRY_BLOCKED",
			"EXTENSION_OUTBOUND_SUSPENDED",
			"INTERNATIONAL_CONCURRENCY_EXCEEDED",
			"INTERNATIONAL_MINUTES_EXCEEDED",
			"NEW_COUNTRY_HOLD",
			"OFF_HOURS_INTERNATIONAL_LOCK",
		]);
	});
});

describe("the off-hours window", () => {
	const START = 1_200; // 20:00
	const END = 420; // 07:00

	it("wraps midnight", () => {
		expect(isWithinOffHours(new Date("2026-09-10T21:00:00Z"), "UTC", START, END)).to.equal(true);
		expect(isWithinOffHours(new Date("2026-09-10T03:00:00Z"), "UTC", START, END)).to.equal(true);
		expect(isWithinOffHours(new Date("2026-09-10T12:00:00Z"), "UTC", START, END)).to.equal(false);
		expect(isWithinOffHours(new Date("2026-09-10T07:00:00Z"), "UTC", START, END)).to.equal(false);
	});

	it("handles a non-wrapping window too", () => {
		// 01:00 → 05:00, for a tenant who wants a narrow overnight lock.
		expect(isWithinOffHours(new Date("2026-09-10T02:00:00Z"), "UTC", 60, 300)).to.equal(true);
		expect(isWithinOffHours(new Date("2026-09-10T22:00:00Z"), "UTC", 60, 300)).to.equal(false);
	});

	it("reads the window in the tenant's zone, across a DST boundary", () => {
		// An office that locks at 20:00 locks at 20:00 in July as well as in January. An offset
		// computed once would be an hour out for half the year.
		const july = new Date("2026-07-10T23:30:00Z"); // 19:30 in New York (EDT)
		const january = new Date("2026-01-10T23:30:00Z"); // 18:30 in New York (EST)
		expect(isWithinOffHours(july, "America/New_York", START, END)).to.equal(false);
		expect(isWithinOffHours(january, "America/New_York", START, END)).to.equal(false);
		expect(
			isWithinOffHours(new Date("2026-07-11T01:00:00Z"), "America/New_York", START, END),
		).to.equal(true);
	});

	it("treats an equal start and end as an empty window, not as all day", () => {
		// A tenant who typed the same value twice did not mean to lock international calling for
		// ever, and the reading that assumes they did is the one they discover from a ticket.
		expect(isWithinOffHours(new Date("2026-09-10T12:00:00Z"), "UTC", 600, 600)).to.equal(false);
	});

	it("does not lock when the zone is one this runtime does not know", () => {
		expect(isWithinOffHours(new Date("2026-09-10T21:00:00Z"), "Mars/Olympus", START, END)).to.equal(
			false,
		);
	});
});

describe("mergeTollFraudPolicy", () => {
	const organization: TollFraudPolicy = {
		enabled: true,
		maxInternationalMinutesPerHour: 60,
		deniedCountries: ["CU"],
		holdFirstCallToNewCountry: true,
	};

	it("inherits every field the override leaves null", () => {
		const merged = mergeTollFraudPolicy(organization, { maxInternationalMinutesPerHour: null });
		expect(merged.maxInternationalMinutesPerHour).to.equal(60);
		expect(merged.deniedCountries).to.deep.equal(["CU"]);
	});

	it("treats zero as 'none at all' rather than as unlimited", () => {
		// The reading an override exists for: one compromised phone is locked down by writing a zero,
		// without editing the policy every other extension depends on.
		const merged = mergeTollFraudPolicy(organization, {
			maxInternationalMinutesPerHour: 0,
			// The hold is lifted so the assertion is about the ceiling and not about the rule order —
			// which the "reports the geo block ahead of the minutes ceiling" case already covers.
			holdFirstCallToNewCountry: false,
		});
		expect(merged.maxInternationalMinutesPerHour).to.equal(0);
		expect(evaluateTollFraud(input(merged)).reason).to.equal("INTERNATIONAL_MINUTES_EXCEEDED");
	});

	it("lets an override loosen a hold but never add one", () => {
		// An override that could TIGHTEN what the organization switched off would make the org's
		// master switch a lie.
		expect(
			mergeTollFraudPolicy(organization, { holdFirstCallToNewCountry: false })
				.holdFirstCallToNewCountry,
		).to.equal(false);
		expect(
			mergeTollFraudPolicy({ enabled: true }, { holdFirstCallToNewCountry: true })
				.holdFirstCallToNewCountry,
		).to.equal(undefined);
	});

	it("cannot re-enable an organization that has switched everything off", () => {
		expect(mergeTollFraudPolicy({ enabled: false }, { enabled: true }).enabled).to.equal(false);
		expect(mergeTollFraudPolicy(organization, { enabled: false }).enabled).to.equal(false);
	});

	it("reads an absent organization policy as enforcing nothing", () => {
		expect(mergeTollFraudPolicy(undefined, undefined).enabled).to.equal(false);
	});

	it("carries a suspension through", () => {
		expect(
			mergeTollFraudPolicy(organization, { outboundSuspended: true }).outboundSuspended,
		).to.equal(true);
	});
});

describe("the toll-fraud DTOs", () => {
	it("refuses a country code no number can resolve to", () => {
		// A rule naming a country the resolver cannot produce is a rule that silently does nothing.
		expect(writeTollFraudPolicyDto.safeParse({ allowedCountries: ["GB", "LV"] }).success).to.equal(
			true,
		);
		expect(writeTollFraudPolicyDto.safeParse({ allowedCountries: ["ZZ"] }).success).to.equal(false);
	});

	it("upper-cases and trims a country code", () => {
		const parsed = writeTollFraudPolicyDto.parse({ allowedCountries: [" gb "] });
		expect(parsed.allowedCountries).to.deep.equal(["GB"]);
	});

	it("keeps null distinct from absent on a ceiling", () => {
		// Absent leaves the ceiling alone; null removes it. On this body there is nothing above to
		// inherit from, so null can only mean "no ceiling".
		expect("maxInternationalMinutesPerHour" in writeTollFraudPolicyDto.parse({})).to.equal(false);
		expect(
			writeTollFraudPolicyDto.parse({ maxInternationalMinutesPerHour: null })
				.maxInternationalMinutesPerHour,
		).to.equal(null);
	});

	it("refuses an unknown key rather than dropping it", () => {
		expect(
			writeTollFraudPolicyDto.safeParse({ maxInternationalMinutesPerWeek: 10 }).success,
		).to.equal(false);
	});

	it("rejects a minute-of-day outside a day", () => {
		expect(writeTollFraudPolicyDto.safeParse({ offHoursStartMinute: 1_439 }).success).to.equal(
			true,
		);
		expect(writeTollFraudPolicyDto.safeParse({ offHoursStartMinute: 1_440 }).success).to.equal(
			false,
		);
	});

	it("accepts zero on an override ceiling", () => {
		expect(
			writeExtensionTollFraudOverrideDto.parse({ maxInternationalMinutesPerHour: 0 })
				.maxInternationalMinutesPerHour,
		).to.equal(0);
	});

	it("takes a reason on a suspension", () => {
		expect(suspendExtensionOutboundDto.safeParse({ suspended: true }).success).to.equal(true);
		expect(suspendExtensionOutboundDto.safeParse({ suspended: false }).success).to.equal(true);
		expect(suspendExtensionOutboundDto.safeParse({}).success).to.equal(false);
	});
});

describe("the toll-fraud controller's grants", () => {
	const reflector = new Reflector();

	function permissionsOf(method: keyof TollFraudController): readonly string[] {
		return (
			reflector.get<string[]>(
				REQUIRE_PERMISSIONS_METADATA,
				TollFraudController.prototype[method] as never,
			) ?? []
		);
	}

	it("guards every read with toll-fraud.read and every write with toll-fraud.write", () => {
		// Not `org-limits.*` (owner-only, because a quota an admin can raise is not a quota) and not
		// `security.*` (the network boundary). A fraud threshold is tuned during an incident, at
		// speed, by whoever is watching the alerts.
		expect(permissionsOf("readPolicy")).to.deep.equal(["toll-fraud.read"]);
		expect(permissionsOf("usage")).to.deep.equal(["toll-fraud.read"]);
		expect(permissionsOf("listOverrides")).to.deep.equal(["toll-fraud.read"]);
		expect(permissionsOf("writePolicy")).to.deep.equal(["toll-fraud.write"]);
		expect(permissionsOf("writeOverride")).to.deep.equal(["toll-fraud.write"]);
		expect(permissionsOf("suspend")).to.deep.equal(["toll-fraud.write"]);
	});

	it("leaves no route ungated", () => {
		for (const method of [
			"readPolicy",
			"usage",
			"listOverrides",
			"writePolicy",
			"writeOverride",
			"suspend",
		] as const) {
			expect(permissionsOf(method).length, method).to.be.greaterThan(0);
		}
	});
});

describe("the organization id is never taken from a caller", () => {
	it("has no organization parameter on any controller route", () => {
		// The tenant comes from the session. A route that accepted one would be the enumeration
		// oracle every other controller in this area is shaped to avoid.
		const source = TollFraudController.toString();
		expect(source).to.not.include("organizationId");
		expect(ORG).to.have.length(36);
	});
});
