import { Injectable } from "@nestjs/common";
import { isClaimExpired, kvKeyFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { UnclaimedBucket } from "../nats/claim-store";
import { CLAIM_LEASE_MS } from "./park-registry";
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
 * already in the meeting. Both counts therefore live in the claim and move under compare-and-set, on
 * every join and every leave. The CAS retry is bounded: a join that keeps losing is a room being
 * hammered, and refusing on the call path beats spinning on it.
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

/** One member of a room, as this instance tracks them. */
export interface ConferenceMember {
	/** The media server's id for the leg. The key a member is removed by. */
	readonly mediaChannelId: string;
	readonly legId: string;
	readonly moderator: boolean;
	/** When the member joined, for the `conference.left` duration. */
	readonly joinedAtMs: number;
}

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
}

/** What a join attempt produced. */
export type ConferenceJoinResult =
	| { readonly kind: "joined"; readonly room: ConferenceRoom; readonly created: boolean }
	/** The room is at `maxMembers`, counting every instance. The bridge is untouched. */
	| { readonly kind: "full"; readonly memberCount: number }
	/** Shared claims are configured and the bucket could not be reached. The join did NOT happen. */
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
	organizationId?: string;
}

@Injectable()
export class ConferenceRegistry {
	private readonly logger = getLogger("engine.conference");
	private readonly rooms = new Map<string, MutableRoom>();

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
		return this.rooms.size;
	}

	/** A room's current state as this instance knows it, or `undefined` when nobody here is in it. */
	room(conferenceId: string): ConferenceRoom | undefined {
		const room = this.rooms.get(conferenceId);
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
		member: ConferenceMember,
		options: {
			readonly newBridgeId: string;
			readonly maxMembers: number;
			readonly organizationId?: string;
		},
	): Promise<ConferenceJoinResult> {
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
			const current = await this.bucket.get(key);

			if (current === undefined || isClaimExpired(current.value, now)) {
				// Nobody holds the room, or its owner stopped heartbeating and the bridge went with it.
				// Either way this joiner is the first one in.
				const record = this.claimRecord({
					orgId: organizationId,
					conferenceId,
					bridgeId: options.newBridgeId,
					memberCount: 1,
					moderatorPresent: member.moderator,
					claimedAt: now,
					nowMs: now,
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
			if (options.maxMembers > 0 && current.value.memberCount >= options.maxMembers) {
				return { kind: "full", memberCount: current.value.memberCount };
			}

			const record = this.claimRecord({
				orgId: organizationId,
				conferenceId,
				bridgeId: current.value.bridgeId,
				memberCount: current.value.memberCount + 1,
				moderatorPresent: current.value.moderatorPresent || member.moderator,
				claimedAt: current.value.claimedAt,
				nowMs: now,
			});
			const written = await this.bucket.update(key, record, current.revision);
			if (written.kind === "unavailable") {
				return { kind: "claims-unavailable", reason: written.reason };
			}
			if (written.kind === "lost") {
				continue;
			}

			const existing = this.rooms.get(conferenceId);
			// The winner's bridge id, always — including when this instance already had a room under a
			// different id, which is a split being repaired.
			const room = this.localRoom(conferenceId, current.value.bridgeId, organizationId);
			room.bridgeId = current.value.bridgeId;
			const created = existing === undefined;
			room.members.set(member.mediaChannelId, member);
			room.claim = { value: record, revision: written.revision };
			room.memberCount = record.memberCount;
			room.moderatorPresent = record.moderatorPresent;
			if (record.moderatorPresent) {
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
	async leave(conferenceId: string, mediaChannelId: string): Promise<ConferenceDeparture> {
		const room = this.rooms.get(conferenceId);
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
			this.rooms.delete(conferenceId);
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
	awaitModerator(conferenceId: string): {
		readonly arrived: Promise<void>;
		readonly cancel: () => void;
	} {
		const room = this.rooms.get(conferenceId);
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
	async refresh(conferenceId: string): Promise<boolean> {
		const room = this.rooms.get(conferenceId);
		if (room === undefined) {
			return false;
		}
		if (!this.bucket.isConfigured || room.organizationId === undefined) {
			return room.moderatorPresent;
		}
		const current = await this.bucket.get(
			kvKeyFor.conferenceClaim(room.organizationId, conferenceId),
		);
		if (current === undefined) {
			return room.moderatorPresent;
		}
		room.claim = current;
		room.memberCount = current.value.memberCount;
		if (current.value.moderatorPresent && !room.moderatorPresent) {
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
		for (const room of this.rooms.values()) {
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
				memberCount: claim.value.memberCount,
				moderatorPresent: claim.value.moderatorPresent,
				claimedAt: claim.value.claimedAt,
				nowMs: now,
			});
			const written = await this.bucket.update(key, record, claim.revision);
			if (written.kind === "written") {
				room.claim = { value: record, revision: written.revision };
				renewed += 1;
				continue;
			}
			if (written.kind === "lost") {
				// Another participant's instance renewed it. Adopt their revision and carry on.
				if (written.current !== undefined) {
					room.claim = written.current;
					room.memberCount = written.current.value.memberCount;
					room.moderatorPresent = written.current.value.moderatorPresent;
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

	/** Drops every room. Used by the drain and by specs. Does not touch the media server or KV. */
	clear(): void {
		for (const room of this.rooms.values()) {
			this.releaseModeratorWaiters(room);
		}
		this.rooms.clear();
	}

	// -------------------------------------------------------------------------------------------

	/** The unshared path: exactly the behaviour this class had before claims existed. */
	private joinLocal(
		conferenceId: string,
		member: ConferenceMember,
		options: { readonly newBridgeId: string; readonly maxMembers: number },
	): ConferenceJoinResult {
		const existing = this.rooms.get(conferenceId);
		if (existing === undefined) {
			const room = this.localRoom(conferenceId, options.newBridgeId);
			room.members.set(member.mediaChannelId, member);
			room.memberCount = 1;
			room.moderatorPresent = member.moderator;
			return { kind: "joined", room: snapshot(room), created: true };
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
			const current = await this.bucket.get(key);
			if (current === undefined) {
				return room.members.size;
			}
			const next = Math.max(0, current.value.memberCount - 1);
			if (next === 0) {
				// The last member anywhere. Releasing the key rather than writing a zero: an empty room
				// must not keep a bridge id alive that the media server is about to destroy.
				await this.bucket.release(key);
				room.claim = undefined;
				return 0;
			}
			const record = this.claimRecord({
				orgId: room.organizationId,
				conferenceId: room.conferenceId,
				bridgeId: current.value.bridgeId,
				memberCount: next,
				// A moderator who leaves does not re-close the gate: people already talking must not be
				// silently ejected, and the callers still holding were held on a promise that has fired.
				moderatorPresent: current.value.moderatorPresent,
				claimedAt: current.value.claimedAt,
				nowMs: this.now(),
			});
			const written = await this.bucket.update(key, record, current.revision);
			if (written.kind === "written") {
				room.claim = { value: record, revision: written.revision };
				return next;
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
		const existing = this.rooms.get(conferenceId);
		if (existing !== undefined) {
			if (organizationId !== undefined) {
				existing.organizationId = organizationId;
			}
			return existing;
		}
		const room: MutableRoom = {
			conferenceId,
			bridgeId,
			members: new Map<string, ConferenceMember>(),
			moderatorWaiters: new Set<() => void>(),
			memberCount: 0,
			moderatorPresent: false,
			...(organizationId === undefined ? {} : { organizationId }),
		};
		this.rooms.set(conferenceId, room);
		return room;
	}

	private claimRecord(input: {
		readonly orgId: string;
		readonly conferenceId: string;
		readonly bridgeId: string;
		readonly memberCount: number;
		readonly moderatorPresent: boolean;
		readonly claimedAt: number;
		readonly nowMs: number;
	}): ConferenceClaim {
		return {
			orgId: input.orgId,
			instanceId: this.instanceId,
			claimedAt: input.claimedAt,
			heartbeatAt: input.nowMs,
			expiresAt: input.nowMs + CLAIM_LEASE_MS,
			conferenceId: input.conferenceId,
			bridgeId: input.bridgeId,
			memberCount: input.memberCount,
			moderatorPresent: input.moderatorPresent,
		};
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
	};
}
