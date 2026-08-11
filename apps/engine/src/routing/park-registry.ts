import { Injectable } from "@nestjs/common";
import { isClaimExpired, isClaimOwnedBy, kvKeyFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import {
	isParkSlotInRange,
	nextFreeParkSlot,
	parkSlotCapacity,
	parseParkSlot,
} from "@optimiq-voice/telephony";
import { UnclaimedBucket } from "../nats/claim-store";
import type { ClaimBucket, Claimed } from "../nats/claim-store";
import type { ParkClaim } from "@optimiq-voice/events";
import type { ParkSlotRangeBounds } from "@optimiq-voice/telephony";

/**
 * Park lots, claimed across every engine instance.
 *
 * ## The invariant, and where it now lives
 *
 * Everything here is arranged around one thing: **two calls can never occupy one orbit.** A caller
 * told "she is on 401" must reach exactly that person.
 *
 * That used to be enforced by an in-process map, which held it within one engine and said nothing
 * across two: a second instance behind the same media server handed out 401 again, and the failure
 * was silent — the retriever was told the slot was empty, which is indistinguishable from a
 * colleague having already collected it. The claim is now taken in the `park-claims` KV bucket with
 * a compare-and-set (`create`, the operation that can LOSE), so the exclusivity is cluster-wide.
 *
 * The map is still here, as a CACHE. It answers `at`, `lot` and `forChannel` without a round trip,
 * it is what makes slot selection a local decision rather than a scan of the bucket, and it holds
 * the revision each claim was written at so a release can prove it owns what it is releasing.
 *
 * ## Degradation: configured-and-down REFUSES
 *
 * Two different situations, deliberately not conflated:
 *
 * - **No claim bucket configured** (`UnclaimedBucket`): a deployment saying "one instance". The
 *   registry behaves exactly as it did before claims existed — local map, no round trips, no
 *   refusals. This is what the specs and the compose file run.
 * - **A bucket configured but unreachable**: the park is REFUSED, loudly, with the broker's own
 *   reason. This is the same posture the rest of the engine takes to a database that is down, and
 *   it is the honest one: a park that proceeded on a claim nobody recorded is a slot two instances
 *   can hand out, discovered days later by a caller who reached a stranger.
 *
 * ## Stale claims are reapable, and that is what makes a crash survivable
 *
 * A claim carries its owning instance and an `expiresAt`, and the owner pushes that forward on a
 * heartbeat for as long as the call is parked. An instance that dies stops heartbeating, and its
 * claims become reapable by anybody once the expiry passes — see {@link ParkRegistry.park}, which
 * takes over an expired claim rather than treating it as an occupied slot. Without that, a crash
 * removes orbits from a tenant's lot permanently.
 *
 * ## Cross-instance RETRIEVAL
 *
 * A claim is enough to make the SLOT exclusive; it is not enough to bridge a caller whose channel
 * this process does not hold. So {@link ParkRegistry.claim} does not answer with a bare "somebody
 * else has it" — it answers with WHICH somebody and WHAT they are holding, in three distinct shapes
 * the retriever recovers from differently:
 *
 * - `elsewhere` — a live claim on another instance. The retriever asks that instance to hand the
 *   call over, over `rpc.engine.v1.park-handoff` (see `apps/engine/src/calls/park-handoff.ts`).
 * - `stale` — a claim whose owner stopped heartbeating. Nobody can be asked; the retriever wins the
 *   claim with {@link ParkRegistry.takeOverStale} and decides for itself whether the channel the
 *   dead instance left behind is still on the media server.
 * - `absent` — nothing, anywhere.
 *
 * This registry stays out of the media entirely: it says who owns what, and `CallControl` moves the
 * audio.
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
	/** Every orbit in the lot is taken — by this instance, by another one, or by both. */
	| { readonly kind: "lot-full"; readonly capacity: number }
	/** The caller asked for a specific orbit and it is occupied, or outside the lot. */
	| { readonly kind: "slot-unavailable"; readonly slot: number }
	/**
	 * Shared claims are configured and the bucket could not be reached. The park did NOT happen and
	 * must not be retried locally — see the degradation note on the class.
	 */
	| { readonly kind: "claims-unavailable"; readonly reason: string };

/** What a retrieval attempt produced. */
export type ParkClaimResult =
	| { readonly kind: "claimed"; readonly entry: ParkedCall }
	/** Nothing is on that orbit, anywhere. */
	| { readonly kind: "absent" }
	/**
	 * A call IS on that orbit, on another engine instance whose claim is LIVE.
	 *
	 * The entry is reconstructed from the claim record, which is why the record carries the whole
	 * park and not just a slot number: the retriever needs the parked channel's id to fence its
	 * handoff request (see `rpc.engine.v1.park-handoff`) against a claim that was reaped and
	 * re-taken between the read and the request.
	 */
	| { readonly kind: "elsewhere"; readonly instanceId: string; readonly entry: ParkedCall }
	/**
	 * A call was on that orbit and its owner stopped heartbeating.
	 *
	 * Distinct from `elsewhere`, because the recoveries are opposite: a live owner is ASKED to hand
	 * the call over, while a dead one cannot be asked anything and the retriever must decide for
	 * itself whether the channel it left behind is still there. Distinct from `absent` — which is
	 * what this used to be — because "the claim is stale" is not the same fact as "nothing was ever
	 * here", and only one of them has a caller who may still be on hold at the end of it.
	 */
	| { readonly kind: "stale"; readonly instanceId: string; readonly entry: ParkedCall };

/**
 * How long a claim is believable without a heartbeat.
 *
 * Comfortably longer than {@link CLAIM_HEARTBEAT_INTERVAL_MS} so an instance under load, or a
 * broker that blipped, does not lose slots it is still serving — and far shorter than the bucket's
 * own TTL, so the reaping decision is the record's and not the server's.
 */
export const CLAIM_LEASE_MS = 90_000;

/** How often an owner pushes its claims' expiry forward. A third of the lease, as leases go. */
export const CLAIM_HEARTBEAT_INTERVAL_MS = 30_000;

interface HeldClaim {
	readonly entry: ParkedCall;
	/** The KV revision the claim was last written at. Quoted by every heartbeat and release. */
	revision: number;
	/** The key, cached so a release does not have to rebuild (and re-validate) it. */
	readonly key: string;
}

@Injectable()
export class ParkRegistry {
	private readonly logger = getLogger("engine.park");

	/** `parkLotId` → `slot` → entry. Two levels because a slot number is only unique within a lot. */
	private readonly lots = new Map<string, Map<number, ParkedCall>>();
	/** `mediaChannelId` → the entry it occupies, so a hangup can release a slot in one lookup. */
	private readonly byChannel = new Map<string, ParkedCall>();
	/** `mediaChannelId` → the claim backing it. Empty when no bucket is configured. */
	private readonly claims = new Map<string, HeldClaim>();

	private bucket: ClaimBucket<ParkClaim> = new UnclaimedBucket<ParkClaim>();
	private instance = "engine-local";
	private now: () => number = Date.now;

	/**
	 * Binds the shared claim bucket.
	 *
	 * A setter rather than a constructor argument because the bucket does not exist until
	 * `JetStreamService.onModuleInit` has connected, and this registry is injected into things that
	 * are built before that. An unbound registry is a LOCAL one, which is the correct behaviour for
	 * a single-instance deployment and for every spec that does not care.
	 */
	bindClaims(
		bucket: ClaimBucket<ParkClaim>,
		instanceId: string,
		now: () => number = Date.now,
	): void {
		this.bucket = bucket;
		this.instance = instanceId;
		this.now = now;
	}

	/** Whether claims are shared. `false` means single-instance, by deployment choice. */
	get isShared(): boolean {
		return this.bucket.isConfigured;
	}

	/**
	 * This process's identity, as every claim it writes records it.
	 *
	 * Read by the cross-instance retrieval path so the requester it puts on the wire and the owner
	 * a claim names are the same string by construction, rather than by two call sites agreeing to
	 * read the same environment variable.
	 */
	get instanceId(): string {
		return this.instance;
	}

	/** Calls parked on this process. `/healthz` and the specs read it. */
	get parkedCount(): number {
		return this.byChannel.size;
	}

	/** Every call in one lot on THIS instance, in ascending slot order. */
	lot(parkLotId: string): readonly ParkedCall[] {
		const slots = this.lots.get(parkLotId);
		return slots === undefined
			? []
			: [...slots.values()].sort((left, right) => left.slot - right.slot);
	}

	/** The call in one orbit on this instance, or `undefined` when this instance does not hold it. */
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
	 * ## The order: pick locally, claim globally, record locally
	 *
	 * The local map narrows the candidates to the slots this instance is not already using, which
	 * makes the common case one round trip rather than a scan. The `create` then decides the race
	 * against every other instance. A LOST create is not an error and is not retried blindly: the
	 * slot is marked as taken-by-somebody and the next free one is tried, bounded by the lot's own
	 * capacity so a lot being hammered refuses rather than spins on the call path.
	 *
	 * `preferredSlot` is REFUSED rather than reassigned when it is taken, because the parker has
	 * usually already announced it — and that holds whether the occupant is on this instance or
	 * another. One attempt, one honest answer.
	 *
	 * A claim that has EXPIRED is taken over rather than respected: its owner stopped heartbeating,
	 * which means the instance holding that call is gone and so is the call.
	 */
	async park(
		range: ParkSlotRangeBounds,
		entry: Omit<ParkedCall, "slot">,
		preferredSlot?: number,
	): Promise<ParkResult> {
		const capacity = Math.max(1, parkSlotCapacity(range));
		const attempted = new Set<number>();

		// One attempt for an explicitly requested orbit; up to the lot's capacity when auto-assigning,
		// because every attempt eliminates exactly one slot.
		const maxAttempts = preferredSlot === undefined ? capacity : 1;

		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			const slots = this.lots.get(entry.parkLotId);
			const taken = new Set<number>([...(slots?.keys() ?? []), ...attempted]);
			const chosen = nextFreeParkSlot(range, taken.values(), preferredSlot);

			if (chosen === undefined) {
				return preferredSlot === undefined
					? { kind: "lot-full", capacity: taken.size }
					: { kind: "slot-unavailable", slot: preferredSlot };
			}
			// Belt and braces: `nextFreeParkSlot` already range-checks, but a lot whose range changed
			// under a live artifact reload must not be able to hand out an orbit nobody can dial.
			if (!isParkSlotInRange(range, chosen)) {
				return { kind: "slot-unavailable", slot: chosen };
			}

			attempted.add(chosen);
			const parked: ParkedCall = { ...entry, slot: chosen };
			const outcome = await this.takeClaim(parked);

			switch (outcome.kind) {
				case "taken":
					this.record(parked, outcome.revision, outcome.key);
					return { kind: "parked", entry: parked };
				case "unavailable":
					return { kind: "claims-unavailable", reason: outcome.reason };
				case "lost":
					if (preferredSlot !== undefined) {
						return { kind: "slot-unavailable", slot: chosen };
					}
					// Round again: this orbit belongs to another instance, and `attempted` now excludes it.
					break;
			}
		}

		return { kind: "lot-full", capacity: attempted.size };
	}

	/**
	 * Takes a call OUT of its slot, exclusively.
	 *
	 * `claim` rather than `get` because that is what it does: the entry is removed before it is
	 * returned, so the second of two simultaneous retrievals is told the truth. The LOCAL removal is
	 * what settles a race between two extensions on this instance; the KV release is what stops
	 * another instance from finding a claim for a call that has already been collected.
	 *
	 * A slot held by another instance answers `elsewhere`. See the class note on why the media
	 * handoff is not in this wave.
	 */
	async claim(parkLotId: string, slot: number, organizationId?: string): Promise<ParkClaimResult> {
		// Read the backing claim BEFORE the local removal: `removeLocal` clears the claim index too,
		// and looking it up afterwards would leave the KV key held by a call that has been collected —
		// an orbit permanently removed from the lot, discovered only when it never comes free.
		const occupant = this.at(parkLotId, slot);
		const held = occupant === undefined ? undefined : this.claims.get(occupant.mediaChannelId);
		const local = this.removeLocal(parkLotId, slot);
		if (local !== undefined) {
			if (held !== undefined) {
				await this.bucket.release(held.key);
			}
			return { kind: "claimed", entry: local };
		}

		if (!this.bucket.isConfigured) {
			return { kind: "absent" };
		}

		const orgId = organizationId;
		if (orgId === undefined) {
			// Without the tenant there is no key to look under. Local-only answer, which is the same
			// one this method has always given for a slot this instance does not hold.
			return { kind: "absent" };
		}
		const remote = await this.readClaim(orgId, parkLotId, slot);
		if (remote === undefined) {
			return { kind: "absent" };
		}
		const entry = entryFromClaim(remote.value);
		if (isClaimExpired(remote.value, this.now())) {
			// The owner stopped heartbeating. The claim is LEFT in place rather than deleted — a
			// delete here would race the next parker's `create` — and the retriever is told which
			// instance went quiet, so it can decide whether the channel that instance left behind is
			// still reachable. See {@link ParkRegistry.takeOverStale}.
			return { kind: "stale", instanceId: remote.value.instanceId, entry };
		}
		return { kind: "elsewhere", instanceId: remote.value.instanceId, entry };
	}

	/**
	 * Wins an EXPIRED claim, so this instance may collect the orphan channel it names.
	 *
	 * The compare-and-set is the whole point: two extensions dialling one orbit whose owner died
	 * both read the same stale claim, and exactly one of them may go on to bridge the caller. The
	 * loser is told the orbit is empty, which by then it is.
	 *
	 * Nothing is recorded locally. A won takeover is not a park — this instance has no leg, no
	 * aggregate and no CDR for the channel; it has permission to move it, once. The winner
	 * {@link ParkRegistry.discard}s the key when it is done, either way.
	 *
	 * Returns `false` when the claim was renewed, re-taken or removed in between, and when no
	 * bucket is configured at all (a single-instance deployment has no stale claims by
	 * construction, so a takeover there would be taking over from itself).
	 */
	async takeOverStale(entry: ParkedCall): Promise<boolean> {
		if (!this.bucket.isConfigured) {
			return false;
		}
		let key: string;
		try {
			key = kvKeyFor.parkClaim(entry.organizationId, entry.parkLotId, entry.slot);
		} catch {
			return false;
		}
		const current = await this.bucket.get(key);
		const now = this.now();
		if (current === undefined || !isClaimExpired(current.value, now)) {
			return false;
		}
		const won = await this.bucket.update(key, this.claimRecord(entry, now), current.revision);
		if (won.kind !== "written") {
			return false;
		}
		this.logger.info(
			{ key, previousOwner: current.value.instanceId },
			"took over an expired park claim to retrieve the call it was holding",
		);
		return true;
	}

	/**
	 * Deletes an orbit's claim outright.
	 *
	 * Only the stale-takeover path uses it, and only for a claim it just won: a retrieval that
	 * bridged the orphan channel must free the orbit, and one that found the channel gone must free
	 * it too — a slot held by a claim nobody will ever release is an orbit removed from the tenant
	 * until its lease elapses. Every other release goes through {@link ParkRegistry.claim}, which
	 * proves local ownership first.
	 */
	async discard(organizationId: string, parkLotId: string, slot: number): Promise<void> {
		if (!this.bucket.isConfigured) {
			return;
		}
		try {
			await this.bucket.release(kvKeyFor.parkClaim(organizationId, parkLotId, slot));
		} catch {
			// A key that could not be deleted is reaped at its expiry, which is what the expiry is for.
		}
	}

	/**
	 * Puts a claimed call back where it was.
	 *
	 * The park machine's `retrieving → parked` edge, made real: a retrieval that failed — the
	 * retriever's phone died, the bridge was refused — must leave the caller collectable rather than
	 * stranded in a lot nobody can address.
	 *
	 * Returns `false` when the orbit was taken in the meantime, ON EITHER SIDE. The local check
	 * catches this instance; the `create` catches every other one. A caller that treated a lost
	 * restore as success would put two calls on one orbit at precisely the moment the system was
	 * already having a bad day.
	 */
	async restore(entry: ParkedCall): Promise<boolean> {
		if (this.lots.get(entry.parkLotId)?.has(entry.slot) === true) {
			return false;
		}
		const outcome = await this.takeClaim(entry);
		if (outcome.kind !== "taken") {
			return false;
		}
		this.record(entry, outcome.revision, outcome.key);
		return true;
	}

	/** Frees whatever slot this leg holds. A leg that is not parked is a no-op, never an error. */
	async release(mediaChannelId: string): Promise<ParkedCall | undefined> {
		const entry = this.byChannel.get(mediaChannelId);
		if (entry === undefined) {
			return undefined;
		}
		const result = await this.claim(entry.parkLotId, entry.slot, entry.organizationId);
		return result.kind === "claimed" ? result.entry : undefined;
	}

	/**
	 * Pushes every claim this instance holds forward.
	 *
	 * Called on a timer by whoever owns this registry's lifecycle. A claim whose heartbeat is LOST —
	 * somebody else wrote the key — is dropped from the local cache rather than re-taken: another
	 * instance believes it owns that orbit, and two owners is the state this whole file exists to
	 * make impossible. The call itself is untouched; it simply stops being addressable by slot, which
	 * is strictly better than being addressable by two instances at once.
	 *
	 * Returns how many claims were renewed, which is what a metric reads.
	 */
	async heartbeat(): Promise<number> {
		if (!this.bucket.isConfigured || this.claims.size === 0) {
			return 0;
		}
		const now = this.now();
		let renewed = 0;

		// A snapshot: a lost heartbeat DELETES from `claims`, and mutating a Map mid-iteration
		// silently skips entries.
		for (const [mediaChannelId, held] of Array.from(this.claims)) {
			const record = this.claimRecord(held.entry, now);
			const outcome = await this.bucket.update(held.key, record, held.revision);
			if (outcome.kind === "written") {
				held.revision = outcome.revision;
				renewed += 1;
				continue;
			}
			if (outcome.kind === "unavailable") {
				// Keep the claim and try again next tick. The lease is three heartbeats long precisely
				// so a blip does not cost a slot.
				this.logger.warn(
					{ key: held.key, reason: outcome.reason },
					"a park claim could not be renewed; retrying on the next heartbeat",
				);
				continue;
			}
			this.logger.warn(
				{ key: held.key, owner: outcome.current?.value.instanceId },
				"a park claim was taken over by another instance; dropping it locally",
			);
			this.claims.delete(mediaChannelId);
			this.removeLocal(held.entry.parkLotId, held.entry.slot);
		}
		return renewed;
	}

	/** Drops every lot. Used by the drain and by specs. Does not touch the media server or KV. */
	clear(): void {
		this.lots.clear();
		this.byChannel.clear();
		this.claims.clear();
	}

	// -------------------------------------------------------------------------------------------

	private async takeClaim(
		entry: ParkedCall,
	): Promise<
		| { readonly kind: "taken"; readonly revision: number; readonly key: string }
		| { readonly kind: "lost" }
		| { readonly kind: "unavailable"; readonly reason: string }
	> {
		if (!this.bucket.isConfigured) {
			return { kind: "taken", revision: 0, key: "" };
		}

		let key: string;
		try {
			key = kvKeyFor.parkClaim(entry.organizationId, entry.parkLotId, entry.slot);
		} catch (error) {
			// An unbuildable key means an id that is not a subject token. Refusing is the only safe
			// answer: proceeding would park a call under no claim at all.
			return { kind: "unavailable", reason: `not a valid park-claim key: ${String(error)}` };
		}

		const now = this.now();
		const created = await this.bucket.create(key, this.claimRecord(entry, now));
		if (created.kind === "written") {
			return { kind: "taken", revision: created.revision, key };
		}
		if (created.kind === "unavailable") {
			return { kind: "unavailable", reason: created.reason };
		}

		// Lost. The one case where losing is not final: an EXPIRED claim belongs to an instance that
		// stopped heartbeating, and the call it was holding is gone with it.
		const current = created.current;
		if (current === undefined || !isClaimExpired(current.value, now)) {
			return { kind: "lost" };
		}
		const reaped = await this.bucket.update(key, this.claimRecord(entry, now), current.revision);
		if (reaped.kind === "written") {
			this.logger.info(
				{ key, previousOwner: current.value.instanceId },
				"reaped an expired park claim",
			);
			return { kind: "taken", revision: reaped.revision, key };
		}
		// Somebody else reaped it first, or the broker went away mid-reap. Either way this instance
		// does not own the slot.
		return reaped.kind === "unavailable"
			? { kind: "unavailable", reason: reaped.reason }
			: { kind: "lost" };
	}

	private async readClaim(
		organizationId: string,
		parkLotId: string,
		slot: number,
	): Promise<Claimed<ParkClaim> | undefined> {
		try {
			return await this.bucket.get(kvKeyFor.parkClaim(organizationId, parkLotId, slot));
		} catch {
			return undefined;
		}
	}

	private claimRecord(entry: ParkedCall, nowMs: number): ParkClaim {
		return {
			orgId: entry.organizationId,
			instanceId: this.instance,
			claimedAt: entry.parkedAtMs,
			heartbeatAt: nowMs,
			expiresAt: nowMs + CLAIM_LEASE_MS,
			parkLotId: entry.parkLotId,
			slot: entry.slot,
			mediaChannelId: entry.mediaChannelId,
			legId: entry.legId,
			callId: entry.callId,
			parkedAtMs: entry.parkedAtMs,
			...(entry.parkedByLegId === undefined ? {} : { parkedByLegId: entry.parkedByLegId }),
			...(entry.parkedByNumber === undefined ? {} : { parkedByNumber: entry.parkedByNumber }),
			...(entry.mohClass === undefined ? {} : { mohClass: entry.mohClass }),
		};
	}

	private record(entry: ParkedCall, revision: number, key: string): void {
		const slots = this.lots.get(entry.parkLotId) ?? new Map<number, ParkedCall>();
		slots.set(entry.slot, entry);
		this.lots.set(entry.parkLotId, slots);
		this.byChannel.set(entry.mediaChannelId, entry);
		if (this.bucket.isConfigured) {
			this.claims.set(entry.mediaChannelId, { entry, revision, key });
		}
	}

	private removeLocal(parkLotId: string, slot: number): ParkedCall | undefined {
		const slots = this.lots.get(parkLotId);
		const entry = slots?.get(slot);
		if (slots === undefined || entry === undefined) {
			return undefined;
		}
		slots.delete(slot);
		this.byChannel.delete(entry.mediaChannelId);
		this.claims.delete(entry.mediaChannelId);
		if (slots.size === 0) {
			this.lots.delete(parkLotId);
		}
		return entry;
	}
}

/**
 * The park a claim record describes.
 *
 * The claim carries every field a {@link ParkedCall} has, for exactly this: an instance that never
 * held the call must be able to reason about it — to fence a handoff request against the channel it
 * expects, to report how long the caller waited, and to name the leg on the retriever's CDR.
 */
function entryFromClaim(claim: ParkClaim): ParkedCall {
	return {
		parkLotId: claim.parkLotId,
		slot: claim.slot,
		mediaChannelId: claim.mediaChannelId,
		legId: claim.legId,
		callId: claim.callId,
		organizationId: claim.orgId,
		parkedAtMs: claim.parkedAtMs,
		...(claim.parkedByLegId === undefined ? {} : { parkedByLegId: claim.parkedByLegId }),
		...(claim.parkedByNumber === undefined ? {} : { parkedByNumber: claim.parkedByNumber }),
		...(claim.mohClass === undefined ? {} : { mohClass: claim.mohClass }),
	};
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

/** Re-exported so a caller can assert ownership without importing the events package directly. */
export { isClaimExpired, isClaimOwnedBy };
