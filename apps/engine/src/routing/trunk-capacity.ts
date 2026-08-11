/**
 * The per-trunk concurrent-call ceiling (`trunk.max_channels`).
 *
 * A carrier sells a channel count. Exceeding it does not degrade — the carrier rejects the call,
 * and it rejects it AFTER the INVITE, so the caller has already heard silence and the tenant has
 * already been billed for the setup on some plans. Worse, a compromised extension dialling in a
 * loop will happily burst straight through the cap, which is the shape of every toll-fraud bill
 * anybody has ever had to argue about. Refusing locally, before the INVITE, is cheaper on every
 * axis and is what `apps/api/src/pbx/carrier/carrier.dto.ts` already promises the field does.
 *
 * ## Why this is per-process, and why that is the right trade
 *
 * The true cluster-wide count lives in the `channels` KV bucket, but that bucket is keyed
 * `<org>.<call>.<leg>` with no trunk token, so answering "how many legs are on this trunk" from
 * it means listing and parsing every live leg in the organization on every dial attempt. The
 * alternative — a CAS counter key of its own — costs two round trips per attempt on the call
 * setup path plus a reaper for a counter whose holder crashed.
 *
 * So this is a map, on the same reasoning `queue-registry.ts` gives for the round-robin cursors:
 * a cap that is enforced per instance is wrong by a factor of the instance count and never wrong
 * in the dangerous direction for a single-instance deployment, which is what this repo ships. The
 * honest limitation is stated rather than hidden: **with N engines the effective ceiling is N ×
 * `maxChannels`.** A cluster-true counter is a KV wave, and the seam for it is this interface.
 *
 * ## The lifecycle
 *
 * A reservation is taken BEFORE the leg is originated — a check that ran after would let a burst
 * of simultaneous dials all see the same count — and it is returned either when the dial fails
 * (the walk releases it) or when the leg that took it ends (the orchestrator releases it by media
 * channel id). Nothing else may hold one: a reservation with no owner is a channel this process
 * will never hand back.
 */

/** One reserved channel on one trunk. */
export interface TrunkReservation {
	/**
	 * Hands the reservation to the leg that took it, so the leg's end returns it.
	 *
	 * Until this is called the reservation belongs to the dial attempt and {@link
	 * TrunkReservation.release} is the only way to give it back.
	 */
	readonly bindTo: (mediaChannelId: string) => void;
	/** Returns the channel. Idempotent, and a no-op once the reservation has been bound. */
	readonly release: () => void;
}

/** What the plan walker asks before it dials a capped trunk. */
export interface TrunkCapacityPort {
	/**
	 * Reserves one channel on the trunk, or `undefined` when it is already at its ceiling.
	 *
	 * `maxChannels` of `0` or less is "no ceiling configured" and always reserves — the artifact is
	 * data, and a tenant who typed a zero meant "unlimited", not "refuse every call".
	 */
	reserve: (
		organizationId: string,
		trunkId: string,
		maxChannels: number | undefined,
	) => TrunkReservation | undefined;
	/** Returns whatever reservation this leg was holding. Called on every leg end; usually a no-op. */
	releaseLeg: (mediaChannelId: string) => void;
	/** Channels currently held on the trunk. For specs and for an operator-facing count. */
	inUse: (organizationId: string, trunkId: string) => number;
}

/** A reservation that costs nothing: the trunk has no ceiling, so there is nothing to give back. */
const UNCAPPED: TrunkReservation = {
	bindTo: () => undefined,
	release: () => undefined,
};

/** The key a count is held under. Org-scoped, because trunk ids are only unique within one. */
function keyFor(organizationId: string, trunkId: string): string {
	return `${organizationId}/${trunkId}`;
}

/**
 * The in-process implementation. One per engine instance; see the file header for the limitation
 * that follows from that.
 */
export class TrunkCapacityRegistry implements TrunkCapacityPort {
	private readonly counts = new Map<string, number>();
	private readonly holders = new Map<string, string>();

	reserve(
		organizationId: string,
		trunkId: string,
		maxChannels: number | undefined,
	): TrunkReservation | undefined {
		if (maxChannels === undefined || !Number.isFinite(maxChannels) || maxChannels <= 0) {
			return UNCAPPED;
		}

		const key = keyFor(organizationId, trunkId);
		const inUse = this.counts.get(key) ?? 0;
		if (inUse >= maxChannels) {
			return undefined;
		}
		this.counts.set(key, inUse + 1);

		let held = true;
		const give = (): void => {
			if (!held) {
				return;
			}
			held = false;
			const current = this.counts.get(key) ?? 0;
			if (current <= 1) {
				this.counts.delete(key);
				return;
			}
			this.counts.set(key, current - 1);
		};

		return {
			bindTo: (mediaChannelId) => {
				if (!held) {
					return;
				}
				// Recorded rather than counted again: the channel is already spent, and this only
				// says who is now responsible for handing it back.
				this.holders.set(mediaChannelId, key);
				held = false;
			},
			release: give,
		};
	}

	releaseLeg(mediaChannelId: string): void {
		const key = this.holders.get(mediaChannelId);
		if (key === undefined) {
			return;
		}
		this.holders.delete(mediaChannelId);
		const current = this.counts.get(key) ?? 0;
		if (current <= 1) {
			this.counts.delete(key);
			return;
		}
		this.counts.set(key, current - 1);
	}

	inUse(organizationId: string, trunkId: string): number {
		return this.counts.get(keyFor(organizationId, trunkId)) ?? 0;
	}
}
