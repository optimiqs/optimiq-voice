import { describe, expect, it } from "bun:test";
import { kvKeyFor } from "@optimiq-voice/events";
import { FakeClaimBucket } from "../nats/claim-store.fake";
import { CLAIM_LEASE_MS } from "./claim-timing";
import { SharedLineRegistry } from "./shared-line-registry";
import type { SharedLineSeizure } from "./shared-line-registry";
import type { SharedLineState } from "@optimiq-voice/events";

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const LINE = "0195c0f0-1c2f-7000-8000-0000000000a1";
const NOW = 1_700_000_000_000;

function seizure(overrides: Partial<SharedLineSeizure> = {}): SharedLineSeizure {
	return {
		extensionId: "ext-1001",
		appearanceIndex: 0,
		callId: "call-1",
		legId: "leg-1",
		...overrides,
	};
}

/** The seizure a bucket holds for the line. Throws rather than short-circuiting, like the park spec. */
function stateAt(bucket: FakeClaimBucket<SharedLineState>): SharedLineState {
	const held = bucket.entries.get(kvKeyFor.sharedLineState(ORG, LINE));
	if (held === undefined) {
		throw new Error("no seizure on the line");
	}
	return held.value as SharedLineState;
}

/**
 * A manual timer seam: a spec fires a recall without waiting real seconds, exactly as
 * `CallControlDependencies.setTimer` lets a spec assert the park timeout.
 */
function manualTimers(): {
	readonly setTimer: (fn: () => void, ms: number) => { readonly cancel: () => void };
	fireAll: () => void;
	readonly scheduled: { fn: () => void; ms: number; cancelled: boolean }[];
} {
	const scheduled: { fn: () => void; ms: number; cancelled: boolean }[] = [];
	return {
		setTimer: (fn, ms) => {
			const entry = { fn, ms, cancelled: false };
			scheduled.push(entry);
			return {
				cancel: () => {
					entry.cancelled = true;
				},
			};
		},
		fireAll: () => {
			for (const entry of scheduled) {
				if (!entry.cancelled) {
					entry.cancelled = true;
					entry.fn();
				}
			}
		},
		scheduled,
	};
}

/** A registry backed by a shared bucket, plus the bucket, plus a clock and timer a spec can drive. */
function shared(
	options: {
		readonly now?: () => number;
		readonly setTimer?: ReturnType<typeof manualTimers>["setTimer"];
	} = {},
): {
	readonly registry: SharedLineRegistry;
	readonly bucket: FakeClaimBucket<SharedLineState>;
} {
	const bucket = new FakeClaimBucket<SharedLineState>();
	const registry = new SharedLineRegistry();
	registry.bindClaims(bucket, "engine-a", options.now ?? (() => NOW), options.setTimer);
	return { registry, bucket };
}

// ---------------------------------------------------------------------------------------------
// The unshared path: exactly what an in-process map would do
// ---------------------------------------------------------------------------------------------

describe("seizing a shared line — single instance", () => {
	it("wins the line and remembers who holds it", async () => {
		const registry = new SharedLineRegistry();
		const result = await registry.seize(ORG, LINE, seizure());
		expect(result.won).toBe(true);
		expect(registry.held(ORG, LINE)?.heldByExtensionId).toBe("ext-1001");
		expect(registry.seizedCount).toBe(1);
	});

	it("reports that claims are not shared, which is a deployment choice and not a fault", () => {
		expect(new SharedLineRegistry().isShared).toBe(false);
	});

	it("holds the line and records when it went on hold", async () => {
		const registry = new SharedLineRegistry();
		registry.bindClaims(
			new FakeClaimBucket<SharedLineState>({ unconfigured: true }),
			"engine-a",
			() => NOW,
		);
		await registry.seize(ORG, LINE, seizure());
		const result = await registry.hold(ORG, LINE);
		expect(result.kind).toBe("held");
		expect(registry.held(ORG, LINE)?.state).toBe("held");
		expect(registry.held(ORG, LINE)?.heldAtMs).toBe(NOW);
	});

	it("frees the line on release and forgets the holder", async () => {
		const registry = new SharedLineRegistry();
		await registry.seize(ORG, LINE, seizure());
		expect(await registry.release(ORG, LINE, "engine-local")).toBe(true);
		expect(registry.held(ORG, LINE)).toBeUndefined();
		expect(registry.seizedCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------------------------
// Shared seizures
// ---------------------------------------------------------------------------------------------

describe("the shared seizure", () => {
	it("writes the line's key, so two instances collide on one key", async () => {
		const { registry, bucket } = shared();
		await registry.seize(ORG, LINE, seizure());
		expect([...bucket.entries.keys()]).toEqual([kvKeyFor.sharedLineState(ORG, LINE)]);
	});

	it("moves to the held state under compare-and-set", async () => {
		const { registry, bucket } = shared();
		await registry.seize(ORG, LINE, seizure());
		const result = await registry.hold(ORG, LINE);
		expect(result.kind).toBe("held");
		expect(stateAt(bucket).state).toBe("held");
		expect(stateAt(bucket).heldAtMs).toBe(NOW);
	});

	it("refuses to hold a line this instance does not seize", async () => {
		const { registry } = shared();
		expect((await registry.hold(ORG, LINE)).kind).toBe("not-held");
	});

	it("deletes the key on release", async () => {
		const { registry, bucket } = shared();
		await registry.seize(ORG, LINE, seizure());
		expect(await registry.release(ORG, LINE, "engine-a")).toBe(true);
		expect(bucket.size).toBe(0);
	});

	it("does not release a line owned by another instance", async () => {
		const { registry, bucket } = shared();
		await registry.seize(ORG, LINE, seizure());
		expect(await registry.release(ORG, LINE, "engine-b")).toBe(false);
		expect(bucket.size).toBe(1);
	});
});

describe("two engine instances on one bucket", () => {
	/** Instance A and instance B sharing one bucket, exactly as two engines behind one media server do. */
	function pair(now: () => number = () => NOW): {
		readonly a: SharedLineRegistry;
		readonly b: SharedLineRegistry;
		readonly bucket: FakeClaimBucket<SharedLineState>;
	} {
		const bucket = new FakeClaimBucket<SharedLineState>();
		const a = new SharedLineRegistry();
		const b = new SharedLineRegistry();
		a.bindClaims(bucket, "engine-a", now);
		b.bindClaims(bucket.peer(), "engine-b", now);
		return { a, b, bucket };
	}

	it("lets the first appearance win and carries the owning instance and lease", async () => {
		const { a, bucket } = pair();
		const result = await a.seize(ORG, LINE, seizure());
		expect(result.won).toBe(true);
		expect(stateAt(bucket).instanceId).toBe("engine-a");
		expect(stateAt(bucket).state).toBe("seized");
		expect(stateAt(bucket).expiresAt).toBe(NOW + CLAIM_LEASE_MS);
	});

	it("makes the SECOND appearance lose and read the holder off the value", async () => {
		const { a, b } = pair();
		expect((await a.seize(ORG, LINE, seizure({ extensionId: "ext-1001" }))).won).toBe(true);

		const lost = await b.seize(ORG, LINE, seizure({ extensionId: "ext-1002", appearanceIndex: 1 }));
		expect(lost.won).toBe(false);
		if (lost.won !== false || lost.heldBy === undefined) {
			throw new Error("expected a lost seizure carrying the holder");
		}
		expect(lost.heldBy.instanceId).toBe("engine-a");
		expect(lost.heldBy.heldByExtensionId).toBe("ext-1001");
		expect(lost.heldBy.heldByAppearanceIndex).toBe(0);
	});
});

describe("stale seizures", () => {
	it("takes over a line whose holder stopped heartbeating", async () => {
		let now = NOW;
		const bucket = new FakeClaimBucket<SharedLineState>();
		const dead = new SharedLineRegistry();
		dead.bindClaims(bucket, "engine-dead", () => now);
		await dead.seize(ORG, LINE, seizure());

		now = NOW + CLAIM_LEASE_MS;
		const live = new SharedLineRegistry();
		live.bindClaims(bucket.peer(), "engine-live", () => now);
		const result = await live.seize(ORG, LINE, seizure({ extensionId: "ext-2002" }));
		expect(result.won).toBe(true);
		expect(stateAt(bucket).instanceId).toBe("engine-live");
		expect(stateAt(bucket).heldByExtensionId).toBe("ext-2002");
	});

	it("does not take over a seizure still within its lease — the loser reads the holder", async () => {
		const bucket = new FakeClaimBucket<SharedLineState>();
		const owner = new SharedLineRegistry();
		owner.bindClaims(bucket, "engine-a", () => NOW);
		await owner.seize(ORG, LINE, seizure());

		const other = new SharedLineRegistry();
		other.bindClaims(bucket.peer(), "engine-b", () => NOW + CLAIM_LEASE_MS - 1);
		const lost = await other.seize(ORG, LINE, seizure({ extensionId: "ext-2002" }));
		expect(lost.won).toBe(false);
		expect(stateAt(bucket).instanceId).toBe("engine-a");
	});
});

describe("the heartbeat", () => {
	it("pushes a held seizure's expiry forward", async () => {
		let now = NOW;
		const bucket = new FakeClaimBucket<SharedLineState>();
		const registry = new SharedLineRegistry();
		registry.bindClaims(bucket, "engine-a", () => now);
		await registry.seize(ORG, LINE, seizure());

		now = NOW + 30_000;
		expect(await registry.heartbeat()).toBe(1);
		expect(stateAt(bucket).expiresAt).toBe(now + CLAIM_LEASE_MS);
	});

	it("drops a seizure another instance took over rather than fighting for it", async () => {
		let now = NOW;
		const bucket = new FakeClaimBucket<SharedLineState>();
		const registry = new SharedLineRegistry();
		registry.bindClaims(bucket, "engine-a", () => now);
		await registry.seize(ORG, LINE, seizure());

		const key = kvKeyFor.sharedLineState(ORG, LINE);
		const stolen = bucket.entries.get(key) as { value: SharedLineState; revision: number };
		await bucket.update(key, { ...stolen.value, instanceId: "engine-b" }, stolen.revision);

		now = NOW + 30_000;
		expect(await registry.heartbeat()).toBe(0);
		expect(registry.held(ORG, LINE)).toBeUndefined();
	});

	it("keeps a seizure it could not renew, because the lease outlives a blip", async () => {
		const bucket = new FakeClaimBucket<SharedLineState>();
		const registry = new SharedLineRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);
		await registry.seize(ORG, LINE, seizure());

		bucket.failing = true;
		expect(await registry.heartbeat()).toBe(0);
		expect(registry.held(ORG, LINE)?.heldByExtensionId).toBe("ext-1001");
	});

	it("does nothing at all when claims are not shared", async () => {
		const registry = new SharedLineRegistry();
		await registry.seize(ORG, LINE, seizure());
		expect(await registry.heartbeat()).toBe(0);
	});
});

describe("the hold-recall timer", () => {
	it("fires the recall after the hold-recall timeout elapses", async () => {
		const timers = manualTimers();
		const { registry } = shared({ setTimer: timers.setTimer });
		await registry.seize(ORG, LINE, seizure());
		await registry.hold(ORG, LINE);

		let recalled = 0;
		registry.armRecall(ORG, LINE, 20_000, () => {
			recalled += 1;
		});
		expect(registry.hasRecallArmed(ORG, LINE)).toBe(true);
		expect(recalled).toBe(0);

		timers.fireAll();
		expect(recalled).toBe(1);
		expect(registry.hasRecallArmed(ORG, LINE)).toBe(false);
	});

	it("does NOT arm when the timeout is zero — that line never recalls", async () => {
		const timers = manualTimers();
		const { registry } = shared({ setTimer: timers.setTimer });
		await registry.seize(ORG, LINE, seizure());
		await registry.hold(ORG, LINE);

		let recalled = 0;
		registry.armRecall(ORG, LINE, 0, () => {
			recalled += 1;
		});
		expect(registry.hasRecallArmed(ORG, LINE)).toBe(false);
		expect(timers.scheduled).toHaveLength(0);
		timers.fireAll();
		expect(recalled).toBe(0);
	});

	it("cancels an armed recall, so a collected call does not ring back", async () => {
		const timers = manualTimers();
		const { registry } = shared({ setTimer: timers.setTimer });
		await registry.seize(ORG, LINE, seizure());
		await registry.hold(ORG, LINE);

		let recalled = 0;
		registry.armRecall(ORG, LINE, 20_000, () => {
			recalled += 1;
		});
		registry.cancelRecall(ORG, LINE);
		expect(registry.hasRecallArmed(ORG, LINE)).toBe(false);
		timers.fireAll();
		expect(recalled).toBe(0);
	});

	it("cancels an armed recall when the line is released", async () => {
		const timers = manualTimers();
		const { registry } = shared({ setTimer: timers.setTimer });
		await registry.seize(ORG, LINE, seizure());
		await registry.hold(ORG, LINE);
		registry.armRecall(ORG, LINE, 20_000, () => undefined);

		await registry.release(ORG, LINE, "engine-a");
		expect(registry.hasRecallArmed(ORG, LINE)).toBe(false);
	});
});

/**
 * The degradation decision, asserted rather than documented: a bucket that is CONFIGURED and
 * unreachable refuses the seizure. Falling back to a local claim would be the split-brain the bucket
 * exists to prevent.
 */
describe("when a configured bucket cannot be reached", () => {
	it("refuses the seizure loudly rather than seizing on a local claim", async () => {
		const bucket = new FakeClaimBucket<SharedLineState>({ failing: true });
		const registry = new SharedLineRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);

		const result = await registry.seize(ORG, LINE, seizure());
		expect(result.won).toBe(false);
		expect(result.won === false && "reason" in result && result.reason).toContain("failing");
		expect(registry.seizedCount).toBe(0);
	});

	it("refuses a seizure whose ids cannot form a key, rather than seizing unclaimed", async () => {
		const bucket = new FakeClaimBucket<SharedLineState>();
		const registry = new SharedLineRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);
		const result = await registry.seize(ORG, "line.with.dots", seizure());
		expect(result.won).toBe(false);
	});
});
