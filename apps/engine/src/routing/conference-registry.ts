import { Injectable } from "@nestjs/common";
import { kvKeyFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { UnclaimedBucket } from "../nats/claim-store";
import { CLAIM_LEASE_MS } from "./claim-timing";
import type { ClaimBucket, Claimed } from "../nats/claim-store";
import type { ConferenceClaim } from "@optimiq-voice/events";

/**
 * Conference rooms, agreed across every engine instance.
 *
 * ## Why a registry and not a field on the walker
 *
 * Every other destination the plan walker executes is per-call: an extension dial, a ring group
 * race, an IVR's retry counters all begin and end inside one `walk()`. A conference is the first one
 * that is not. Two callers dialling `3001` are two walks, and they have to end up in the SAME mixing
 * bridge or they are two calls that cannot hear each other.
 *
 * ## The split this now fixes, and why a conference is repairable where a park is not
 *
 * The in-memory version held that within one process only: two instances each minted their own
 * bridge for room `3001`, and the room split in two. The failure was silent — everybody hears hold
 * music and nobody hears anybody, which reads as a media bug and is not one.
 *
 * A conference is repairable across instances in a way a parked call is not, and the reason is that
 * every engine talks to the SAME media server: a bridge created by instance A is addressable by
 * instance B. The only thing missing was agreement on WHICH id room `3001` uses. So the first joiner
 * `create`s a claim carrying its bridge id, and a joiner who LOSES that create reads the winner's id
 * and joins that bridge. One room again, with no media handoff and no RPC.
 *
 * ## `maxMembers` and "has a moderator arrived?" are cluster-wide, or they are nothing
 *
 * A cap counted per instance is not a cap: a twenty-seat room admits forty across two nodes. A
 * moderator gate checked per instance is worse — a participant waits forever for somebody who is
 * already in the meeting. Each instance therefore writes its own leased contribution under
 * compare-and-set. Cluster totals are derived from the unexpired contributions, so one crashed
 * instance's members disappear without allowing another instance to change the shared bridge id.
 * The CAS retry is bounded: a join that keeps losing is a room being hammered, and refusing on the
 * call path beats spinning on it.
 *
 * ## Degradation: configured-and-down REFUSES
 *
 * The same policy as `park-registry.ts`, for the same reason. No bucket configured is a
 * single-instance deployment and behaves exactly as this class always did. A bucket configured but
 * unreachable REFUSES the join, loudly — a join that proceeded on an unrecorded claim is precisely
 * the split-brain this file exists to prevent, occurring during the incident when nobody is looking
 * at conference bridges.
 *
 * ## `waitForModerator` is a promise, not a poll — locally
 *
 * A participant held in music on hold is waiting for an event that happens in a DIFFERENT walk.
 * Polling would work and would also mean every held caller waking on a timer forever; a waiter
 * resolved by the moderator's own join costs nothing while it waits and fires once. A moderator who
 * joins on ANOTHER instance cannot fire a local waiter, so {@link ConferenceRegistry.refresh} exists:
 * the holder polls it, it re-reads the claim, and it releases the local waiters when the cluster says
 * a moderator has arrived. That is a poll, but it is one poll per HELD caller rather than one per
 * participant, and only while a gate is actually closed.
 */

/**
 * A member arriving, as the joiner describes them.
 *
 * Separate from {@link ConferenceMember} below, which is the same member plus the STATE the room
 * holds about them. The split is what stops a plan walker having to invent values for four fields it
 * has no opinion about — a caller entering a room is unmuted, undeafened and at unity, always, and
 * the registry is the thing that knows that.
 */
export interface ConferenceJoin {
	/** The media server's id for the leg. The key a member is removed by. */
	readonly mediaChannelId: string;
	readonly legId: string;
	readonly moderator: boolean;
	/** When the member joined, for the `conference.left` duration. */
	readonly joinedAtMs: number;
}

/**
 * One member of a room, as this instance tracks them: who they are, and what has been done to them.
 *
 * ## Why the state lives here and not on the media plane
 *
 * The media plane can be ASKED whether a session is muted — `mute-session` answers with the state
 * after every command — and that is a fact about a SESSION rather than about a member of a room. The
 * two come apart the moment a member is muted for a reason the mixer cannot see: a moderator's mute
 * survives the member being re-pointed at a different bridge, and a participant list has to render
 * it without a round trip per row. So the room is the record and the media plane is the effect.
 *
 * ## Gains are PERCENT here, not the mixer's fixed point
 *
 * Q8 with a unity of 256 is `apps/mediad`'s internal representation, and it stops at the wire.
 * Percent is what the contract carries and what a slider produces, and 100 is a renderable answer
 * ("normal") where an absent field is not — which is why these are required rather than optional.
 */
export interface ConferenceMember extends ConferenceJoin {
	/** Whether the ROOM hears them. */
	readonly muted: boolean;
	/** Whether THEY hear the room. Independent of {@link muted}; both can be true at once. */
	readonly deafened: boolean;
	/** Their contribution to the mix, in percent of unity. 100 is unchanged. */
	readonly talkGainPercent: number;
	/** What they hear of the mix, in percent of unity. 100 is unchanged. */
	readonly listenGainPercent: number;
}

/** What a moderation command asks to change. Absent fields are left alone. */
export interface ConferenceMemberPatch {
	readonly muted?: boolean;
	readonly deafened?: boolean;
	readonly moderator?: boolean;
	readonly talkGainPercent?: number;
	readonly listenGainPercent?: number;
}

/** Unity, in the percent this file and the contract speak. */
export const CONFERENCE_UNITY_GAIN_PERCENT = 100;

/**
 * A room, as the joiner sees it.
 *
 * `members` is what THIS instance holds; `memberCount` and `moderatorPresent` are cluster-wide when
 * claims are shared and identical to the local figures when they are not. The two are separate
 * fields rather than one because a caller needs both: the bridge teardown asks "is this instance's
 * last member leaving?", and the `maxMembers` gate asks "how many are in the room anywhere?".
 */
export interface ConferenceRoom {
	readonly conferenceId: string;
	readonly bridgeId: string;
	readonly members: readonly ConferenceMember[];
	readonly moderatorPresent: boolean;
	/** Cluster-wide. Never smaller than `members.length`. */
	readonly memberCount: number;
	/**
	 * Whether the room is admitting new participants. Cluster-wide when claims are shared.
	 *
	 * A moderator's decision, and NOT the same thing as a room at `maxMembers` even though a caller
	 * hears the same refusal: a full room admits the next arrival the moment somebody leaves, and a
	 * locked one admits nobody until it is unlocked.
	 */
	readonly locked: boolean;
}

/** What a join attempt produced. */
export type ConferenceJoinResult =
	| { readonly kind: "joined"; readonly room: ConferenceRoom; readonly created: boolean }
	/** The room is at `maxMembers`, counting every instance. The bridge is untouched. */
	| { readonly kind: "full"; readonly memberCount: number }
	/**
	 * A moderator has closed the room. The bridge is untouched and nobody is counted.
	 *
	 * Distinct from `full` so the caller can say something different, which is the whole reason the
	 * lock is a separate fact: "the meeting is full, try in a minute" and "the meeting has started"
	 * ask the caller to do opposite things.
	 */
	| { readonly kind: "locked"; readonly memberCount: number }
	/** Shared claims are configured and the bucket could not be reached. The join did NOT happen. */
	| { readonly kind: "claims-unavailable"; readonly reason: string };

/** What a lock or unlock produced. */
export type ConferenceLockResult =
	| { readonly kind: "set"; readonly locked: boolean; readonly memberCount: number }
	/** Nobody on this instance is in that room. The caller should try another contributor. */
	| { readonly kind: "unknown-conference" }
	| { readonly kind: "claims-unavailable"; readonly reason: string };

export interface ConferenceDeparture {
	readonly member?: ConferenceMember;
	/** Cluster-wide count after the removal. */
	readonly memberCount: number;
	/** Whether THIS instance's copy of the room is now empty and its bridge can be destroyed. */
	readonly emptied: boolean;
}

/**
 * How many times a join will re-read and retry a lost compare-and-set.
 *
 * Small on purpose. Each retry is a room whose membership changed under us, which for a real
 * conference happens once or twice at the top of the hour and never four times in a row. A larger
 * number would turn a hot room into a spin on the call path.
 */
const CAS_ATTEMPTS = 4;

interface MutableRoom {
	readonly conferenceId: string;
	bridgeId: string;
	readonly members: Map<string, ConferenceMember>;
	readonly moderatorWaiters: Set<() => void>;
	/** The claim backing this room, when claims are shared. */
	claim?: Claimed<ConferenceClaim>;
	/** Cluster-wide, from the claim. Equals the local figures when claims are not shared. */
	memberCount: number;
	moderatorPresent: boolean;
	/** Cluster-wide, from the claim. Local-only when claims are not shared. */
	locked: boolean;
	organizationId?: string;
}

@Injectable()
export class ConferenceRegistry {
	private readonly logger = getLogger("engine.conference");
	private readonly rooms = new Map<string | undefined, Map<string, MutableRoom>>();

	private bucket: ClaimBucket<ConferenceClaim> = new UnclaimedBucket<ConferenceClaim>();
	private instanceId = "engine-local";
	private now: () => number = Date.now;

	/** Binds the shared claim bucket. See `ParkRegistry.bindClaims` for why this is a setter. */
	bindClaims(
		bucket: ClaimBucket<ConferenceClaim>,
		instanceId: string,
		now: () => number = Date.now,
	): void {
		this.bucket = bucket;
		this.instanceId = instanceId;
		this.now = now;
	}

	/** Whether rooms are agreed across instances. `false` means single-instance, by choice. */
	get isShared(): boolean {
		return this.bucket.isConfigured;
	}

	/** Rooms this process is hosting. `/healthz` and the specs read it. */
	get roomCount(): number {
		let count = 0;
		for (const organizationRooms of this.rooms.values()) {
			count += organizationRooms.size;
		}
		return count;
	}

	/** A room's current state as this instance knows it, or `undefined` when nobody here is in it. */
	room(conferenceId: string, organizationId?: string): ConferenceRoom | undefined {
		const room = this.localRoomIfUnambiguous(conferenceId, organizationId);
		return room === undefined ? undefined : snapshot(room);
	}

	/**
	 * Adds a member, creating the room if this is the first one in ANYWHERE.
	 *
	 * `newBridgeId` is supplied rather than minted here so the caller — the only thing that can
	 * actually create a bridge on the media server — decides the id before the media call, and so a
	 * spec gets deterministic ids. It is used only when this joiner WINS the create; a joiner who
	 * loses gets the winner's id back in `room.bridgeId` and must use that one. Ignoring it is how a
	 * room splits, so the return value is not optional to read.
	 *
	 * `created` tells the caller whether this instance now believes it owns a bridge that has to be
	 * created on the media server. It is `true` for the cluster-wide first joiner and, deliberately,
	 * also for the first joiner ON THIS INSTANCE of a room another instance started — the media
	 * server's bridge creation takes a client-assigned id and is an upsert, so creating it twice is
	 * safe and NOT creating it when the other instance's bridge has since been torn down is not.
	 */
	async join(
		conferenceId: string,
		joining: ConferenceJoin,
		options: {
			readonly newBridgeId: string;
			readonly maxMembers: number;
			readonly organizationId?: string;
		},
	): Promise<ConferenceJoinResult> {
		const member = seat(joining);
		if (!this.bucket.isConfigured) {
			return this.joinLocal(conferenceId, member, options);
		}
		const organizationId = options.organizationId;
		if (organizationId === undefined) {
			// No tenant means no key. Refusing rather than falling back to a local room: a local room
			// in a clustered deployment is the split this class exists to prevent.
			return { kind: "claims-unavailable", reason: "a conference claim needs an organization" };
		}

		let key: string;
		try {
			key = kvKeyFor.conferenceClaim(organizationId, conferenceId);
		} catch (error) {
			return {
				kind: "claims-unavailable",
				reason: `not a valid conference-claim key: ${String(error)}`,
			};
		}

		for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
			const now = this.now();
			const read = await this.bucket.get(key);
			if (read.kind === "unavailable") {
				return { kind: "claims-unavailable", reason: read.reason };
			}
			const current = read.kind === "present" ? read.claim : undefined;
			const currentState = current === undefined ? undefined : this.claimState(current.value, now);

			if (current === undefined || currentState?.memberCount === 0) {
				// Nobody holds the room, or its owner stopped heartbeating and the bridge went with it.
				// Either way this joiner is the first one in.
				const record = this.claimRecord({
					orgId: organizationId,
					conferenceId,
					bridgeId: options.newBridgeId,
					claimedAt: now,
					nowMs: now,
					localMemberCount: 1,
					localModeratorPresent: member.moderator,
				});
				const written =
					current === undefined
						? await this.bucket.create(key, record)
						: await this.bucket.update(key, record, current.revision);
				if (written.kind === "unavailable") {
					return { kind: "claims-unavailable", reason: written.reason };
				}
				if (written.kind === "lost") {
					continue;
				}
				const room = this.localRoom(conferenceId, options.newBridgeId, organizationId);
				room.members.set(member.mediaChannelId, member);
				room.claim = { value: record, revision: written.revision };
				room.memberCount = 1;
				room.moderatorPresent = member.moderator;
				return { kind: "joined", room: snapshot(room), created: true };
			}

			// Somebody holds the room. The cap is checked against the CLUSTER-wide count, which is the
			// whole reason it is in the claim. `> 0` because `maxMembers: 0` is "no limit", which is
			// `pbx-db`'s default everywhere else in this schema.
			// `current` is defined here — the first-in branch above exits (return or continue) in
			// every case — and so is `currentState`, but the compiler cannot tie two locals'
			// undefined-ness together, so the derivation is restated rather than asserted.
			const heldState = currentState ?? this.claimState(current.value, now);
			// The lock is checked BEFORE the cap and before any write, on the value this attempt just
			// read under compare-and-set — which is what makes it cluster-wide rather than a suggestion:
			// a joiner landing on a neighbour reads the same key and is refused the same way.
			//
			// Before the cap, and not after, because the two are different answers to the caller and the
			// stronger one wins: a locked room that also happens to be full is still "the meeting has
			// started", which is the thing worth saying.
			if (current.value.locked === true) {
				return { kind: "locked", memberCount: heldState.memberCount };
			}
			if (options.maxMembers > 0 && heldState.memberCount >= options.maxMembers) {
				return { kind: "full", memberCount: heldState.memberCount };
			}
			const existing = this.localRoomIfUnambiguous(conferenceId, organizationId);

			const record = this.claimRecord({
				orgId: organizationId,
				conferenceId,
				bridgeId: current.value.bridgeId,
				claimedAt: current.value.claimedAt,
				nowMs: now,
				current: current.value,
				localMemberCount: (existing?.members.size ?? 0) + 1,
				localModeratorPresent: existing?.moderatorPresent === true || member.moderator,
				...lockOf(current.value),
			});
			const written = await this.bucket.update(key, record, current.revision);
			if (written.kind === "unavailable") {
				return { kind: "claims-unavailable", reason: written.reason };
			}
			if (written.kind === "lost") {
				continue;
			}

			// The winner's bridge id, always — including when this instance already had a room under a
			// different id, which is a split being repaired.
			const room = this.localRoom(conferenceId, current.value.bridgeId, organizationId);
			room.bridgeId = current.value.bridgeId;
			const created = existing === undefined;
			room.members.set(member.mediaChannelId, member);
			room.claim = { value: record, revision: written.revision };
			const nextState = this.claimState(record, now);
			room.memberCount = nextState.memberCount;
			room.moderatorPresent = nextState.moderatorPresent;
			room.locked = record.locked === true;
			if (nextState.moderatorPresent) {
				this.releaseModeratorWaiters(room);
			}
			return { kind: "joined", room: snapshot(room), created };
		}

		return {
			kind: "claims-unavailable",
			reason: `the room's claim changed under ${String(CAS_ATTEMPTS)} attempts; the join was refused rather than retried indefinitely`,
		};
	}

	/**
	 * Removes a member.
	 *
	 * Returns the state AFTER the removal, so a caller can decide whether the bridge is now empty and
	 * must be destroyed. `emptied` is about THIS instance — it is the question "may I destroy the
	 * bridge?" and only the last member on the last instance may, which is why it is `true` only when
	 * the cluster-wide count has also reached zero.
	 *
	 * A member who is not in the room is not an error — a walk that aborted between the media call
	 * and the registry call produces exactly that, and a throw on the teardown path is worse than a
	 * no-op. The claim is still decremented in that case only if the member was actually there,
	 * because a decrement for a member who never joined is how a room's count drifts below its real
	 * size and lets a twenty-first person in.
	 */
	async leave(
		conferenceId: string,
		mediaChannelId: string,
		organizationId?: string,
	): Promise<ConferenceDeparture> {
		const room = this.localRoomIfUnambiguous(conferenceId, organizationId);
		if (room === undefined) {
			return { memberCount: 0, emptied: false };
		}
		const member = room.members.get(mediaChannelId);
		room.members.delete(mediaChannelId);

		const clusterCount = member === undefined ? room.memberCount : await this.decrement(room);
		room.memberCount = clusterCount;

		if (room.members.size === 0) {
			// Waiters first: a caller holding for a moderator in a room that just emptied would
			// otherwise hold forever, with nothing left to wake it.
			this.releaseModeratorWaiters(room);
			this.deleteLocalRoom(room);
			return {
				...(member === undefined ? {} : { member }),
				memberCount: clusterCount,
				emptied: clusterCount <= 0,
			};
		}
		return {
			...(member === undefined ? {} : { member }),
			memberCount: clusterCount,
			emptied: false,
		};
	}

	/**
	 * Resolves when a moderator is in the room — immediately, if one already is.
	 *
	 * The returned `cancel` is what a caller who hung up while holding uses to stop waiting; it is
	 * safe to call after the promise has already resolved.
	 *
	 * A moderator who joins on ANOTHER instance cannot fire this waiter. {@link refresh} is how the
	 * holder notices; see the class note.
	 */
	awaitModerator(
		conferenceId: string,
		organizationId?: string,
	): {
		readonly arrived: Promise<void>;
		readonly cancel: () => void;
	} {
		const room = this.localRoomIfUnambiguous(conferenceId, organizationId);
		if (room === undefined || room.moderatorPresent) {
			return { arrived: Promise.resolve(), cancel: () => undefined };
		}

		let waiter: () => void = () => undefined;
		const arrived = new Promise<void>((resolve) => {
			waiter = resolve;
		});
		room.moderatorWaiters.add(waiter);
		return {
			arrived,
			cancel: () => {
				room.moderatorWaiters.delete(waiter);
				waiter();
			},
		};
	}

	/**
	 * Re-reads a room's claim and wakes local waiters if the cluster has gained a moderator.
	 *
	 * Polled by whoever is holding a caller at a moderator gate, and by nothing else. A no-op when
	 * claims are not shared, because then the local waiter is already the whole truth.
	 *
	 * Returns whether a moderator is now present, so the poller can stop.
	 */
	async refresh(conferenceId: string, organizationId?: string): Promise<boolean> {
		const room = this.localRoomIfUnambiguous(conferenceId, organizationId);
		if (room === undefined) {
			return false;
		}
		if (!this.bucket.isConfigured || room.organizationId === undefined) {
			return room.moderatorPresent;
		}
		const read = await this.bucket.get(kvKeyFor.conferenceClaim(room.organizationId, conferenceId));
		if (read.kind !== "present") {
			return room.moderatorPresent;
		}
		const current = read.claim;
		room.claim = current;
		const state = this.claimState(current.value, this.now());
		room.memberCount = state.memberCount;
		// The lock travels on the same poll. A moderator who locks the room from a phone registered on
		// another instance is exactly the case this method exists for, and a local copy that never
		// learned would render an unlocked room in a moderation panel that had just locked it.
		room.locked = current.value.locked === true;
		if (state.moderatorPresent && !room.moderatorPresent) {
			room.moderatorPresent = true;
			this.releaseModeratorWaiters(room);
		}
		return room.moderatorPresent;
	}

	/**
	 * Pushes every room claim this instance participates in forward.
	 *
	 * Unlike a park claim, a conference claim is held JOINTLY: several instances have members in one
	 * room and any of them renewing keeps it alive. So a lost heartbeat here is not a takeover — it
	 * is another instance having written first, which is normal — and the fresh revision is simply
	 * adopted. Only an `unavailable` is worth a log.
	 *
	 * Returns how many rooms were renewed, which is what a metric reads.
	 */
	async heartbeat(): Promise<number> {
		if (!this.bucket.isConfigured) {
			return 0;
		}
		let renewed = 0;
		for (const room of this.allRooms()) {
			const claim = room.claim;
			if (claim === undefined || room.organizationId === undefined) {
				continue;
			}
			const key = kvKeyFor.conferenceClaim(room.organizationId, room.conferenceId);
			const now = this.now();
			const record = this.claimRecord({
				orgId: room.organizationId,
				conferenceId: room.conferenceId,
				bridgeId: room.bridgeId,
				claimedAt: claim.value.claimedAt,
				nowMs: now,
				current: claim.value,
				localMemberCount: room.members.size,
				localModeratorPresent: [...room.members.values()].some((member) => member.moderator),
				// A heartbeat rewrites the WHOLE value, so dropping the flag here would unlock every
				// locked room in the cluster on somebody's timer.
				...lockOf(claim.value),
			});
			const written = await this.bucket.update(key, record, claim.revision);
			if (written.kind === "written") {
				room.claim = { value: record, revision: written.revision };
				const state = this.claimState(record, now);
				room.memberCount = state.memberCount;
				room.moderatorPresent = state.moderatorPresent;
				room.locked = record.locked === true;
				renewed += 1;
				continue;
			}
			if (written.kind === "lost") {
				// Another participant's instance renewed it. Adopt their revision and carry on.
				if (written.current !== undefined) {
					room.claim = written.current;
					const state = this.claimState(written.current.value, now);
					room.memberCount = state.memberCount;
					room.moderatorPresent = state.moderatorPresent;
					room.locked = written.current.value.locked === true;
				}
				continue;
			}
			this.logger.warn(
				{ conferenceId: room.conferenceId, reason: written.reason },
				"a conference claim could not be renewed; retrying on the next heartbeat",
			);
		}
		return renewed;
	}

	// -------------------------------------------------------------------------------------------
	// Moderation: what a live room's owner can do to it
	// -------------------------------------------------------------------------------------------

	/**
	 * A member of a room this instance holds, found by LEG id.
	 *
	 * By leg and not by media channel, which is what {@link leave} keys on, and the difference is the
	 * whole reason this method exists rather than a Map lookup at the call site. A media channel id
	 * is the engine's private handle onto a media server: it changes when the driver changes, the
	 * control plane has never seen one, and a REST path segment carrying one would put an Asterisk-ism
	 * in a URL. The leg id is what `conference.joined` publishes, so it is the only identifier both
	 * ends already share.
	 *
	 * `undefined` means "not on this instance", which a caller reads as "ask the next contributor"
	 * rather than as "no such participant" — see the fan-out note on the control subject.
	 */
	memberByLeg(
		conferenceId: string,
		legId: string,
		organizationId?: string,
	): ConferenceMember | undefined {
		const room = this.localRoomIfUnambiguous(conferenceId, organizationId);
		if (room === undefined) {
			return undefined;
		}
		for (const member of room.members.values()) {
			if (member.legId === legId) {
				return member;
			}
		}
		return undefined;
	}

	/**
	 * Changes what the room believes about one member, and returns the state afterwards.
	 *
	 * ## State here, effect on the media plane
	 *
	 * This writes the RECORD and performs no media command. The caller — the conference-control
	 * responder — issues the mute or the gain change and calls this, in that order, because a record
	 * that says muted while the mixer disagrees is worse than a media command whose record is a
	 * moment behind: the first is what a moderation panel renders and acts on again.
	 *
	 * ## Absent fields are left alone
	 *
	 * A patch and not a replacement, so `deaf` does not clear a mute somebody else applied. That is
	 * the same argument the media plane's ADDITIVE mute makes one layer down, for the same reason: a
	 * moderator lifting the wrong gate because they touched an adjacent control is how a participant
	 * gets their audio back in a room that had a reason to take it.
	 *
	 * Returns `undefined` when this instance does not hold the member.
	 */
	setMemberState(
		conferenceId: string,
		legId: string,
		patch: ConferenceMemberPatch,
		organizationId?: string,
	): ConferenceMember | undefined {
		const room = this.localRoomIfUnambiguous(conferenceId, organizationId);
		if (room === undefined) {
			return undefined;
		}
		for (const [mediaChannelId, member] of room.members) {
			if (member.legId !== legId) {
				continue;
			}
			const updated: ConferenceMember = {
				...member,
				muted: patch.muted ?? member.muted,
				deafened: patch.deafened ?? member.deafened,
				moderator: patch.moderator ?? member.moderator,
				talkGainPercent: patch.talkGainPercent ?? member.talkGainPercent,
				listenGainPercent: patch.listenGainPercent ?? member.listenGainPercent,
			};
			room.members.set(mediaChannelId, updated);
			if (updated.moderator && !room.moderatorPresent) {
				// A promotion opens the same gate an arriving moderator does. Without this, a room whose
				// only moderator was promoted mid-meeting would hold its `waitForModerator` callers
				// forever, waiting for somebody who is already in the room.
				room.moderatorPresent = true;
				this.releaseModeratorWaiters(room);
			}
			return updated;
		}
		return undefined;
	}

	/**
	 * Opens or closes the room to new participants, cluster-wide.
	 *
	 * ## The flag goes in the CLAIM, and that is the whole design
	 *
	 * A lock held in one instance's memory is a lock a caller can walk around by landing on a
	 * neighbour, which on a fleet of eight happens seven times out of eight. The claim is the value
	 * every joiner already reads on the join path — it is where the cluster-wide member count comes
	 * from — so honouring a lock costs one field read on a read that was going to happen.
	 *
	 * Written under compare-and-set against the revision this instance holds, with a bounded retry,
	 * for the reason every other write to this key is: a lock that raced a join and lost would leave
	 * a moderator's decision unrecorded and the room open.
	 *
	 * ## Local rooms lock locally
	 *
	 * A deployment with no claim bucket is single-instance BY CHOICE, and there is no neighbour for a
	 * caller to walk around to. The flag lives on the room and behaves identically.
	 */
	async setLocked(
		conferenceId: string,
		locked: boolean,
		options: { readonly organizationId?: string; readonly byUserId?: string } = {},
	): Promise<ConferenceLockResult> {
		const room = this.localRoomIfUnambiguous(conferenceId, options.organizationId);
		if (room === undefined) {
			return { kind: "unknown-conference" };
		}
		if (!this.bucket.isConfigured || room.organizationId === undefined) {
			room.locked = locked;
			return { kind: "set", locked, memberCount: Math.max(room.memberCount, room.members.size) };
		}

		const key = kvKeyFor.conferenceClaim(room.organizationId, conferenceId);
		for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
			const read = await this.bucket.get(key);
			if (read.kind === "unavailable") {
				return { kind: "claims-unavailable", reason: read.reason };
			}
			if (read.kind !== "present") {
				// The claim is gone, which means the room emptied while this command was in flight.
				return { kind: "unknown-conference" };
			}
			const current = read.claim;
			const now = this.now();
			const record: ConferenceClaim = {
				...this.claimRecord({
					orgId: room.organizationId,
					conferenceId,
					bridgeId: current.value.bridgeId,
					claimedAt: current.value.claimedAt,
					nowMs: now,
					current: current.value,
					localMemberCount: room.members.size,
					localModeratorPresent: [...room.members.values()].some((member) => member.moderator),
				}),
				// NOT `lockOf(current.value)` — this is the one write that is allowed to change the flag.
				...(locked
					? {
							locked: true,
							...(options.byUserId === undefined ? {} : { lockedByUserId: options.byUserId }),
							lockedAtMs: now,
						}
					: {}),
			};
			const written = await this.bucket.update(key, record, current.revision);
			if (written.kind === "unavailable") {
				return { kind: "claims-unavailable", reason: written.reason };
			}
			if (written.kind === "lost") {
				continue;
			}
			room.claim = { value: record, revision: written.revision };
			room.locked = locked;
			const state = this.claimState(record, now);
			room.memberCount = state.memberCount;
			return { kind: "set", locked, memberCount: state.memberCount };
		}
		return {
			kind: "claims-unavailable",
			reason: `the room's claim changed under ${String(CAS_ATTEMPTS)} attempts; the lock was not recorded`,
		};
	}

	/** Drops every room. Used by the drain and by specs. Does not touch the media server or KV. */
	clear(): void {
		for (const room of this.allRooms()) {
			this.releaseModeratorWaiters(room);
		}
		this.rooms.clear();
	}

	// -------------------------------------------------------------------------------------------

	/** The unshared path: exactly the behaviour this class had before claims existed. */
	private joinLocal(
		conferenceId: string,
		member: ConferenceMember,
		options: {
			readonly newBridgeId: string;
			readonly maxMembers: number;
			readonly organizationId?: string;
		},
	): ConferenceJoinResult {
		const existing = this.rooms.get(options.organizationId)?.get(conferenceId);
		if (existing === undefined) {
			const room = this.localRoom(conferenceId, options.newBridgeId, options.organizationId);
			room.members.set(member.mediaChannelId, member);
			room.memberCount = 1;
			room.moderatorPresent = member.moderator;
			return { kind: "joined", room: snapshot(room), created: true };
		}
		// Before the cap, matching the shared path exactly: a locked room that also happens to be full
		// is still "the meeting has started", which is the stronger and more useful answer.
		if (existing.locked) {
			return { kind: "locked", memberCount: existing.members.size };
		}
		if (options.maxMembers > 0 && existing.members.size >= options.maxMembers) {
			return { kind: "full", memberCount: existing.members.size };
		}
		existing.members.set(member.mediaChannelId, member);
		existing.memberCount = existing.members.size;
		if (member.moderator) {
			existing.moderatorPresent = true;
			this.releaseModeratorWaiters(existing);
		}
		return { kind: "joined", room: snapshot(existing), created: false };
	}

	/** Decrements the cluster count under compare-and-set. Returns the count after the write. */
	private async decrement(room: MutableRoom): Promise<number> {
		if (!this.bucket.isConfigured || room.organizationId === undefined) {
			return room.members.size;
		}
		const key = kvKeyFor.conferenceClaim(room.organizationId, room.conferenceId);

		for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
			const read = await this.bucket.get(key);
			if (read.kind !== "present") {
				return room.members.size;
			}
			const current = read.claim;
			const now = this.now();
			const record = this.claimRecord({
				orgId: room.organizationId,
				conferenceId: room.conferenceId,
				bridgeId: current.value.bridgeId,
				claimedAt: current.value.claimedAt,
				nowMs: now,
				current: current.value,
				localMemberCount: room.members.size,
				localModeratorPresent: [...room.members.values()].some((member) => member.moderator),
				...lockOf(current.value),
			});
			const nextState = this.claimState(record, now);
			if (nextState.memberCount === 0) {
				// The last member anywhere. Releasing the key rather than writing a zero: an empty room
				// must not keep a bridge id alive that the media server is about to destroy.
				if (await this.bucket.release(key, current.revision)) {
					room.claim = undefined;
					return 0;
				}
				continue;
			}
			const written = await this.bucket.update(key, record, current.revision);
			if (written.kind === "written") {
				room.claim = { value: record, revision: written.revision };
				return nextState.memberCount;
			}
			if (written.kind === "unavailable") {
				// A leave is a teardown. Refusing it would strand a member in a room they have left, so
				// the local removal stands and the claim self-corrects at its expiry.
				this.logger.warn(
					{ conferenceId: room.conferenceId, reason: written.reason },
					"a conference member count could not be decremented; the claim will expire",
				);
				return room.members.size;
			}
		}
		return room.members.size;
	}

	private localRoom(conferenceId: string, bridgeId: string, organizationId?: string): MutableRoom {
		const existing = this.rooms.get(organizationId)?.get(conferenceId);
		if (existing !== undefined) {
			return existing;
		}
		const room: MutableRoom = {
			conferenceId,
			bridgeId,
			members: new Map<string, ConferenceMember>(),
			moderatorWaiters: new Set<() => void>(),
			memberCount: 0,
			moderatorPresent: false,
			locked: false,
			...(organizationId === undefined ? {} : { organizationId }),
		};
		const organizationRooms = this.rooms.get(organizationId) ?? new Map<string, MutableRoom>();
		organizationRooms.set(conferenceId, room);
		this.rooms.set(organizationId, organizationRooms);
		return room;
	}

	private localRoomIfUnambiguous(
		conferenceId: string,
		organizationId?: string,
	): MutableRoom | undefined {
		if (organizationId !== undefined) {
			return this.rooms.get(organizationId)?.get(conferenceId);
		}

		let match: MutableRoom | undefined;
		for (const organizationRooms of this.rooms.values()) {
			const candidate = organizationRooms.get(conferenceId);
			if (candidate === undefined) {
				continue;
			}
			if (match !== undefined) {
				return undefined;
			}
			match = candidate;
		}
		return match;
	}

	private deleteLocalRoom(room: MutableRoom): void {
		const organizationRooms = this.rooms.get(room.organizationId);
		organizationRooms?.delete(room.conferenceId);
		if (organizationRooms?.size === 0) {
			this.rooms.delete(room.organizationId);
		}
	}

	private *allRooms(): IterableIterator<MutableRoom> {
		for (const organizationRooms of this.rooms.values()) {
			yield* organizationRooms.values();
		}
	}

	private claimRecord(input: {
		readonly orgId: string;
		readonly conferenceId: string;
		readonly bridgeId: string;
		readonly claimedAt: number;
		readonly nowMs: number;
		readonly current?: ConferenceClaim;
		readonly localMemberCount: number;
		readonly localModeratorPresent: boolean;
		readonly locked?: boolean;
		readonly lockedByUserId?: string;
		readonly lockedAtMs?: number;
	}): ConferenceClaim {
		const contributions =
			input.current === undefined
				? {}
				: { ...this.claimState(input.current, input.nowMs).contributions };
		delete contributions[this.instanceId];
		if (input.localMemberCount > 0) {
			contributions[this.instanceId] = {
				memberCount: input.localMemberCount,
				moderatorPresent: input.localModeratorPresent,
				expiresAt: input.nowMs + CLAIM_LEASE_MS,
			};
		}
		return {
			orgId: input.orgId,
			claimedAt: input.claimedAt,
			conferenceId: input.conferenceId,
			bridgeId: input.bridgeId,
			contributions,
			// Carried FORWARD from whatever was read, never derived from this instance's opinion. Every
			// write to this key — a join, a leave, a heartbeat — rewrites the whole value, so a
			// heartbeat that dropped the flag would silently unlock a room the moment anybody's timer
			// fired. `input.locked` is what the caller read a moment ago under compare-and-set.
			...(input.locked === true
				? {
						locked: true,
						...(input.lockedByUserId === undefined ? {} : { lockedByUserId: input.lockedByUserId }),
						...(input.lockedAtMs === undefined ? {} : { lockedAtMs: input.lockedAtMs }),
					}
				: {}),
		};
	}

	private claimState(
		claim: ConferenceClaim,
		nowMs: number,
	): {
		readonly contributions: ConferenceClaim["contributions"];
		readonly memberCount: number;
		readonly moderatorPresent: boolean;
	} {
		const contributions: ConferenceClaim["contributions"] = {};
		let memberCount = 0;
		let moderatorPresent = false;
		for (const [instanceId, contribution] of Object.entries(claim.contributions)) {
			if (!Number.isFinite(contribution.expiresAt) || nowMs >= contribution.expiresAt) {
				continue;
			}
			contributions[instanceId] = contribution;
			memberCount += contribution.memberCount;
			moderatorPresent ||= contribution.moderatorPresent;
		}
		return { contributions, memberCount, moderatorPresent };
	}

	private releaseModeratorWaiters(room: MutableRoom): void {
		// A copy: a waiter that resolves may re-enter through `cancel`, and mutating a Set
		// mid-iteration silently skips entries.
		const waiters = Array.from(room.moderatorWaiters);
		room.moderatorWaiters.clear();
		for (const waiter of waiters) {
			waiter();
		}
	}
}

function snapshot(room: MutableRoom): ConferenceRoom {
	const members = [...room.members.values()];
	return {
		conferenceId: room.conferenceId,
		bridgeId: room.bridgeId,
		members,
		moderatorPresent: room.moderatorPresent || members.some((member) => member.moderator),
		memberCount: Math.max(room.memberCount, members.length),
		locked: room.locked,
	};
}

/**
 * A member arriving, with the state a room starts them in.
 *
 * Unmuted, undeafened and at unity, always. There is no configuration for "everybody starts muted",
 * and that is deliberate rather than missing: it is a moderation policy, and a room that applied one
 * at join time would be applying it before the moderator who owns the policy has arrived.
 */
function seat(joining: ConferenceJoin): ConferenceMember {
	return {
		...joining,
		muted: false,
		deafened: false,
		talkGainPercent: CONFERENCE_UNITY_GAIN_PERCENT,
		listenGainPercent: CONFERENCE_UNITY_GAIN_PERCENT,
	};
}

/**
 * The lock fields of a claim, ready to spread into the next one.
 *
 * A function rather than three lines at each of the four call sites, because every write to a
 * conference claim rewrites the WHOLE value: a join, a leave and a heartbeat all rebuild it, and the
 * one that forgot this would silently unlock a live meeting. Four call sites and one omission is the
 * shape of that bug.
 */
function lockOf(claim: ConferenceClaim): {
	readonly locked?: boolean;
	readonly lockedByUserId?: string;
	readonly lockedAtMs?: number;
} {
	if (claim.locked !== true) {
		return {};
	}
	return {
		locked: true,
		...(claim.lockedByUserId === undefined ? {} : { lockedByUserId: claim.lockedByUserId }),
		...(claim.lockedAtMs === undefined ? {} : { lockedAtMs: claim.lockedAtMs }),
	};
}
