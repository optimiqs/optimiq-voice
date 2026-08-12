import { getLogger } from "@optimiq-voice/logging";
import type { KV } from "nats";
import type { ZodType } from "zod";

/**
 * Compare-and-set claims over a JetStream KV bucket.
 *
 * ## What a claim is for, and why `put` is never enough
 *
 * The engine has two resources that must be exclusive ACROSS PROCESSES rather than within one: an
 * orbit slot and a conference room's bridge id. Both were in-process maps, and both had the same
 * quiet failure — a second engine instance behind the same media server hands out orbit 401 twice,
 * or creates a second bridge for room 3001 and splits it in half.
 *
 * A `put` cannot fix either, because `put` always wins. The operation this needs is the one that can
 * LOSE: `create`, which fails when the key already exists, and `update`, which fails when somebody
 * has written since the revision you read. A lost write here is not an error — it is the answer.
 * The other instance owns the thing, and the caller's job is to accept that rather than retry.
 *
 * ## Three outcomes, and the middle one is the interesting one
 *
 * Every write returns `written`, `lost` or `unavailable`, and conflating any two of them produces a
 * specific bug:
 *
 * - `written` / `lost` conflated → two calls in one orbit.
 * - `lost` / `unavailable` conflated → a broker hiccup reads as "somebody else has it", so a park
 *   is refused for a slot that is free, forever, until the broker comes back.
 * - `unavailable` treated as `written` → the split-brain this class exists to prevent, occurring
 *   precisely during the incident when nobody is looking at park lots.
 *
 * `lost` carries the CURRENT value when it could be read, because the loser almost always needs it:
 * a conference joiner that loses the create needs the winner's bridge id to join the right room.
 *
 * ## Degradation policy
 *
 * A bucket that is NOT CONFIGURED (`undefined`) is a deployment saying "single instance, no shared
 * claims" — the registries then behave exactly as they did before this existed. A bucket that IS
 * configured but unreachable returns `unavailable`, and the registries REFUSE the operation loudly.
 * That asymmetry is deliberate and is the whole degradation decision: not-configured is a choice,
 * configured-and-down is an outage, and silently degrading an outage into a split brain means the
 * damage is discovered days later from a customer describing a conference where nobody could hear
 * anybody.
 */

/** A value read from the bucket, with the revision a later compare-and-set must quote. */
export interface Claimed<T> {
	readonly value: T;
	/** The KV sequence. `update` at this revision succeeds only if nothing has written since. */
	readonly revision: number;
}

/** A claim read that keeps absence distinct from an unreadable or unreachable bucket. */
export type ClaimRead<T> =
	| { readonly kind: "present"; readonly claim: Claimed<T> }
	| { readonly kind: "absent" }
	| { readonly kind: "unavailable"; readonly reason: string };

/**
 * The result of a write.
 *
 * - `written` — this process now owns the key at `revision`.
 * - `lost` — somebody else got there first (`create`) or wrote in between (`update`). `current` is
 *   their value when it could be read back; its absence means the key changed again while we looked,
 *   which the caller must treat as "lost" rather than "free".
 * - `unavailable` — the bucket could not be reached. NOT a loss: nothing is known about the key.
 */
export type ClaimWrite<T> =
	| { readonly kind: "written"; readonly revision: number }
	| { readonly kind: "lost"; readonly current?: Claimed<T> }
	| { readonly kind: "unavailable"; readonly reason: string };

/** The narrow surface a registry needs. One instance per bucket, per value type. */
export interface ClaimBucket<T> {
	/** Whether shared claims are configured at all. `false` means local-only, by deployment choice. */
	readonly isConfigured: boolean;
	/** Reads the current value without conflating a free key with an unavailable bucket. */
	get(key: string): Promise<ClaimRead<T>>;
	/** Takes the key if nobody holds it. THE exclusivity primitive. */
	create(key: string, value: T): Promise<ClaimWrite<T>>;
	/** Replaces a value this process read at `revision`. Loses if anybody wrote in between. */
	update(key: string, value: T, revision: number): Promise<ClaimWrite<T>>;
	/** Releases the key only if it is still at `revision`. Returns whether the bucket confirmed it. */
	release(key: string, revision: number): Promise<boolean>;
}

/**
 * A bucket that is not configured.
 *
 * Every write reports `written` with revision 0 and every read reports `undefined`, so a registry
 * built on it behaves exactly as the in-memory one always did. It is a real object rather than an
 * `undefined` check at each call site because "no shared claims" is a supported deployment, not an
 * error path, and a registry riddled with `if (bucket === undefined)` would grow a second,
 * untested code path for the configuration most people run.
 */
export class UnclaimedBucket<T> implements ClaimBucket<T> {
	readonly isConfigured = false;

	async get(_key: string): Promise<ClaimRead<T>> {
		return { kind: "absent" };
	}

	async create(_key: string, _value: T): Promise<ClaimWrite<T>> {
		return { kind: "written", revision: 0 };
	}

	async update(_key: string, _value: T, _revision: number): Promise<ClaimWrite<T>> {
		return { kind: "written", revision: 0 };
	}

	async release(_key: string, _revision: number): Promise<boolean> {
		return true;
	}
}

/**
 * The JetStream KV implementation.
 *
 * The schema is supplied rather than assumed: a claim written by a newer release of another
 * instance must be readable by this one. A value that does not parse is unavailable, not absent:
 * treating bytes already stored under an exclusive key as free would allow a second owner.
 */
export class KvClaimBucket<T> implements ClaimBucket<T> {
	readonly isConfigured = true;
	private readonly logger = getLogger("engine.claims");

	constructor(
		private readonly kv: KV,
		private readonly schema: ZodType<T>,
		private readonly bucketName: string,
	) {}

	async get(key: string): Promise<ClaimRead<T>> {
		try {
			const entry = await this.kv.get(key);
			if (entry === null || entry.value.length === 0) {
				return { kind: "absent" };
			}
			const value = this.schema.parse(JSON.parse(new TextDecoder().decode(entry.value)));
			return { kind: "present", claim: { value, revision: entry.revision } };
		} catch (error) {
			this.logger.warn(
				{ bucket: this.bucketName, key, err: String(error) },
				"a claim could not be read; treating the key as unavailable",
			);
			return { kind: "unavailable", reason: String(error) };
		}
	}

	async create(key: string, value: T): Promise<ClaimWrite<T>> {
		try {
			const revision = await this.kv.create(key, encode(value));
			return { kind: "written", revision };
		} catch (error) {
			if (!isConflict(error)) {
				return { kind: "unavailable", reason: String(error) };
			}
			const current = await this.get(key);
			if (current.kind === "unavailable") {
				return current;
			}
			return current.kind === "present"
				? { kind: "lost", current: current.claim }
				: { kind: "lost" };
		}
	}

	async update(key: string, value: T, revision: number): Promise<ClaimWrite<T>> {
		try {
			const next = await this.kv.update(key, encode(value), revision);
			return { kind: "written", revision: next };
		} catch (error) {
			if (!isConflict(error)) {
				return { kind: "unavailable", reason: String(error) };
			}
			const current = await this.get(key);
			if (current.kind === "unavailable") {
				return current;
			}
			return current.kind === "present"
				? { kind: "lost", current: current.claim }
				: { kind: "lost" };
		}
	}

	async release(key: string, revision: number): Promise<boolean> {
		try {
			await this.kv.delete(key, { previousSeq: revision });
			return true;
		} catch (error) {
			if (isConflict(error)) {
				return false;
			}
			// A claim that could not be deleted is not a lost call — it is a slot that will be reaped
			// when its expiry passes, which is exactly what the expiry is for.
			this.logger.warn(
				{ bucket: this.bucketName, key, err: String(error) },
				"a claim could not be released; it will be reaped at its expiry",
			);
			return false;
		}
	}
}

function encode(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Whether a KV error means "somebody else wrote", as opposed to "the broker is not there".
 *
 * The distinction is load-bearing (see the class note) and the server expresses it through
 * `api_error.err_code` 10071 — "wrong last sequence" — which is what both `create` on an occupied
 * key and `update` at a stale revision produce. The message forms are matched as well because the
 * client library has surfaced this as a plain `Error` in more than one release, and a missed match
 * would turn a lost race into a reported outage.
 */
export function isConflict(error: unknown): boolean {
	const candidate = error as
		| { readonly api_error?: { readonly err_code?: number }; readonly message?: string }
		| undefined;
	if (candidate?.api_error?.err_code === 10071) {
		return true;
	}
	const message = (candidate?.message ?? String(error)).toLowerCase();
	return (
		message.includes("wrong last sequence") ||
		message.includes("key exists") ||
		message.includes("already exists")
	);
}
