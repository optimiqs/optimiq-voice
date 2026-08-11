import { describe, expect, it } from "bun:test";
import { TrunkCapacityRegistry } from "./trunk-capacity";

/**
 * The per-trunk channel ceiling.
 *
 * The interesting cases are all leaks: a reservation that is taken and never given back ratchets
 * the ceiling down by one for the rest of the process, and a trunk that ends up at zero available
 * channels refuses every call a tenant makes. Most of what is below is about that.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_ORG = "0195c0f0-1c2f-7000-8000-000000000002";

describe("TrunkCapacityRegistry", () => {
	it("hands out channels up to the ceiling and then refuses", () => {
		const trunks = new TrunkCapacityRegistry();
		expect(trunks.reserve(ORG, "t1", 2)).toBeDefined();
		expect(trunks.reserve(ORG, "t1", 2)).toBeDefined();
		expect(trunks.reserve(ORG, "t1", 2)).toBeUndefined();
		expect(trunks.inUse(ORG, "t1")).toBe(2);
	});

	it("never refuses a trunk with no ceiling, and counts nothing for it", () => {
		const trunks = new TrunkCapacityRegistry();
		for (const ceiling of [undefined, 0, -1, Number.NaN]) {
			expect(trunks.reserve(ORG, "t1", ceiling)).toBeDefined();
		}
		expect(trunks.inUse(ORG, "t1")).toBe(0);
	});

	it("gives the channel back when a dial that never answered releases it", () => {
		const trunks = new TrunkCapacityRegistry();
		const reservation = trunks.reserve(ORG, "t1", 1);
		reservation?.release();
		expect(trunks.inUse(ORG, "t1")).toBe(0);
		expect(trunks.reserve(ORG, "t1", 1)).toBeDefined();
	});

	it("holds the channel for the leg that took it, until that leg ends", () => {
		const trunks = new TrunkCapacityRegistry();
		trunks.reserve(ORG, "t1", 1)?.bindTo("media-1");
		expect(trunks.reserve(ORG, "t1", 1)).toBeUndefined();

		trunks.releaseLeg("media-1");
		expect(trunks.inUse(ORG, "t1")).toBe(0);
		expect(trunks.reserve(ORG, "t1", 1)).toBeDefined();
	});

	it("does not double-release a bound reservation, however the walk unwinds", () => {
		const trunks = new TrunkCapacityRegistry();
		const first = trunks.reserve(ORG, "t1", 2);
		trunks.reserve(ORG, "t1", 2);
		first?.bindTo("media-1");
		// The walk's own `release()` after a bind must not return a channel the leg still holds.
		first?.release();
		expect(trunks.inUse(ORG, "t1")).toBe(2);

		trunks.releaseLeg("media-1");
		expect(trunks.inUse(ORG, "t1")).toBe(1);
	});

	it("is idempotent on release, so an unwind that runs twice does not invent a channel", () => {
		const trunks = new TrunkCapacityRegistry();
		trunks.reserve(ORG, "t1", 2);
		const second = trunks.reserve(ORG, "t1", 2);
		second?.release();
		second?.release();
		expect(trunks.inUse(ORG, "t1")).toBe(1);
	});

	it("ignores a leg it never gave a channel to", () => {
		const trunks = new TrunkCapacityRegistry();
		trunks.reserve(ORG, "t1", 2)?.bindTo("media-1");
		trunks.releaseLeg("media-unknown");
		trunks.releaseLeg("media-1");
		trunks.releaseLeg("media-1");
		expect(trunks.inUse(ORG, "t1")).toBe(0);
	});

	it("counts each organization's trunks separately, even under the same trunk id", () => {
		const trunks = new TrunkCapacityRegistry();
		expect(trunks.reserve(ORG, "t1", 1)).toBeDefined();
		expect(trunks.reserve(OTHER_ORG, "t1", 1)).toBeDefined();
		expect(trunks.reserve(ORG, "t1", 1)).toBeUndefined();
		expect(trunks.inUse(OTHER_ORG, "t1")).toBe(1);
	});
});
