import { Injectable } from "@nestjs/common";
import { isParkSlotInRange, nextFreeParkSlot, parseParkSlot } from "@optimiq-voice/telephony";
import type { ParkSlotRangeBounds } from "@optimiq-voice/telephony";

/**
 * Park lots, as this engine process sees them.
 *
 * ## Why a registry and not a field on the walker
 *
 * The same reason `conference-registry.ts` exists, and more sharply. A parked call outlives the
 * walk that parked it BY DESIGN: the whole feature is "put this caller somewhere and go and find
 * the person they want", and the retrieval arrives minutes later as a completely different call
 * from a completely different phone. There is no walk to hold the state.
 *
 * ## The slot is the address, and it must be exclusive
 *
 * Everything here is arranged around one invariant: **two calls can never occupy one orbit.** A
 * caller who dials 401 must reach exactly the person they were told is on 401, so the claim on a
 * slot is taken here — synchronously, with no `await` inside the critical section — before any
 * media call is made. `nextFreeParkSlot` in `@optimiq-voice/telephony` decides WHICH slot; this
 * class decides that the decision is exclusive and remembers it.
 *
 * The retrieval side has the same shape in reverse: {@link claim} removes the entry from the lot
 * atomically and hands it to exactly one caller. Two extensions dialling 401 at the same instant
 * therefore produce one connection and one "that call is no longer parked" — not two legs bridged
 * to one caller, which is what a read-then-remove would produce.
 *
 * ## The scope is one process, and that is a stated limitation
 *
 * An in-memory map, exactly like the conference registry, and with the same consequence: two engine
 * instances behind one media server each have their own lot 401, and a call parked on one instance
 * cannot be retrieved from the other. Recorded here because the failure is quiet — the retriever is
 * told the slot is empty, which is indistinguishable from a colleague having already collected it.
 * A shared claim in KV under a compare-and-set is the fix, and it needs an owner for cleanup when
 * the claiming instance dies, which is the hard half and a wave of its own.
 */

/** One call sitting in an orbit slot. */
export interface ParkedCall {
	readonly parkLotId: string;
	readonly slot: number;
	/** The media server's id for the parked leg. */
	readonly mediaChannelId: string;
	readonly legId: string;
	readonly callId: string;
	readonly organizationId: string;
	/** The leg that parked it, for the timeout ringback. Absent when a plan parked the call. */
	readonly parkedByLegId?: string;
	/** The number to ring back when the lot's timeout elapses. */
	readonly parkedByNumber?: string;
	readonly parkedAtMs: number;
	readonly mohClass?: string;
}

/** What a park attempt produced. */
export type ParkResult =
	| { readonly kind: "parked"; readonly entry: ParkedCall }
	/** Every orbit in the lot is taken. */
	| { readonly kind: "lot-full"; readonly capacity: number }
	/** The caller asked for a specific orbit and it is occupied, or outside the lot. */
	| { readonly kind: "slot-unavailable"; readonly slot: number };

@Injectable()
export class ParkRegistry {
	/** `parkLotId` → `slot` → entry. Two levels because a slot number is only unique within a lot. */
	private readonly lots = new Map<string, Map<number, ParkedCall>>();
	/** `mediaChannelId` → the entry it occupies, so a hangup can release a slot in one lookup. */
	private readonly byChannel = new Map<string, ParkedCall>();

	/** Calls parked on this process. `/healthz` and the specs read it. */
	get parkedCount(): number {
		return this.byChannel.size;
	}

	/** Every call in one lot, in ascending slot order. */
	lot(parkLotId: string): readonly ParkedCall[] {
		const slots = this.lots.get(parkLotId);
		return slots === undefined
			? []
			: [...slots.values()].sort((left, right) => left.slot - right.slot);
	}

	/** The call in one orbit, or `undefined` when the slot is free. */
	at(parkLotId: string, slot: number): ParkedCall | undefined {
		return this.lots.get(parkLotId)?.get(slot);
	}

	/** Where a leg is parked, or `undefined` when it is not. */
	forChannel(mediaChannelId: string): ParkedCall | undefined {
		return this.byChannel.get(mediaChannelId);
	}

	/**
	 * Claims an orbit for a call.
	 *
	 * Synchronous and total: the answer is the slot or the reason there is not one, and the claim is
	 * already recorded by the time it returns. The caller then moves the media, and calls
	 * {@link release} if that fails — a claim held by a call that never arrived is the one way this
	 * map can leak, and it is a leak the caller can always see.
	 *
	 * `preferredSlot` is REFUSED rather than reassigned when it is taken, because the parker has
	 * usually already announced it. See `nextFreeParkSlot`.
	 */
	park(
		range: ParkSlotRangeBounds,
		entry: Omit<ParkedCall, "slot">,
		preferredSlot?: number,
	): ParkResult {
		const slots = this.lots.get(entry.parkLotId) ?? new Map<number, ParkedCall>();
		const chosen = nextFreeParkSlot(range, slots.keys(), preferredSlot);

		if (chosen === undefined) {
			if (preferredSlot !== undefined) {
				return { kind: "slot-unavailable", slot: preferredSlot };
			}
			return { kind: "lot-full", capacity: slots.size };
		}
		// Belt and braces: `nextFreeParkSlot` already range-checks, but a lot whose range changed
		// under a live artifact reload must not be able to hand out an orbit nobody can dial.
		if (!isParkSlotInRange(range, chosen)) {
			return { kind: "slot-unavailable", slot: chosen };
		}

		const parked: ParkedCall = { ...entry, slot: chosen };
		slots.set(chosen, parked);
		this.lots.set(entry.parkLotId, slots);
		this.byChannel.set(parked.mediaChannelId, parked);
		return { kind: "parked", entry: parked };
	}

	/**
	 * Takes a call OUT of its slot, exclusively.
	 *
	 * The name is `claim` rather than `get` because that is what it does: the entry is removed
	 * before it is returned, so the second of two simultaneous retrievals gets `undefined` and is
	 * told the truth. A retrieval that then fails puts the call back with {@link restore}.
	 */
	claim(parkLotId: string, slot: number): ParkedCall | undefined {
		const slots = this.lots.get(parkLotId);
		const entry = slots?.get(slot);
		if (slots === undefined || entry === undefined) {
			return undefined;
		}
		slots.delete(slot);
		this.byChannel.delete(entry.mediaChannelId);
		if (slots.size === 0) {
			this.lots.delete(parkLotId);
		}
		return entry;
	}

	/**
	 * Puts a claimed call back where it was.
	 *
	 * The park machine's `retrieving → parked` edge, made real. A retrieval that failed — the
	 * retriever's phone died, the bridge was refused — must leave the caller collectable rather than
	 * stranded in a lot nobody can address.
	 *
	 * Returns `false` when the orbit was taken in the meantime, which the caller must treat as "this
	 * call now has nowhere to go" rather than overwriting somebody else.
	 */
	restore(entry: ParkedCall): boolean {
		const slots = this.lots.get(entry.parkLotId) ?? new Map<number, ParkedCall>();
		if (slots.has(entry.slot)) {
			return false;
		}
		slots.set(entry.slot, entry);
		this.lots.set(entry.parkLotId, slots);
		this.byChannel.set(entry.mediaChannelId, entry);
		return true;
	}

	/** Frees whatever slot this leg holds. A leg that is not parked is a no-op, never an error. */
	release(mediaChannelId: string): ParkedCall | undefined {
		const entry = this.byChannel.get(mediaChannelId);
		if (entry === undefined) {
			return undefined;
		}
		return this.claim(entry.parkLotId, entry.slot);
	}

	/** Drops every lot. Used by the drain and by specs. Does not touch the media server. */
	clear(): void {
		this.lots.clear();
		this.byChannel.clear();
	}
}

/**
 * The orbit a dialled string names within a lot, or `undefined` when it names none.
 *
 * Here rather than at the call site because both entry points need exactly this check and must
 * agree: a caller dialling `401` and a `park` verb carrying `orbit: "401"` have to resolve to the
 * same slot, or a call is parked where nobody looks for it.
 */
export function parkSlotFor(range: ParkSlotRangeBounds, dialed: string): number | undefined {
	const slot = parseParkSlot(dialed);
	return slot !== undefined && isParkSlotInRange(range, slot) ? slot : undefined;
}
