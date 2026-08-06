import { Injectable } from "@nestjs/common";

/**
 * Conference rooms, as this engine process sees them.
 *
 * ## Why a registry and not a field on the walker
 *
 * Every other destination the plan walker executes is per-call: an extension dial, a ring group
 * race, an IVR's retry counters all begin and end inside one `walk()`. A conference is the first
 * one that is not. Two callers dialing `3001` are two walks, and they have to end up in the SAME
 * mixing bridge or they are two calls that cannot hear each other. So the bridge id, the member
 * set and "is a moderator here yet?" belong to something that outlives a walk, and this is it.
 *
 * ## The scope is one process, and that is a stated limitation
 *
 * This is an in-memory map. Two engine instances behind the same media server each create their
 * own bridge for room `3001` and neither knows about the other, so a room whose participants land
 * on different instances splits in two. Fixing it means a shared claim — the bridge id in the KV
 * bucket, taken under a compare-and-set — and that is a wave of its own: it needs an owner for
 * cleanup when the claiming instance dies, which is the hard half.
 *
 * Recording it here rather than in a ticket because the failure is silent: everybody hears hold
 * music and nobody hears each other, which reads as a media bug and is not one. A single-instance
 * deployment — which is what the compose file and the integration harness run — has no split.
 *
 * ## `waitForModerator` is a promise, not a poll
 *
 * A participant held in music on hold is waiting for an event that happens in a DIFFERENT walk.
 * Polling would work and would also mean every held caller wakes on a timer forever; a waiter
 * resolved by the moderator's own join costs nothing while it waits and fires once.
 */

/** One member of a room, as the registry tracks them. */
export interface ConferenceMember {
	/** The media server's id for the leg. The key a member is removed by. */
	readonly mediaChannelId: string;
	readonly legId: string;
	readonly moderator: boolean;
	/** When the member joined, for the `conference.left` duration. */
	readonly joinedAtMs: number;
}

/** A room this process is hosting. */
export interface ConferenceRoom {
	readonly conferenceId: string;
	readonly bridgeId: string;
	readonly members: readonly ConferenceMember[];
	readonly moderatorPresent: boolean;
}

/** What a join attempt produced. */
export type ConferenceJoinResult =
	| { readonly kind: "joined"; readonly room: ConferenceRoom; readonly created: boolean }
	/** The room is at `maxMembers`. The caller is told, and the bridge is untouched. */
	| { readonly kind: "full"; readonly memberCount: number };

interface MutableRoom {
	readonly conferenceId: string;
	readonly bridgeId: string;
	readonly members: Map<string, ConferenceMember>;
	readonly moderatorWaiters: Set<() => void>;
}

@Injectable()
export class ConferenceRegistry {
	private readonly rooms = new Map<string, MutableRoom>();

	/** Rooms this process is hosting. `/healthz` and the specs read it. */
	get roomCount(): number {
		return this.rooms.size;
	}

	/** A room's current state, or `undefined` when nobody is in it. */
	room(conferenceId: string): ConferenceRoom | undefined {
		const room = this.rooms.get(conferenceId);
		return room === undefined ? undefined : snapshot(room);
	}

	/**
	 * Adds a member, creating the room if this is the first one in.
	 *
	 * `newBridgeId` is supplied rather than minted here so the caller — which is the only thing
	 * that can actually create a bridge on the media server — decides the id BEFORE the media call,
	 * and so a spec gets deterministic ids. It is used only when the room does not exist yet.
	 *
	 * `created` tells the caller whether it now owns a bridge that has to be created on the media
	 * server. Doing the media call here would put an `await` inside the only critical section this
	 * class has, and a second joiner could then see a room whose bridge does not exist yet.
	 */
	join(
		conferenceId: string,
		member: ConferenceMember,
		options: { readonly newBridgeId: string; readonly maxMembers: number },
	): ConferenceJoinResult {
		const existing = this.rooms.get(conferenceId);
		if (existing === undefined) {
			const room: MutableRoom = {
				conferenceId,
				bridgeId: options.newBridgeId,
				members: new Map([[member.mediaChannelId, member]]),
				moderatorWaiters: new Set(),
			};
			this.rooms.set(conferenceId, room);
			return { kind: "joined", room: snapshot(room), created: true };
		}

		// `> 0` because a room with `maxMembers: 0` is "no limit", which is what `pbx-db`'s default
		// of 0 means everywhere else in this schema.
		if (options.maxMembers > 0 && existing.members.size >= options.maxMembers) {
			return { kind: "full", memberCount: existing.members.size };
		}

		existing.members.set(member.mediaChannelId, member);
		if (member.moderator) {
			this.releaseModeratorWaiters(existing);
		}
		return { kind: "joined", room: snapshot(existing), created: false };
	}

	/**
	 * Removes a member.
	 *
	 * Returns the state AFTER the removal, so a caller can decide whether the bridge is now empty
	 * and must be destroyed. An empty room is dropped from the map here: leaving it behind would
	 * make the next caller join a bridge the media server has already torn down.
	 *
	 * A member who is not in the room is not an error — a walk that aborted between the media call
	 * and the registry call would produce exactly that, and a throw on the teardown path is worse
	 * than a no-op.
	 */
	leave(
		conferenceId: string,
		mediaChannelId: string,
	): {
		readonly member?: ConferenceMember;
		readonly memberCount: number;
		readonly emptied: boolean;
	} {
		const room = this.rooms.get(conferenceId);
		if (room === undefined) {
			return { memberCount: 0, emptied: false };
		}
		const member = room.members.get(mediaChannelId);
		room.members.delete(mediaChannelId);
		if (room.members.size === 0) {
			// Waiters first: a caller holding for a moderator in a room that just emptied would
			// otherwise hold forever, with nothing left to wake it.
			this.releaseModeratorWaiters(room);
			this.rooms.delete(conferenceId);
			return {
				...(member === undefined ? {} : { member }),
				memberCount: 0,
				emptied: true,
			};
		}
		return {
			...(member === undefined ? {} : { member }),
			memberCount: room.members.size,
			emptied: false,
		};
	}

	/**
	 * Resolves when a moderator is in the room — immediately, if one already is.
	 *
	 * The returned `cancel` is what a caller who hung up while holding uses to stop waiting; it is
	 * safe to call after the promise has already resolved.
	 */
	awaitModerator(conferenceId: string): {
		readonly arrived: Promise<void>;
		readonly cancel: () => void;
	} {
		const room = this.rooms.get(conferenceId);
		if (room === undefined || [...room.members.values()].some((member) => member.moderator)) {
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

	/** Drops every room. Used by the drain and by specs. Does not touch the media server. */
	clear(): void {
		for (const room of this.rooms.values()) {
			this.releaseModeratorWaiters(room);
		}
		this.rooms.clear();
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
		moderatorPresent: members.some((member) => member.moderator),
	};
}
