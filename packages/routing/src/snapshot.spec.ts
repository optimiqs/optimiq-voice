import { describe, expect, it } from "bun:test";
import {
	CALL_BLOCK_ACTIONS,
	CALL_BLOCK_DIRECTIONS,
	emptySnapshot,
	FEATURE_CODE_ACTIONS,
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

	it("mirrors the twenty feature-code actions", () => {
		expect(FEATURE_CODE_ACTIONS).toHaveLength(20);
		expect(FEATURE_CODE_ACTIONS).toContain("voicemail-check");
		expect(FEATURE_CODE_ACTIONS).toContain("eavesdrop");
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

	it("lists seventeen collections", () => {
		expect(SNAPSHOT_COLLECTIONS).toHaveLength(17);
	});

	it("has no duplicate collections", () => {
		expect(new Set(SNAPSHOT_COLLECTIONS).size).toBe(SNAPSHOT_COLLECTIONS.length);
	});
});
