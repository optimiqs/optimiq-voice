import { expect } from "chai";
import {
	affectsQueueMembership,
	affectsSipAcl,
	affectsTrunkDirectory,
	backoffMs,
	isDue,
	payloadOf,
	projectionsOwedBy,
} from "../../src/pbx/shared/projection-outbox";

/**
 * The pure half of the projection outbox: what a write owes, and when a failed obligation may be
 * tried again.
 *
 * These four functions are where the outbox can be wrong in a way no integration test would
 * notice, because a wrong answer here fails SILENTLY in the safe-looking direction — an obligation
 * that was never recorded looks exactly like one that was recorded and discharged. The round trip
 * through PostgreSQL and NATS is `verify-pbx.ts`'s job (§13, the kill-window simulation).
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";

describe("projectionsOwedBy", () => {
	/**
	 * The predicate has to be the SAME one `pbx.module.ts` uses to decide whether to publish. If it
	 * were looser, every unchanged recompile would enqueue an obligation the fast path deliberately
	 * never discharges, and the sweeper would republish identical artifacts forever.
	 */
	it("owes nothing when the recompile produced the same snapshot hash", () => {
		expect(projectionsOwedBy("ivr_menu", false)).to.deep.equal([]);
	});

	it("owes the artifact and the DID index together, because the index rides on the artifact", () => {
		expect(projectionsOwedBy("ivr_menu", true)).to.deep.equal(["routing-cache", "did-index"]);
	});

	/**
	 * `queue_agent` is deliberately NOT a routing input — logging an agent in must not evict a
	 * tenant's compiled artifact — so it never recompiles and would owe nothing at all if the roster
	 * did not hang off its own predicate. That is the exact case the separate `onMutation` seam
	 * exists for, and the exact case an outbox keyed only off the artifact would lose.
	 */
	it("owes the roster for a table that changes membership without recompiling", () => {
		expect(projectionsOwedBy("queue_agent", false)).to.deep.equal(["queue-membership"]);
		expect(projectionsOwedBy("queue_tier", false)).to.deep.equal(["queue-membership"]);
	});

	/** `extension` and `queue` are both: they recompile AND they move a roster. */
	it("owes all three for a table that is both a routing input and a roster input", () => {
		expect(projectionsOwedBy("extension", true)).to.deep.equal([
			"routing-cache",
			"did-index",
			"queue-membership",
		]);
	});

	it("keeps the roster tables in one place for the repository and the publisher", () => {
		expect(affectsQueueMembership("extension")).to.equal(true);
		expect(affectsQueueMembership("voicemail_message")).to.equal(false);
	});

	/**
	 * `sip_acl_entry` is absent from `ROUTING_TABLE_TO_ENTITY`, so it never recompiles and
	 * `onArtifactCompiled` never fires for it. Without its own predicate here it would owe NOTHING,
	 * which is the failure this asserts against: a write to the toll-fraud boundary that the fast
	 * path published and the sweeper could never republish if that publish were lost.
	 */
	it("owes the ACL for the one table whose only hook is the mutation seam", () => {
		expect(projectionsOwedBy("sip_acl_entry", false)).to.deep.equal(["sip-acl"]);
	});

	/**
	 * A `trunk` write owes THREE, and the overlap is deliberate rather than double counting.
	 * `affectsRouting("trunk")` is true because an outbound route's failover list names trunks,
	 * while the `trunks` bucket carries the carrier's DIALABLE address — two different facts derived
	 * from one row, published to two buckets with two different readers.
	 *
	 * The directory rides on the table and not on `artifactChanged`, which is what stops a renamed
	 * `sip_proxy` from waiting for a recompile that happened not to move the snapshot hash. The
	 * second assertion is that case: nothing the compiler reads changed, and the edge is still owed.
	 */
	it("owes the carrier directory off the table, not off the artifact", () => {
		expect(projectionsOwedBy("trunk", true)).to.deep.equal([
			"routing-cache",
			"did-index",
			"trunks",
		]);
		expect(projectionsOwedBy("trunk", false)).to.deep.equal(["trunks"]);
	});

	/**
	 * The status write-back is the one `trunk` writer that must NOT produce an obligation, and it
	 * does not — because it bypasses the repository entirely and so never reaches `announce()`.
	 * There is nothing to assert about it here; the assertion is in the shape of the seam, and the
	 * argument is in `trunk-directory.publisher.ts`. What IS assertable is that the two new tables
	 * live in one place, as the roster's do.
	 */
	it("keeps the edge tables in one place for the repository and the publishers", () => {
		expect(affectsTrunkDirectory("trunk")).to.equal(true);
		expect(affectsTrunkDirectory("outbound_route")).to.equal(false);
		expect(affectsSipAcl("sip_acl_entry")).to.equal(true);
		expect(affectsSipAcl("sip_auth_event")).to.equal(false);
	});
});

describe("payloadOf", () => {
	/**
	 * Diagnostics only. Nothing reads this to perform a publish — the sweeper re-derives from the
	 * database — so what it must carry is whatever an operator staring at a stuck row needs to find
	 * the request that made it.
	 */
	it("carries the table, the kind and the operation and nothing else", () => {
		expect(
			payloadOf({
				organizationId: ORG,
				tableName: "queue_tier",
				kind: "queue-tier",
				operation: "create",
			}),
		).to.deep.equal({ tableName: "queue_tier", kind: "queue-tier", operation: "create" });
	});
});

describe("backoffMs", () => {
	/** A group that has never been tried is due now; there is nothing to back off from. */
	it("does not delay a first attempt", () => {
		expect(backoffMs(0, 15_000, 300_000)).to.equal(0);
	});

	it("doubles from the sweep interval and stops at the cap", () => {
		expect(backoffMs(1, 15_000, 300_000)).to.equal(15_000);
		expect(backoffMs(2, 15_000, 300_000)).to.equal(30_000);
		expect(backoffMs(5, 15_000, 300_000)).to.equal(240_000);
		// A broker that is gone for a day must cost one attempt per cap, not 2^n milliseconds of
		// arithmetic that overflows into never retrying at all.
		expect(backoffMs(6, 15_000, 300_000)).to.equal(300_000);
		expect(backoffMs(500, 15_000, 300_000)).to.equal(300_000);
	});
});

describe("isDue", () => {
	const now = new Date("2026-08-06T09:00:00.000Z");

	it("is due when nothing has been tried yet", () => {
		expect(isDue({ attempts: 0, lastAttemptAt: null }, now, 15_000, 300_000)).to.equal(true);
	});

	it("waits out the backoff after a failure and then retries", () => {
		const tenSecondsAgo = new Date(now.getTime() - 10_000);
		expect(isDue({ attempts: 1, lastAttemptAt: tenSecondsAgo }, now, 15_000, 300_000)).to.equal(
			false,
		);
		const twentySecondsAgo = new Date(now.getTime() - 20_000);
		expect(isDue({ attempts: 1, lastAttemptAt: twentySecondsAgo }, now, 15_000, 300_000)).to.equal(
			true,
		);
	});

	/**
	 * A row past the stuck threshold is still retried — it is reported loudly, not abandoned. The
	 * alternative would be an obligation the system has decided to forget, which is precisely the
	 * outcome the table exists to make impossible.
	 */
	it("keeps retrying a stuck group once its capped backoff has elapsed", () => {
		const sixMinutesAgo = new Date(now.getTime() - 360_000);
		expect(isDue({ attempts: 99, lastAttemptAt: sixMinutesAgo }, now, 15_000, 300_000)).to.equal(
			true,
		);
	});
});
