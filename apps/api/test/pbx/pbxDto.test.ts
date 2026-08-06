import { BadRequestException } from "@nestjs/common";
import { expect } from "chai";
import { createExtensionDto, updateExtensionDto } from "../../src/pbx/extensions/extensions.dto";
import { createFeatureCodeDto } from "../../src/pbx/feature-codes/feature-codes.dto";
import { createOutboundRouteDto } from "../../src/pbx/outbound-routes/outbound-routes.dto";
import { createPhoneNumberDto } from "../../src/pbx/phone-numbers/phone-numbers.dto";
import { parseDto } from "../../src/pbx/shared/dto";
import { listQuerySchema, normalizePagination, paged } from "../../src/pbx/shared/pagination";
import { createTimeConditionRuleDto } from "../../src/pbx/time-conditions/time-conditions.dto";

/** The edge: what a request body is allowed to say, and what happens when it says something else. */
describe("pbx DTOs", () => {
	describe("parseDto", () => {
		it("returns the parsed value on success", () => {
			const parsed = parseDto(createExtensionDto, {
				number: "1001",
				label: "  Alice  ",
				sipSecretRef: "secret://x",
			});
			// `displayName` trims, so the stored label is not " Alice ".
			expect(parsed.label).to.equal("Alice");
		});

		it("throws a 400 carrying one issue per bad field", () => {
			let thrown: BadRequestException | undefined;
			try {
				parseDto(createExtensionDto, { number: "not-digits", label: "" });
			} catch (error) {
				thrown = error as BadRequestException;
			}
			expect(thrown).to.be.instanceOf(BadRequestException);
			const body = thrown?.getResponse() as Record<string, unknown>;
			expect(body.code).to.equal("PBX_INVALID_BODY");
			const issues = body.issues as { field: string }[];
			expect(issues.map((issue) => issue.field)).to.include.members([
				"number",
				"label",
				"sipSecretRef",
			]);
		});

		it("rejects an unknown key instead of silently dropping it", () => {
			expect(() =>
				parseDto(createExtensionDto, {
					number: "1001",
					label: "Alice",
					sipSecretRef: "s",
					recordEnabled: true,
				}),
			).to.throw(BadRequestException);
		});
	});

	describe("extensions", () => {
		it("requires digits for an internal number", () => {
			expect(
				createExtensionDto.safeParse({ number: "*97", label: "x", sipSecretRef: "s" }).success,
			).to.equal(false);
		});

		it("treats an absent key and an explicit null differently on PATCH", () => {
			const cleared = updateExtensionDto.parse({ callerIdName: null }) as Record<string, unknown>;
			expect("callerIdName" in cleared).to.equal(true);
			expect(cleared.callerIdName).to.equal(null);
			const untouched = updateExtensionDto.parse({}) as Record<string, unknown>;
			expect("callerIdName" in untouched).to.equal(false);
		});

		it("bounds the follow-me ladder", () => {
			const tooMany = {
				number: "1001",
				label: "Alice",
				sipSecretRef: "s",
				followMe: {
					enabled: true,
					targets: Array.from({ length: 11 }, () => ({
						destination: "+12125550100",
						delaySeconds: 0,
						timeoutSeconds: 30,
					})),
				},
			};
			expect(createExtensionDto.safeParse(tooMany).success).to.equal(false);
		});
	});

	describe("outbound routes", () => {
		const base = {
			name: "National",
			dialPatterns: ["0"],
			trunkPriority: [],
		};

		it("refuses a route with no toll class — the anti-toll-fraud gate is never defaulted", () => {
			expect(createOutboundRouteDto.safeParse(base).success).to.equal(false);
			expect(createOutboundRouteDto.safeParse({ ...base, tollClass: "national" }).success).to.equal(
				true,
			);
		});

		it("requires at least one dial pattern", () => {
			expect(
				createOutboundRouteDto.safeParse({ ...base, tollClass: "local", dialPatterns: [] }).success,
			).to.equal(false);
		});
	});

	describe("feature codes", () => {
		it("requires a leading star", () => {
			expect(createFeatureCodeDto.safeParse({ code: "97", action: "redial" }).success).to.equal(
				false,
			);
			expect(createFeatureCodeDto.safeParse({ code: "*97", action: "redial" }).success).to.equal(
				true,
			);
		});

		it("rejects an action outside the closed catalogue", () => {
			expect(
				createFeatureCodeDto.safeParse({ code: "*97", action: "launch-missiles" }).success,
			).to.equal(false);
		});
	});

	describe("time condition rules", () => {
		it("validates wall-clock and date formats", () => {
			const ok = createTimeConditionRuleDto.safeParse({
				ordinal: 1,
				predicates: [{ timeOfDay: { from: "09:00", to: "17:00" } }],
			});
			expect(ok.success).to.equal(true);
			const bad = createTimeConditionRuleDto.safeParse({
				ordinal: 1,
				predicates: [{ timeOfDay: { from: "9am", to: "5pm" } }],
			});
			expect(bad.success).to.equal(false);
		});

		it("bounds weekday and month values", () => {
			expect(
				createTimeConditionRuleDto.safeParse({ ordinal: 1, predicates: [{ weekdays: [0] }] })
					.success,
			).to.equal(false);
			expect(
				createTimeConditionRuleDto.safeParse({ ordinal: 1, predicates: [{ months: [13] }] })
					.success,
			).to.equal(false);
		});
	});

	describe("phone numbers", () => {
		it("requires E.164 with the leading plus", () => {
			const destination = { destinationType: "hangup" as const };
			expect(
				createPhoneNumberDto.safeParse({ e164: "2125550100", ...destination }).success,
			).to.equal(false);
			expect(
				createPhoneNumberDto.safeParse({ e164: "+12125550100", ...destination }).success,
			).to.equal(true);
		});

		it("requires a destination — a DID that rings nothing is not expressible", () => {
			expect(createPhoneNumberDto.safeParse({ e164: "+12125550100" }).success).to.equal(false);
		});
	});

	describe("pagination", () => {
		it("applies the defaults and the ceiling", () => {
			expect(normalizePagination({})).to.deep.equal({ page: 1, limit: 20, offset: 0 });
			expect(normalizePagination({ page: 3, limit: 10 }).offset).to.equal(20);
			expect(normalizePagination({ limit: 5000 }).limit).to.equal(100);
			expect(normalizePagination({ page: -4 }).page).to.equal(1);
		});

		it("coerces query strings and trims a search term to nothing", () => {
			const parsed = listQuerySchema.parse({ page: "2", limit: "5", search: "   ", enabled: "1" });
			expect(parsed.page).to.equal(2);
			expect(parsed.limit).to.equal(5);
			expect(parsed.search).to.equal(undefined);
			expect(parsed.enabled).to.equal(true);
		});

		it("refuses a limit above the ceiling rather than silently clamping at the edge", () => {
			expect(listQuerySchema.safeParse({ limit: "101" }).success).to.equal(false);
		});

		it("computes totalPages from the window total", () => {
			expect(paged([1, 2], 7, normalizePagination({ limit: 2 })).totalPages).to.equal(4);
			expect(paged([], 0, normalizePagination({})).totalPages).to.equal(0);
		});
	});
});
