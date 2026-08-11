import { describe, expect, it } from "bun:test";
import { trunkAttempt } from "./plan-fixtures.fake";
import { orderTrunkAttempts } from "./trunk-selection";

/**
 * Trunk-chain ordering.
 *
 * The RNG is supplied by every test, so the "random" half is as assertable as the deterministic
 * half: a spec that rolled real dice could only check a distribution, and a distribution check is
 * a flaky test wearing a statistics costume.
 */

/** A `random` that walks a scripted list, repeating the last value once the script runs out. */
function scripted(...values: readonly number[]): () => number {
	const remaining = [...values];
	return () => (remaining.length > 1 ? (remaining.shift() as number) : (remaining[0] ?? 0));
}

const names = (attempts: readonly { readonly name: string }[]): readonly string[] =>
	attempts.map((attempt) => attempt.name);

describe("orderTrunkAttempts", () => {
	it("walks failover tiers lowest `order` first, whatever order the artifact listed them in", () => {
		const chain = orderTrunkAttempts(
			[trunkAttempt("backup", 2), trunkAttempt("primary", 0), trunkAttempt("middle", 1)],
			scripted(0),
		);
		expect(names(chain)).toEqual(["primary", "middle", "backup"]);
	});

	it("never reorders across tiers, however heavy a lower tier's weight is", () => {
		const chain = orderTrunkAttempts(
			[
				trunkAttempt("primary", 0, { weight: 1 }),
				trunkAttempt("backup-a", 1, { weight: 99 }),
				trunkAttempt("backup-b", 1, { weight: 99 }),
			],
			scripted(0.99),
		);
		expect(chain[0]?.name).toBe("primary");
	});

	it("is the identity when no attempt carries a weight, and does not touch the RNG", () => {
		let rolls = 0;
		const chain = orderTrunkAttempts(
			[trunkAttempt("a", 0), trunkAttempt("b", 0), trunkAttempt("c", 0)],
			() => {
				rolls += 1;
				return 0;
			},
		);
		expect(names(chain)).toEqual(["a", "b", "c"]);
		expect(rolls).toBe(0);
	});

	it("gives each weighted member the share its weight buys", () => {
		const chain = [
			trunkAttempt("heavy", 0, { weight: 70 }),
			trunkAttempt("light", 0, { weight: 30 }),
		];
		// 0.0 lands in the first 70/100 of the line, 0.75 lands past it.
		expect(names(orderTrunkAttempts(chain, scripted(0)))[0]).toBe("heavy");
		expect(names(orderTrunkAttempts(chain, scripted(0.75)))[0]).toBe("light");
	});

	it("returns a full permutation, so the loser of the draw is still a failover target", () => {
		const chain = orderTrunkAttempts(
			[trunkAttempt("heavy", 0, { weight: 70 }), trunkAttempt("light", 0, { weight: 30 })],
			scripted(0.9),
		);
		expect(names(chain)).toEqual(["light", "heavy"]);
	});

	it("re-normalizes the remaining weight at each position", () => {
		// Draw 1 over 20/30/50: 0.9 → `c`. Draw 2 over the remaining 20/30: 0.9 of 50 is 45, which is
		// past `a`'s 20, so `b`. `a` takes the tail.
		const chain = orderTrunkAttempts(
			[
				trunkAttempt("a", 0, { weight: 20 }),
				trunkAttempt("b", 0, { weight: 30 }),
				trunkAttempt("c", 0, { weight: 50 }),
			],
			scripted(0.9),
		);
		expect(names(chain)).toEqual(["c", "b", "a"]);
	});

	it("puts an unweighted member behind the weighted ones without dropping it", () => {
		const chain = orderTrunkAttempts(
			[
				trunkAttempt("spare", 0),
				trunkAttempt("heavy", 0, { weight: 70 }),
				trunkAttempt("light", 0, { weight: 30 }),
			],
			scripted(0.9),
		);
		expect(names(chain)).toEqual(["light", "heavy", "spare"]);
	});

	it("treats a zero, a negative and a non-finite weight as unweighted rather than as refusals", () => {
		const chain = orderTrunkAttempts(
			[
				trunkAttempt("zero", 0, { weight: 0 }),
				trunkAttempt("negative", 0, { weight: -5 }),
				trunkAttempt("nan", 0, { weight: Number.NaN }),
			],
			scripted(0.5),
		);
		expect(names(chain)).toEqual(["zero", "negative", "nan"]);
	});

	it("leaves a tier with a single weighted member alone", () => {
		const chain = orderTrunkAttempts(
			[trunkAttempt("only-weighted", 0, { weight: 100 }), trunkAttempt("spare", 0)],
			scripted(0.99),
		);
		expect(names(chain)).toEqual(["only-weighted", "spare"]);
	});

	it("returns every attempt exactly once, for every roll", () => {
		const chain = [
			trunkAttempt("a", 0, { weight: 10 }),
			trunkAttempt("b", 0, { weight: 20 }),
			trunkAttempt("c", 1, { weight: 30 }),
			trunkAttempt("d", 1, { weight: 40 }),
			trunkAttempt("e", 1),
		];
		for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
			const ordered = orderTrunkAttempts(chain, scripted(roll));
			expect([...names(ordered)].sort()).toEqual(["a", "b", "c", "d", "e"]);
		}
	});

	it("passes a one-attempt chain straight through", () => {
		const one = [trunkAttempt("only", 0, { weight: 5 })];
		expect(orderTrunkAttempts(one, scripted(0.5))).toBe(one);
		expect(orderTrunkAttempts([], scripted(0.5))).toEqual([]);
	});
});
