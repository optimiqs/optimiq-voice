import { Injectable } from "@nestjs/common";
import { isClaimExpired, isClaimOwnedBy, kvKeyFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { UnclaimedBucket } from "../nats/claim-store";
import { CLAIM_LEASE_MS } from "./claim-timing";
import type { ClaimBucket, ClaimRead } from "../nats/claim-store";
import type { SharedLineState } from "@optimiq-voice/events";

/**
 * Shared line appearances (SLA/BLA), seized across every engine instance.
 *
 * ## The invariant, and where it lives
 *
 * A shared line is ONE seizable resource that appears on several handsets at once. The rule this file
 * enforces is the same shape a park slot's is: **two appearances can never hold one line at once.** An
 * appearance that answers or originates on the line SEIZES it, and every other appearance's lamp must
 * go remote-active so a colleague does not grab a call that is already someone's.
 *
 * That exclusivity is taken in the `shared-line-state` KV bucket with a compare-and-set (`create`, the
 * operation that can LOSE), exactly as {@link import("./park-registry").ParkRegistry} takes an orbit —
 * so it holds ACROSS engine instances behind one media server, not merely within one. A `put` would
 * always win and would let two appearances seize the same line on two nodes, discovered only when a
 * caller reaches the wrong person.
 *
 * ## Seized vs held, and the recall timer
 *
 * A seizure carries a `state`: an ACTIVE seizure while the holder is on the call, and a HELD one while
 * they have parked it on hold. A held line records `heldAtMs`, and a line left on hold past its line's
 * `hold_recall_timeout_seconds` must ring every appearance back rather than stranding the caller on a
 * holder who walked away. {@link SharedLineRegistry.armRecall} arms that timer off the injected
 * `setTimer` seam; the `onRecall` callback is the seam to the live re-ring, which belongs to the
 * INVITE/answer plane and is deliberately not wired here.
 *
 * ## Degradation: configured-and-down REFUSES
 *
 * The same policy as `park-registry.ts`, for the same reason. No bucket configured is a single-instance
 * deployment and behaves exactly as an in-process map would. A bucket configured but unreachable
 * refuses the seizure loudly — a seizure that proceeded on an unrecorded claim is the split this file
 * exists to prevent, arriving during the incident when nobody is watching line lamps.
 *
 * ## Stale seizures are reapable
 *
 * A seizure carries its owning instance and an `expiresAt`, pushed forward on a heartbeat for as long
 * as the appearance holds the line. An instance that dies stops heartbeating, and its seizure becomes
 * reapable by anybody once the expiry passes — see {@link SharedLineRegistry.seize}, which takes over
 * an expired claim with a revision-fenced update rather than treating the line as permanently seized.
 */

/** The appearance seizing a line, as the caller describes it. */
export interface SharedLineSeizure {
	/** The extension the appearance belongs to. */
	readonly extensionId: string;
	/** The button index of this appearance on the line. */
	readonly appearanceIndex: number;
	readonly callId: string;
	readonly legId: string;
}

/** What a seizure attempt produced. */
export type SeizeResult =
	/** This appearance now holds the line, at `revision`. */
	| { readonly won: true; readonly revision: number }
	/** Another appearance holds the line; its seizure is returned so the loser can light its lamp. */
	| { readonly won: false; readonly heldBy: SharedLineState }
	/** Shared claims are configured and the bucket could not be reached. The seizure did NOT happen. */
	| { readonly won: false; readonly heldBy?: undefined; readonly reason: string };

/** What a hold attempt produced. */
export type HoldResult =
	| { readonly kind: "held"; readonly revision: number }
	/** This instance does not hold the line, or the write lost its race. */
	| { readonly kind: "not-held" }
	| { readonly kind: "claims-unavailable"; readonly reason: string };

/** A recall timer, cancellable. Mirrors `call-control.ts`'s `ParkTimer`. */
interface RecallTimer {
	readonly cancel: () => void;
}

interface HeldSeizure {
	/** The value last written for this line. */
	value: SharedLineState;
	/** The KV revision it was written at. Quoted by every heartbeat, hold and release. */
	revision: number;
	/** The key, cached so a release does not have to rebuild it. */
	readonly key: string;
}

@Injectable()
export class SharedLineRegistry {
	private readonly logger = getLogger("engine.shared-line");

	/** `kvKey` → the seizure this instance holds on that line. Empty when no bucket is configured. */
	private readonly seizures = new Map<string, HeldSeizure>();
	/** `kvKey` → the armed recall timer, so a retrieval can cancel it before it fires. */
	private readonly recallTimers = new Map<string, RecallTimer>();

	private bucket: ClaimBucket<SharedLineState> = new UnclaimedBucket<SharedLineState>();
	private instance = "engine-local";
	private now: () => number = Date.now;
	private setTimer: (fn: () => void, ms: number) => RecallTimer = (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return { cancel: () => clearTimeout(timer) };
	};

	/**
	 * Binds the shared claim bucket. See `ParkRegistry.bindClaims` for why this is a setter and not a
	 * constructor argument: the bucket does not exist until `JetStreamService.onModuleInit` has
	 * connected, and this registry is injected into things built before that. An unbound registry is a
	 * LOCAL one, which is correct for a single-instance deployment and for every spec that does not care.
	 *
	 * `setTimer` is injected here too so a spec can fire a recall without waiting real seconds, exactly
	 * as `CallControlDependencies.setTimer` does for the park timeout.
	 */
	bindClaims(
		bucket: ClaimBucket<SharedLineState>,
		instanceId: string,
		now: () => number = Date.now,
		setTimer?: (fn: () => void, ms: number) => RecallTimer,
	): void {
		this.bucket = bucket;
		this.instance = instanceId;
		this.now = now;
		if (setTimer !== undefined) {
			this.setTimer = setTimer;
		}
	}

	/** Whether seizures are shared across instances. `false` means single-instance, by choice. */
	get isShared(): boolean {
		return this.bucket.isConfigured;
	}

	/** This process's identity, as every seizure it writes records it. */
	get instanceId(): string {
		return this.instance;
	}

	/** Lines this instance is holding. `/healthz` and the specs read it. */
	get seizedCount(): number {
		return this.seizures.size;
	}

	/** The seizure this instance holds on a line, or `undefined` when it does not hold it. */
	held(orgId: string, sharedLineId: string): SharedLineState | undefined {
		let key: string;
		try {
			key = kvKeyFor.sharedLineState(orgId, sharedLineId);
		} catch {
			return undefined;
		}
		return this.seizures.get(key)?.value;
	}

	/**
	 * Seizes a shared line for one appearance.
	 *
	 * The `create` decides the race against every other instance: a WON create means this appearance
	 * holds the line; a LOST one is not an error and is not retried blindly — the winner is read off the
	 * value and returned, so the loser lights its lamp remote-active rather than dialling into a call in
	 * progress.
	 *
	 * A seizure that has EXPIRED is taken over rather than respected: its owner stopped heartbeating,
	 * so the appearance that held the line is gone with the instance that held it. This mirrors
	 * `ParkRegistry`'s reaping of an expired park claim.
	 */
	async seize(
		orgId: string,
		sharedLineId: string,
		seizing: SharedLineSeizure,
	): Promise<SeizeResult> {
		let key: string;
		try {
			key = kvKeyFor.sharedLineState(orgId, sharedLineId);
		} catch (error) {
			// An unbuildable key means an id that is not a subject token. Refusing is the only safe
			// answer: proceeding would seize a line under no claim at all.
			return { won: false, reason: `not a valid shared-line-state key: ${String(error)}` };
		}

		if (!this.bucket.isConfigured) {
			const record = this.record(orgId, sharedLineId, seizing, "seized", this.now());
			this.remember(key, record, 0);
			return { won: true, revision: 0 };
		}

		const now = this.now();
		const record = this.record(orgId, sharedLineId, seizing, "seized", now);
		const created = await this.bucket.create(key, record);
		if (created.kind === "written") {
			this.remember(key, record, created.revision);
			// TODO(SLA): reflect remote-active on the other appearances via PresenceService — the losing
			// appearances' lamps should show busy off this seizure. Left a named seam: the presence write
			// belongs to `presence/presence.service.ts`, which composes the dialog-info `sipd` watches.
			return { won: true, revision: created.revision };
		}
		if (created.kind === "unavailable") {
			return { won: false, reason: created.reason };
		}

		// Lost. The one case where losing is not final: an EXPIRED seizure belongs to an instance that
		// stopped heartbeating, and the appearance it named is gone with it.
		const current = created.current;
		if (current === undefined) {
			return { won: false, reason: "the line was seized by another instance mid-read" };
		}
		if (!isClaimExpired(current.value, now)) {
			return { won: false, heldBy: current.value };
		}
		const reaped = await this.bucket.update(key, record, current.revision);
		if (reaped.kind === "written") {
			this.logger.info(
				{ key, previousOwner: current.value.instanceId },
				"reaped an expired shared-line seizure",
			);
			this.remember(key, record, reaped.revision);
			return { won: true, revision: reaped.revision };
		}
		if (reaped.kind === "unavailable") {
			return { won: false, reason: reaped.reason };
		}
		// Somebody else reaped it first. Read the fresh winner so the loser can still light its lamp.
		const after = await this.readClaim(key);
		if (after.kind === "present") {
			return { won: false, heldBy: after.claim.value };
		}
		return { won: false, reason: "the expired line was re-seized by another instance" };
	}

	/**
	 * Moves this instance's seizure to the HELD state, recording when it went on hold.
	 *
	 * `heldAtMs` is what {@link armRecall}'s timer reasons about. The write is revision-fenced against
	 * whatever this instance last wrote for the line; a caller may pass an explicit `revision` when it
	 * holds a fresher one than the local cache.
	 */
	async hold(orgId: string, sharedLineId: string, revision?: number): Promise<HoldResult> {
		let key: string;
		try {
			key = kvKeyFor.sharedLineState(orgId, sharedLineId);
		} catch (error) {
			return {
				kind: "claims-unavailable",
				reason: `not a valid shared-line-state key: ${String(error)}`,
			};
		}
		const held = this.seizures.get(key);
		if (held === undefined) {
			return { kind: "not-held" };
		}
		const now = this.now();
		const next: SharedLineState = {
			...held.value,
			state: "held",
			heartbeatAt: now,
			expiresAt: now + CLAIM_LEASE_MS,
			heldAtMs: now,
		};

		if (!this.bucket.isConfigured) {
			this.remember(key, next, 0);
			return { kind: "held", revision: 0 };
		}

		const written = await this.bucket.update(key, next, revision ?? held.revision);
		if (written.kind === "written") {
			this.remember(key, next, written.revision);
			return { kind: "held", revision: written.revision };
		}
		if (written.kind === "unavailable") {
			return { kind: "claims-unavailable", reason: written.reason };
		}
		return { kind: "not-held" };
	}

	/**
	 * Frees a line this instance holds, deleting the seizure key.
	 *
	 * Ownership is proven before the delete — a release of a seizure this instance does not own would
	 * hand a live caller's line to the next appearance — so a seizure another instance has since taken
	 * over is left untouched. Any armed recall for the line is cancelled: the line is being collected,
	 * not abandoned.
	 */
	async release(orgId: string, sharedLineId: string, instanceId: string): Promise<boolean> {
		let key: string;
		try {
			key = kvKeyFor.sharedLineState(orgId, sharedLineId);
		} catch {
			return false;
		}
		const held = this.seizures.get(key);
		if (held === undefined || !isClaimOwnedBy(held.value, instanceId)) {
			return false;
		}
		this.cancelRecallByKey(key);
		this.seizures.delete(key);
		if (!this.bucket.isConfigured) {
			return true;
		}
		return await this.bucket.release(key, held.revision);
	}

	/**
	 * Pushes every seizure this instance holds forward.
	 *
	 * Called on a timer by {@link import("./claim-heartbeat.service").ClaimHeartbeatService}. A seizure
	 * whose heartbeat is LOST to another write from THIS instance adopts that write's revision; a loss to
	 * another instance drops the local cache rather than fighting for the line. Mirrors
	 * `ParkRegistry.heartbeat`.
	 *
	 * Returns how many seizures were renewed, which is what a metric reads.
	 */
	async heartbeat(): Promise<number> {
		if (!this.bucket.isConfigured || this.seizures.size === 0) {
			return 0;
		}
		const now = this.now();
		let renewed = 0;

		// A snapshot: a lost heartbeat DELETES from `seizures`, and mutating a Map mid-iteration
		// silently skips entries.
		for (const [key, held] of Array.from(this.seizures)) {
			const next: SharedLineState = {
				...held.value,
				heartbeatAt: now,
				expiresAt: now + CLAIM_LEASE_MS,
			};
			const outcome = await this.bucket.update(key, next, held.revision);
			if (outcome.kind === "written") {
				this.remember(key, next, outcome.revision);
				renewed += 1;
				continue;
			}
			if (outcome.kind === "unavailable") {
				// Keep the seizure and try again next tick. Three heartbeat opportunities occur strictly
				// before expiry, so a blip does not cost a line.
				this.logger.warn(
					{ key, reason: outcome.reason },
					"a shared-line seizure could not be renewed; retrying on the next heartbeat",
				);
				continue;
			}
			if (outcome.current?.value.instanceId === this.instance) {
				this.remember(key, outcome.current.value, outcome.current.revision);
				continue;
			}
			this.logger.warn(
				{ key, owner: outcome.current?.value.instanceId },
				"a shared-line seizure was taken over by another instance; dropping it locally",
			);
			this.seizures.delete(key);
			this.cancelRecallByKey(key);
		}
		return renewed;
	}

	/**
	 * Arms a recall timer for a held line.
	 *
	 * When the line's `hold_recall_timeout_seconds` elapses, `onRecall` fires — the seam to the live
	 * re-ring of every appearance. `timeoutMs <= 0` arms NOTHING: a line whose `hold_recall_timeout` is
	 * 0 is one the tenant has chosen never to recall, and a zero-delay timer would fire immediately.
	 *
	 * A second arm for the same line replaces the first, so re-holding a line does not leave two timers
	 * racing to recall it.
	 */
	armRecall(orgId: string, sharedLineId: string, timeoutMs: number, onRecall: () => void): void {
		let key: string;
		try {
			key = kvKeyFor.sharedLineState(orgId, sharedLineId);
		} catch {
			return;
		}
		this.cancelRecallByKey(key);
		if (timeoutMs <= 0) {
			return;
		}
		const timer = this.setTimer(() => {
			this.recallTimers.delete(key);
			onRecall();
		}, timeoutMs);
		this.recallTimers.set(key, timer);
	}

	/** Cancels a line's armed recall, if any. A line with no timer is a no-op, never an error. */
	cancelRecall(orgId: string, sharedLineId: string): void {
		let key: string;
		try {
			key = kvKeyFor.sharedLineState(orgId, sharedLineId);
		} catch {
			return;
		}
		this.cancelRecallByKey(key);
	}

	/** Whether a recall is currently armed for a line. Read by the specs. */
	hasRecallArmed(orgId: string, sharedLineId: string): boolean {
		try {
			return this.recallTimers.has(kvKeyFor.sharedLineState(orgId, sharedLineId));
		} catch {
			return false;
		}
	}

	/** Drops every seizure and cancels every recall. Used by the drain and by specs. */
	clear(): void {
		for (const timer of this.recallTimers.values()) {
			timer.cancel();
		}
		this.recallTimers.clear();
		this.seizures.clear();
	}

	// -------------------------------------------------------------------------------------------

	private async readClaim(key: string): Promise<ClaimRead<SharedLineState>> {
		try {
			return await this.bucket.get(key);
		} catch (error) {
			return { kind: "unavailable", reason: String(error) };
		}
	}

	private record(
		orgId: string,
		sharedLineId: string,
		seizing: SharedLineSeizure,
		state: SharedLineState["state"],
		nowMs: number,
	): SharedLineState {
		return {
			orgId,
			instanceId: this.instance,
			claimedAt: nowMs,
			heartbeatAt: nowMs,
			expiresAt: nowMs + CLAIM_LEASE_MS,
			sharedLineId,
			state,
			heldByExtensionId: seizing.extensionId,
			heldByAppearanceIndex: seizing.appearanceIndex,
			callId: seizing.callId,
			legId: seizing.legId,
		};
	}

	private remember(key: string, value: SharedLineState, revision: number): void {
		// Tracked locally whether or not claims are shared: `hold` and `release` need the last value and
		// revision either way, and a single-instance deployment's line is exactly this map.
		this.seizures.set(key, { value, revision, key });
	}

	private cancelRecallByKey(key: string): void {
		this.recallTimers.get(key)?.cancel();
		this.recallTimers.delete(key);
	}
}
