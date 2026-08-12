import { describe, expect, it } from "bun:test";
import { createEntityId } from "@optimiq-voice/identifiers";
import {
	conferenceClaimSchema,
	isClaimExpired,
	isClaimOwnedBy,
	parkClaimSchema,
	sharedLineStateSchema,
} from "./claims";
import type { ConferenceClaim, ParkClaim, SharedLineState } from "./claims";

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
		claimedAt: NOW,
		conferenceId: createEntityId(),
		bridgeId: createEntityId(),
		contributions: {
			[INSTANCE]: {
				memberCount: 1,
				moderatorPresent: false,
				expiresAt: NOW + 30_000,
			},
		},
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

	it("carries each instance's member count and moderator presence independently", () => {
		const claim = conferenceClaim({
			contributions: {
				[INSTANCE]: { memberCount: 20, moderatorPresent: true, expiresAt: NOW + 30_000 },
				"engine-other": { memberCount: 3, moderatorPresent: false, expiresAt: NOW + 20_000 },
			},
		});

		expect(claim.contributions[INSTANCE]).toEqual({
			memberCount: 20,
			moderatorPresent: true,
			expiresAt: NOW + 30_000,
		});
		expect(claim.contributions["engine-other"]?.memberCount).toBe(3);
	});

	it("refuses an empty contribution map", () => {
		expect(() => conferenceClaim({ contributions: {} })).toThrow();
	});

	it("refuses a fractional, zero, or negative contribution count", () => {
		for (const memberCount of [-1, 0, 1.5]) {
			expect(() =>
				conferenceClaim({
					contributions: {
						[INSTANCE]: { memberCount, moderatorPresent: false, expiresAt: NOW + 30_000 },
					},
				}),
			).toThrow();
		}
	});

	it("passes an unknown field through rather than rejecting a newer writer", () => {
		const parsed = conferenceClaimSchema.parse({ ...conferenceClaim(), lockedBy: "1001" });
		expect((parsed as Record<string, unknown>).lockedBy).toBe("1001");
	});
});

function sharedLineState(overrides: Partial<SharedLineState> = {}): SharedLineState {
	return sharedLineStateSchema.parse({
		orgId: ORG,
		instanceId: INSTANCE,
		claimedAt: NOW,
		heartbeatAt: NOW,
		expiresAt: NOW + 30_000,
		sharedLineId: createEntityId(),
		state: "seized",
		heldByExtensionId: createEntityId(),
		heldByAppearanceIndex: 1,
		callId: createEntityId(),
		legId: createEntityId(),
		...overrides,
	});
}

describe("shared-line seizure claim", () => {
	it("owns a line for exactly one appearance, with the base claim fields", () => {
		const claim = sharedLineState();
		expect(claim.state).toBe("seized");
		expect(claim.heldByAppearanceIndex).toBe(1);
		expect(isClaimOwnedBy(claim, INSTANCE)).toBe(true);
		expect(isClaimExpired(claim, NOW + 40_000)).toBe(true);
	});

	it("carries the hold instant only once the line is held, for the recall timer", () => {
		const held = sharedLineState({ state: "held", heldAtMs: NOW + 5_000 });
		expect(held.state).toBe("held");
		expect(held.heldAtMs).toBe(NOW + 5_000);
	});

	it("refuses a state outside the seized/held pair and a fractional appearance index", () => {
		expect(() => sharedLineState({ state: "parked" as never })).toThrow();
		expect(() => sharedLineState({ heldByAppearanceIndex: 1.5 })).toThrow();
	});

	it("passes an unknown field through rather than rejecting a newer writer", () => {
		const parsed = sharedLineStateSchema.parse({ ...sharedLineState(), bargedBy: "1002" });
		expect((parsed as Record<string, unknown>).bargedBy).toBe("1002");
	});
});
