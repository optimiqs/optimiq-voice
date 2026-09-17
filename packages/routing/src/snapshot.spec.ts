import { describe, expect, it } from "bun:test";
import {
	CALL_BLOCK_ACTIONS,
	CALL_BLOCK_DIRECTIONS,
	emptySnapshot,
	FEATURE_CODE_ACTIONS,
	isOptionalSnapshotCollection,
	OPTIONAL_SNAPSHOT_COLLECTIONS,
	QUEUE_STRATEGIES,
	RECORD_POLICIES,
	RING_GROUP_STRATEGIES,
	ROUTE_MATCH_KINDS,
	SNAPSHOT_COLLECTIONS,
	TOLL_CLASS_RANK,
	TOLL_CLASSES,
	tollClassCovers,
	TRUNK_KINDS,
} from "./snapshot";

/**
 * These tuples mirror `packages/pbx-db/src/schema`. Pinning them is what makes the mirror safe: a
 * value the database can store but the compiler does not know would otherwise be silently dropped.
 */
describe("mirrored vocabularies", () => {
	it("mirrors the toll classes", () => {
		expect([...TOLL_CLASSES]).toEqual([
			"internal",
			"local",
			"national",
			"international",
			"premium",
		]);
	});

	it("mirrors the record policies", () => {
		expect([...RECORD_POLICIES]).toEqual(["none", "inbound", "outbound", "all", "on-demand"]);
	});

	it("mirrors the route match kinds", () => {
		expect([...ROUTE_MATCH_KINDS]).toEqual(["exact", "prefix", "regex", "any"]);
	});

	it("mirrors the ring-group strategies", () => {
		expect([...RING_GROUP_STRATEGIES]).toEqual(["simultaneous", "sequential"]);
	});

	it("mirrors the queue strategies", () => {
		expect([...QUEUE_STRATEGIES]).toEqual([
			"longest-idle",
			"ring-all",
			"round-robin",
			"top-down",
			"sequential",
			"random",
		]);
	});

	it("mirrors the trunk kinds", () => {
		expect([...TRUNK_KINDS]).toEqual(["register", "ip-auth"]);
	});

	it("mirrors the call-block directions and actions", () => {
		expect([...CALL_BLOCK_DIRECTIONS]).toEqual(["inbound", "outbound", "both"]);
		expect([...CALL_BLOCK_ACTIONS]).toEqual(["block", "allow", "reject", "voicemail"]);
	});

	/**
	 * Twenty-four from `pbx-db`, plus the two this package adds. The two are NOT in the database's
	 * list on purpose — no `feature_code` row may carry them, because both codes live on the entity
	 * they act on — so the count is asserted as two numbers rather than one, and a new action on
	 * either side has to say which side it is on. The hot-desk pair IS in the database's list, for
	 * the reason recorded beside it: neither names an entity.
	 */
	it("mirrors the twenty-four feature-code actions and adds the two entity toggles", () => {
		expect(FEATURE_CODE_ACTIONS).toHaveLength(26);
		expect(FEATURE_CODE_ACTIONS).toContain("voicemail-check");
		expect(FEATURE_CODE_ACTIONS).toContain("eavesdrop");
		expect(FEATURE_CODE_ACTIONS).toContain("hotdesk-login");
		expect(FEATURE_CODE_ACTIONS).toContain("hotdesk-logout");
		expect(FEATURE_CODE_ACTIONS).toContain("caller-id-presentation-restrict");
		expect(FEATURE_CODE_ACTIONS).toContain("caller-id-presentation-allow");
		expect(FEATURE_CODE_ACTIONS).toContain("call-flow-toggle");
		expect(FEATURE_CODE_ACTIONS).toContain("time-condition-override");
	});
});

describe("toll classes", () => {
	it("ranks every class", () => {
		for (const tollClass of TOLL_CLASSES) {
			expect(TOLL_CLASS_RANK[tollClass]).toBeTypeOf("number");
		}
	});

	it("ranks them strictly, in the declared order", () => {
		const ranks = TOLL_CLASSES.map((tollClass) => TOLL_CLASS_RANK[tollClass]);
		expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
		expect(new Set(ranks).size).toBe(ranks.length);
	});

	it("puts premium at the top, since it is the most expensive to abuse", () => {
		expect(TOLL_CLASS_RANK.premium).toBe(Math.max(...Object.values(TOLL_CLASS_RANK)));
	});

	it("lets a class cover itself", () => {
		for (const tollClass of TOLL_CLASSES) {
			expect(tollClassCovers(tollClass, tollClass)).toBe(true);
		}
	});

	it("lets a higher class cover a lower one", () => {
		expect(tollClassCovers("international", "national")).toBe(true);
		expect(tollClassCovers("premium", "internal")).toBe(true);
	});

	it("does not let a lower class cover a higher one", () => {
		expect(tollClassCovers("local", "international")).toBe(false);
		expect(tollClassCovers("national", "premium")).toBe(false);
	});

	it("is transitive across the whole ladder", () => {
		for (const holder of TOLL_CLASSES) {
			for (const required of TOLL_CLASSES) {
				expect(tollClassCovers(holder, required)).toBe(
					TOLL_CLASS_RANK[holder] >= TOLL_CLASS_RANK[required],
				);
			}
		}
	});
});

describe("emptySnapshot", () => {
	it("carries the organization id", () => {
		expect(emptySnapshot("org-1").organizationId).toBe("org-1");
	});

	it("populates every collection as an empty array", () => {
		const snapshot = emptySnapshot("org-1") as unknown as Record<string, unknown>;
		for (const collection of SNAPSHOT_COLLECTIONS) {
			expect(snapshot[collection]).toEqual([]);
		}
	});

	it("lists thirty-three collections", () => {
		expect(SNAPSHOT_COLLECTIONS).toHaveLength(33);
	});

	it("marks exactly the collections a loader may omit as optional", () => {
		expect([...OPTIONAL_SNAPSHOT_COLLECTIONS]).toEqual([
			"voicemailGreetings",
			"mohClasses",
			"emergencyAddresses",
			"pagingGroups",
			// The T2 admin block, optional for the same rollout reason and no other: this package
			// compiles them before the API's snapshot loader selects them.
			"callFlows",
			"pinSets",
			"pinSetEntries",
			"translationRulesets",
			"translationRules",
			"destinationAliases",
			"audioStreams",
			"prompts",
			"phraseSteps",
			"directories",
			"speedDials",
			"sharedLines",
		]);
	});

	it("only marks real collections optional", () => {
		for (const collection of OPTIONAL_SNAPSHOT_COLLECTIONS) {
			expect(SNAPSHOT_COLLECTIONS).toContain(collection);
			expect(isOptionalSnapshotCollection(collection)).toBe(true);
		}
	});

	it("does not mark a required collection optional", () => {
		expect(isOptionalSnapshotCollection("extensions")).toBe(false);
	});

	it("has no duplicate collections", () => {
		expect(new Set(SNAPSHOT_COLLECTIONS).size).toBe(SNAPSHOT_COLLECTIONS.length);
	});
});
