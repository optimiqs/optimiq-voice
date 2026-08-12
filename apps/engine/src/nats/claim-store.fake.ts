import type { ClaimBucket, ClaimRead, ClaimWrite } from "./claim-store";

/**
 * An in-memory {@link ClaimBucket} with real revisions, so a registry's compare-and-set runs with
 * no NATS.
 *
 * Test scaffolding, not product code: excluded from `tsconfig.build.json` by the `*.fake.ts`
 * pattern, exactly as `media-port.fake.ts` and `queue-services.fake.ts` are.
 *
 * The revisions are REAL, not a counter that always agrees. That is the whole point of the fake: a
 * registry whose `update` succeeded regardless of the revision it quoted would pass every spec here
 * and lose every race in production, and the failure would be two callers in one orbit — the exact
 * thing the compare-and-set exists to prevent. So `create` refuses an occupied key and `update`
 * refuses a stale revision, in memory, deterministically.
 *
 * ## Simulating the two failures that matter
 *
 * - `failing` makes every operation report `unavailable`, which is how a spec asserts the
 *   degradation policy — configured-but-down must REFUSE, not silently degrade to local claims.
 * - Two fakes sharing one {@link FakeClaimBucket.entries} map are two engine instances sharing one
 *   bucket, which is how a spec asserts that the second one loses.
 */
export interface FakeClaimEntry {
	value: unknown;
	revision: number;
}

/** The bucket's shared sequence. Two instances writing one bucket see ONE revision space. */
export interface FakeClaimSequence {
	next: number;
}

export interface FakeClaimBucketOptions {
	/** Shared with another fake to simulate a second engine instance on the same bucket. */
	readonly entries?: Map<string, FakeClaimEntry>;
	/** Shared alongside `entries`, so a peer's write invalidates this one's revision. */
	readonly sequence?: FakeClaimSequence;
	/** Every operation reports `unavailable`. A configured bucket whose broker is gone. */
	readonly failing?: boolean;
	/** Reports `isConfigured: false`: the single-instance deployment, by choice. */
	readonly unconfigured?: boolean;
}

export class FakeClaimBucket<T> implements ClaimBucket<T> {
	readonly entries: Map<string, FakeClaimEntry>;
	/** Every operation, in order. The assertion most specs want is the SEQUENCE, not the count. */
	readonly calls: { method: string; key: string }[] = [];
	failing: boolean;

	private readonly configured: boolean;
	private readonly sequence: FakeClaimSequence;

	constructor(options: FakeClaimBucketOptions = {}) {
		this.entries = options.entries ?? new Map<string, FakeClaimEntry>();
		this.sequence = options.sequence ?? { next: 1 };
		this.failing = options.failing === true;
		this.configured = options.unconfigured !== true;
	}

	get isConfigured(): boolean {
		return this.configured;
	}

	/** Claims currently held, whichever instance holds them. Read by specs. */
	get size(): number {
		return this.entries.size;
	}

	async get(key: string): Promise<ClaimRead<T>> {
		this.calls.push({ method: "get", key });
		if (this.failing) {
			return { kind: "unavailable", reason: "the fake bucket is failing" };
		}
		const entry = this.entries.get(key);
		return entry === undefined
			? { kind: "absent" }
			: { kind: "present", claim: { value: entry.value as T, revision: entry.revision } };
	}

	async create(key: string, value: T): Promise<ClaimWrite<T>> {
		this.calls.push({ method: "create", key });
		if (this.failing) {
			return { kind: "unavailable", reason: "the fake bucket is failing" };
		}
		const existing = this.entries.get(key);
		if (existing !== undefined) {
			return { kind: "lost", current: { value: existing.value as T, revision: existing.revision } };
		}
		const revision = this.sequence.next++;
		this.entries.set(key, { value, revision });
		return { kind: "written", revision };
	}

	async update(key: string, value: T, revision: number): Promise<ClaimWrite<T>> {
		this.calls.push({ method: "update", key });
		if (this.failing) {
			return { kind: "unavailable", reason: "the fake bucket is failing" };
		}
		const existing = this.entries.get(key);
		if (existing === undefined || existing.revision !== revision) {
			return existing === undefined
				? { kind: "lost" }
				: { kind: "lost", current: { value: existing.value as T, revision: existing.revision } };
		}
		const next = this.sequence.next++;
		this.entries.set(key, { value, revision: next });
		return { kind: "written", revision: next };
	}

	async release(key: string, revision: number): Promise<boolean> {
		this.calls.push({ method: "release", key });
		if (this.failing) {
			return false;
		}
		const existing = this.entries.get(key);
		if (existing === undefined || existing.revision !== revision) {
			return false;
		}
		return this.entries.delete(key);
	}

	/** A second engine instance on the same bucket: same entries, same revision space. */
	peer(): FakeClaimBucket<T> {
		return new FakeClaimBucket<T>({ entries: this.entries, sequence: this.sequence });
	}
}
