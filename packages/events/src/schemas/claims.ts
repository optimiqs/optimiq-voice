import { z } from "zod";

/**
 * The two CLAIM value contracts: `park-claims` and `conference-claims`.
 *
 * ## What a claim is, and why it is not just live state
 *
 * Every other KV value on this backbone answers "what is true right now?" — a registration, a
 * channel, an agent's status. A claim answers a different and much sharper question: **which
 * process owns this thing, and may it still?** The difference matters because a stale answer to the
 * first is a wallboard that is a few seconds behind, and a stale answer to the second is two engine
 * instances both convinced they own orbit 401.
 *
 * An exclusive park claim carries three things no live-state value does:
 *
 * 1. `instanceId` — the process that took it. A claim with somebody else's instance on it is not
 *    yours to release, and a claim you cannot find your own instance on is one you have lost.
 * 2. `expiresAt` — when the claim stops being believable in the ABSENCE of a heartbeat. Read by a
 *    reaper, not by the server: server-side TTL cannot tell "the owner stopped heartbeating" from
 *    "this value is old and still correct".
 * 3. `heartbeatAt` — when the owner last said it was still alive. The thing that moves `expiresAt`
 *    forward for as long as the call is up.
 *
 * A conference is jointly held, so its liveness fields sit on each instance's contribution instead.
 * That lets one crashed instance expire without making the surviving instances abandon the bridge.
 *
 * ## Why these are tolerant, like the rest of the KV contracts
 *
 * `.loose()`, for the reason on `live-state.ts`: a value written by a process on its own release
 * cadence must not be rejected for carrying a field this reader has not heard of. What is pinned is
 * the set of fields the CLAIM PROTOCOL acts on — get one of those wrong and two calls share a slot.
 *
 * ## Not in the Go codegen registry
 *
 * Nothing in Go claims a park slot or a conference bridge, and nothing is planned to: both are
 * engine-owned operations behind ARI. Registering these would emit Go structs with no Go writer and
 * no Go reader, which is a parity golden pinning a shape nobody holds.
 */

// ---------------------------------------------------------------------------------------------
// The common half
// ---------------------------------------------------------------------------------------------

/**
 * The fields every exclusively owned claim carries.
 *
 * Epoch MILLISECONDS rather than ISO strings, matching `live-state.ts`'s `channels` and for the
 * same reason: these are compared against a clock on the call path — `now >= expiresAt`, tens of
 * times a second under load — and a comparison that has to parse a date first is a comparison that
 * gets written as a string compare by somebody in a hurry.
 */
export const claimBaseSchema = z.object({
	orgId: z.string().min(1),
	/** The engine process holding the claim. Stable for the life of the process, not of the host. */
	instanceId: z.string().min(1).max(128),
	claimedAt: z.number(),
	heartbeatAt: z.number(),
	/** Past this, with no heartbeat since, the claim is reapable by anybody. */
	expiresAt: z.number(),
});

/**
 * Whether a claim may be taken over.
 *
 * The check every reaper and every loser-of-a-race runs, and the reason it is a function here
 * rather than an inline comparison at four call sites: the comparison is `>=`, not `>`, and getting
 * that wrong at one of them means a claim that is reapable in one code path and immortal in
 * another. A claim exactly at its expiry is expired — the owner had the whole interval to
 * heartbeat and did not.
 */
export function isClaimExpired(claim: { readonly expiresAt: number }, nowMs: number): boolean {
	return !Number.isFinite(claim.expiresAt) || nowMs >= claim.expiresAt;
}

/**
 * Whether this process is the owner.
 *
 * Used before every release and every heartbeat. A process that renewed a claim it does not own
 * would extend the life of somebody else's slot; a process that released one would hand a live
 * caller's orbit to the next parker.
 */
export function isClaimOwnedBy(
	claim: { readonly instanceId: string },
	instanceId: string,
): boolean {
	return claim.instanceId === instanceId;
}

// ---------------------------------------------------------------------------------------------
// park-claims
// ---------------------------------------------------------------------------------------------

/**
 * One orbit slot, owned.
 *
 * The value carries enough to ANSWER A RETRIEVAL FROM ANOTHER INSTANCE even though this release
 * cannot perform one: a retriever on instance B can say "that call is parked on another node"
 * instead of the much worse "nothing is parked there", which is indistinguishable from a colleague
 * having already collected it. The media handoff itself needs an instance-to-instance RPC and is
 * deliberately not in this wave; see `apps/engine`'s `park-registry.ts`.
 */
export const parkClaimSchema = claimBaseSchema
	.extend({
		parkLotId: z.string().min(1),
		slot: z.number().int().nonnegative(),
		/** The media server's id for the parked leg. Not addressable from another instance yet. */
		mediaChannelId: z.string().min(1).max(256),
		legId: z.string().min(1).max(128),
		callId: z.string().min(1).max(128),
		/** Who parked it, so a timeout can ring them back. Absent when a plan node did the parking. */
		parkedByLegId: z.string().max(128).optional(),
		parkedByNumber: z.string().max(128).optional(),
		parkedAtMs: z.number(),
		mohClass: z.string().max(128).optional(),
	})
	.loose();

export type ParkClaim = z.infer<typeof parkClaimSchema>;

// ---------------------------------------------------------------------------------------------
// conference-claims
// ---------------------------------------------------------------------------------------------

/**
 * One room, and the bridge every instance agrees it uses.
 *
 * `bridgeId` is the load-bearing field and the whole reason this bucket exists: a joiner who loses
 * the create reads it and joins the WINNER's bridge on the shared media server, which is what turns
 * a split room back into one room.
 *
 * Each instance contributes only the members it owns. Readers discard expired contributions and
 * derive `memberCount` and `moderatorPresent`; this is what lets a crashed instance's seats and
 * moderator presence disappear while another instance keeps the room and bridge alive.
 */
export const conferenceContributionSchema = z
	.object({
		memberCount: z.number().int().positive(),
		moderatorPresent: z.boolean(),
		/** Past this, this instance's members no longer count toward the room. */
		expiresAt: z.number(),
	})
	.loose();

export const conferenceClaimSchema = z
	.object({
		orgId: z.string().min(1),
		claimedAt: z.number(),
		conferenceId: z.string().min(1),
		/** The media server's bridge id. Every instance joining this room uses THIS one. */
		bridgeId: z.string().min(1).max(256),
		contributions: z
			.record(z.string().min(1).max(128), conferenceContributionSchema)
			.refine((contributions) => Object.keys(contributions).length > 0),
		/**
		 * Whether the room has stopped admitting new participants.
		 *
		 * On the CLAIM and not on an instance's contribution, which is the whole point of putting it
		 * here: a lock is a fact about the ROOM, and a joiner landing on a neighbour has to be refused
		 * too or the lock is a suggestion. Every instance already reads this value on the join path —
		 * it is where the cluster-wide member count comes from — so honouring a lock costs one field
		 * read on a path that was going to read the value anyway.
		 *
		 * It is deliberately NOT leased like a contribution is. A contribution expires because its
		 * owner may have crashed and its seats must stop counting; a lock has no owner to lose, and a
		 * meeting that unlocked itself because an unrelated instance restarted would be a room the
		 * moderator has to keep re-locking. It goes away when the room does — the last member out
		 * releases the key.
		 *
		 * Optional, and absent means unlocked: a claim written by a release that predates this is a
		 * room nobody has locked, which is what it was.
		 */
		locked: z.boolean().optional(),
		/** The control-plane user who locked it, for the audit trail. Absent when unlocked. */
		lockedByUserId: z.string().max(128).optional(),
		lockedAtMs: z.number().optional(),
	})
	.loose();

export type ConferenceClaim = z.infer<typeof conferenceClaimSchema>;
export type ConferenceContribution = z.infer<typeof conferenceContributionSchema>;
