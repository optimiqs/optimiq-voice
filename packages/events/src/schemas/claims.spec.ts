import { describe, expect, it } from "bun:test";
import { createEntityId } from "@optimiq-voice/identifiers";
import { conferenceClaimSchema, isClaimExpired, isClaimOwnedBy, parkClaimSchema } from "./claims";
import type { ConferenceClaim, ParkClaim } from "./claims";

/**
 * The claim contracts.
 *
 * A claim is the one KV value on this backbone whose staleness is not self-correcting: a wrong
 * registration refreshes in an hour, a wrong claim is an orbit permanently removed from a lot or a
 * conference room split in two. So the assertions here are about the fields the PROTOCOL acts on —
 * owner, expiry, and the bridge id every instance has to agree on — and about the tolerance that
 * keeps a forward-compatible writer from taking a reader down.
 */

const ORG = createEntityId();
const INSTANCE = "engine-7f3a";
const NOW = 1_700_000_000_000;

function parkClaim(overrides: Partial<ParkClaim> = {}): ParkClaim {
	return parkClaimSchema.parse({
		orgId: ORG,
		instanceId: INSTANCE,
		claimedAt: NOW,
		heartbeatAt: NOW,
		expiresAt: NOW + 30_000,
		parkLotId: createEntityId(),
		slot: 401,
		mediaChannelId: "PJSIP/1001-00000001",
		legId: createEntityId(),
		callId: createEntityId(),
		parkedAtMs: NOW,
		...overrides,
	});
}

function conferenceClaim(overrides: Partial<ConferenceClaim> = {}): ConferenceClaim {
	return conferenceClaimSchema.parse({
		orgId: ORG,
		instanceId: INSTANCE,
		claimedAt: NOW,
		heartbeatAt: NOW,
		expiresAt: NOW + 30_000,
		conferenceId: createEntityId(),
		bridgeId: createEntityId(),
		memberCount: 1,
		moderatorPresent: false,
		...overrides,
	});
}

describe("expiry", () => {
	it("believes a claim whose expiry has not passed", () => {
		expect(isClaimExpired(parkClaim(), NOW)).toBe(false);
	});

	it("reaps a claim exactly at its expiry, not a millisecond later", () => {
		const claim = parkClaim({ expiresAt: NOW });
		expect(isClaimExpired(claim, NOW)).toBe(true);
	});

	it("reaps a claim whose owner stopped heartbeating", () => {
		expect(isClaimExpired(parkClaim({ expiresAt: NOW - 1 }), NOW)).toBe(true);
	});

	/**
	 * A value written by a broken writer must be reapable rather than immortal. The alternative —
	 * treating an unusable expiry as "still owned" — is a slot no operator can ever free.
	 */
	it("reaps a claim whose expiry is not a usable number", () => {
		expect(isClaimExpired({ expiresAt: Number.NaN }, NOW)).toBe(true);
		expect(isClaimExpired({ expiresAt: Number.POSITIVE_INFINITY }, NOW)).toBe(true);
	});
});

describe("ownership", () => {
	it("recognises this process's own claim", () => {
		expect(isClaimOwnedBy(parkClaim(), INSTANCE)).toBe(true);
	});

	it("refuses another instance's claim, which is what stops a cross-release", () => {
		expect(isClaimOwnedBy(parkClaim(), "engine-other")).toBe(false);
	});

	it("is exact rather than prefixed, so engine-7 does not own engine-77's slot", () => {
		expect(isClaimOwnedBy(parkClaim({ instanceId: "engine-77" }), "engine-7")).toBe(false);
	});
});

describe("the park claim", () => {
	it("carries the orbit and the lot it belongs to", () => {
		const claim = parkClaim();
		expect(claim.slot).toBe(401);
		expect(claim.parkLotId.length).toBeGreaterThan(0);
	});

	it("carries the parker, so a timeout can ring them back from any instance", () => {
		const claim = parkClaim({ parkedByNumber: "1001", parkedByLegId: "leg-1" });
		expect(claim.parkedByNumber).toBe("1001");
	});

	it("accepts a claim with no parker, because a plan node can park a call", () => {
		expect(parkClaim().parkedByNumber).toBeUndefined();
	});

	it("refuses a negative orbit", () => {
		expect(() => parkClaim({ slot: -1 })).toThrow();
	});

	it("refuses a claim with no owner, which would be unreleasable", () => {
		expect(() => parkClaim({ instanceId: "" })).toThrow();
	});

	it("passes an unknown field through rather than rejecting a newer writer", () => {
		const parsed = parkClaimSchema.parse({ ...parkClaim(), reservedForSomethingLater: true });
		expect((parsed as Record<string, unknown>).reservedForSomethingLater).toBe(true);
	});
});

describe("the conference claim", () => {
	it("carries the bridge id every instance must agree on", () => {
		expect(conferenceClaim().bridgeId.length).toBeGreaterThan(0);
	});

	it("refuses a room with no bridge, which is a claim that agrees on nothing", () => {
		expect(() => conferenceClaim({ bridgeId: "" })).toThrow();
	});

	it("carries the cluster-wide member count, which is what makes maxMembers a cap", () => {
		expect(conferenceClaim({ memberCount: 20 }).memberCount).toBe(20);
	});

	it("refuses a fractional or negative member count", () => {
		expect(() => conferenceClaim({ memberCount: -1 })).toThrow();
		expect(() => conferenceClaim({ memberCount: 1.5 })).toThrow();
	});

	it("carries whether a moderator is present anywhere in the cluster", () => {
		expect(conferenceClaim({ moderatorPresent: true }).moderatorPresent).toBe(true);
	});

	it("passes an unknown field through rather than rejecting a newer writer", () => {
		const parsed = conferenceClaimSchema.parse({ ...conferenceClaim(), lockedBy: "1001" });
		expect((parsed as Record<string, unknown>).lockedBy).toBe("1001");
	});
});
