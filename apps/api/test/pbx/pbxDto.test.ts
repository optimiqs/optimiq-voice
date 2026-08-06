import { BadRequestException } from "@nestjs/common";
import { expect } from "chai";
import { FEATURE_CODE_ACTIONS } from "@optimiq-voice/pbx-db";
import {
	createConferenceDto,
	updateConferenceDto,
} from "../../src/pbx/conferences/conferences.dto";
import { createExtensionDto, updateExtensionDto } from "../../src/pbx/extensions/extensions.dto";
import {
	createFeatureCodeDto,
	FEATURE_CODE_PARAM_FIELDS,
	updateFeatureCodeDto,
} from "../../src/pbx/feature-codes/feature-codes.dto";
import { updateIvrMenuDto } from "../../src/pbx/ivr-menus/ivr-menus.dto";
import { createOutboundRouteDto } from "../../src/pbx/outbound-routes/outbound-routes.dto";
import { createParkLotDto, updateParkLotDto } from "../../src/pbx/park-lots/park-lots.dto";
import { createPhoneNumberDto } from "../../src/pbx/phone-numbers/phone-numbers.dto";
import {
	createQueueAgentDto,
	createQueueTierDto,
	updateQueueAgentDto,
	updateQueueDto,
} from "../../src/pbx/queues/queues.dto";
import { updateRingGroupDto } from "../../src/pbx/ring-groups/ring-groups.dto";
import { parseDto, reorderDto } from "../../src/pbx/shared/dto";
import { listQuerySchema, normalizePagination, paged } from "../../src/pbx/shared/pagination";
import { createTimeConditionRuleDto } from "../../src/pbx/time-conditions/time-conditions.dto";
import { updateVoicemailBoxDto } from "../../src/pbx/voicemail-boxes/voicemail-boxes.dto";
import type { z } from "zod/v4";

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

		it("accepts the one parameter the compiler reads, and only for its action", () => {
			const lotId = "0193f2aa-0000-7000-8000-000000000001";
			expect(
				createFeatureCodeDto.safeParse({ code: "*5", action: "call-park", params: { lotId } })
					.success,
			).to.equal(true);
			// `redial` reads nothing, so a param on it is dead configuration wearing a setting's clothes.
			expect(
				createFeatureCodeDto.safeParse({ code: "*69", action: "redial", params: { lotId } })
					.success,
			).to.equal(false);
		});

		it("names the offending parameter, not just 'params'", () => {
			const result = createFeatureCodeDto.safeParse({
				code: "*5",
				action: "call-park",
				params: { lot_id: "0193f2aa-0000-7000-8000-000000000001" },
			});
			expect(result.success).to.equal(false);
			expect(
				result.error?.issues.map((issue) => issue.path.join(".")),
				"the typo must land on the parameter that caused it",
			).to.include("params.lot_id");
		});

		it("refuses parameters sent without the action they belong to", () => {
			const result = updateFeatureCodeDto.safeParse({ params: { lotId: "x" } });
			expect(result.success).to.equal(false);
			expect(result.error?.issues.map((issue) => issue.path.join("."))).to.include("action");
		});

		it("retires the old action's parameters when the action changes", () => {
			const patched = updateFeatureCodeDto.parse({ action: "redial" }) as Record<string, unknown>;
			expect(patched.action).to.equal("redial");
			expect("params" in patched, "a redial row must not keep a park lot").to.equal(true);
			expect(patched.params).to.equal(null);
		});

		it("describes every action's parameters so a form can render a control", () => {
			for (const action of FEATURE_CODE_ACTIONS) {
				expect(FEATURE_CODE_PARAM_FIELDS[action], action).to.be.an("array");
			}
			const park = FEATURE_CODE_PARAM_FIELDS["call-park"];
			expect(park).to.have.length(1);
			expect(park[0]?.name).to.equal("lotId");
			expect(park[0]?.entityType).to.equal("park");
			// Every other action renders as "no parameters", which is a fact, not a gap.
			expect(
				FEATURE_CODE_ACTIONS.filter((action) => FEATURE_CODE_PARAM_FIELDS[action].length > 0),
			).to.deep.equal(["call-park"]);
		});
	});

	/**
	 * The reset contract.
	 *
	 * Every numeric knob backed by a `notNull().default()` column accepts `null`, which the
	 * repository turns into the column's DEFAULT. If the DTO refused it, a form's "Use default"
	 * control would have nothing to send and would have to guess the server's number itself — which
	 * is how a client-side copy of a default drifts.
	 */
	describe("null resets a defaulted numeric field", () => {
		const resettableCases: [string, z.ZodType, Record<string, unknown>, string][] = [
			["extension.callTimeoutSeconds", updateExtensionDto, {}, "callTimeoutSeconds"],
			["ring group.ringTimeoutSeconds", updateRingGroupDto, {}, "ringTimeoutSeconds"],
			["ivr menu.digitTimeoutMs", updateIvrMenuDto, {}, "digitTimeoutMs"],
			["voicemail box.maxMessages", updateVoicemailBoxDto, {}, "maxMessages"],
			["queue.maxWaitSeconds", updateQueueDto, {}, "maxWaitSeconds"],
			["conference.maxMembers", updateConferenceDto, {}, "maxMembers"],
			["park lot.timeoutSeconds", updateParkLotDto, {}, "timeoutSeconds"],
		];

		for (const [name, schema, base, field] of resettableCases) {
			it(`accepts an explicit null for ${name}`, () => {
				const parsed = schema.parse({ ...base, [field]: null }) as Record<string, unknown>;
				expect(field in parsed, "the key must survive so the repository can act on it").to.equal(
					true,
				);
				expect(parsed[field]).to.equal(null);
			});
		}

		it("still refuses a value outside the column's range", () => {
			expect(updateQueueDto.safeParse({ maxWaitSeconds: -1 }).success).to.equal(false);
			expect(updateQueueDto.safeParse({ maxWaitSeconds: 0 }).success).to.equal(true);
		});
	});

	describe("reorder", () => {
		it("takes the complete order and nothing else", () => {
			const ids = ["0193f2aa-0000-7000-8000-000000000001"];
			expect(reorderDto.safeParse({ ids }).success).to.equal(true);
			expect(reorderDto.safeParse({ ids: [] }).success).to.equal(false);
			expect(reorderDto.safeParse({ ids, from: 0, to: 1 }).success).to.equal(false);
			expect(reorderDto.safeParse({ ids: ["not-a-uuid"] }).success).to.equal(false);
		});
	});

	describe("queues", () => {
		const extensionId = "0193f2aa-0000-7000-8000-000000000001";

		it("refuses an agent the engine could never dial", () => {
			expect(createQueueAgentDto.safeParse({ name: "Alice" }).success).to.equal(false);
			expect(
				createQueueAgentDto.safeParse({ name: "Alice", contactKind: "extension", extensionId })
					.success,
			).to.equal(true);
			expect(
				createQueueAgentDto.safeParse({ name: "Sales line", contactKind: "external" }).success,
			).to.equal(false);
			expect(
				createQueueAgentDto.safeParse({
					name: "Sales line",
					contactKind: "external",
					contact: "+12125550100",
				}).success,
			).to.equal(true);
		});

		it("does not re-check reachability on a PATCH that never mentions it", () => {
			expect(updateQueueAgentDto.safeParse({ name: "Alice N." }).success).to.equal(true);
		});

		it("takes the queue from the path, never from the tier body", () => {
			expect(
				createQueueTierDto.safeParse({ queueAgentId: extensionId, queueId: extensionId }).success,
			).to.equal(false);
			expect(createQueueTierDto.safeParse({ queueAgentId: extensionId }).success).to.equal(true);
		});
	});

	describe("park lots", () => {
		it("refuses a slot range that ends before it starts", () => {
			const base = { name: "Front desk", slotStart: 701, slotEnd: 720 };
			expect(createParkLotDto.safeParse(base).success).to.equal(true);
			expect(createParkLotDto.safeParse({ ...base, slotEnd: 700 }).success).to.equal(false);
			// Equal ends are a one-slot lot, which is a legitimate thing to want.
			expect(createParkLotDto.safeParse({ ...base, slotEnd: 701 }).success).to.equal(true);
		});
	});

	describe("conferences", () => {
		it("does not let an admin paste a PIN digest into the row", () => {
			expect(
				createConferenceDto.safeParse({ name: "Board", roomNumber: "9000", pinHash: "$2b$…" })
					.success,
			).to.equal(false);
			expect(createConferenceDto.safeParse({ name: "Board", roomNumber: "9000" }).success).to.equal(
				true,
			);
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
