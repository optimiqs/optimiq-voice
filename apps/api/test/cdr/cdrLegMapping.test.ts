import { expect } from "chai";
import { CALL_DESTINATION_TYPES } from "@optimiq-voice/cdr-db";
import { CdrLegMappingError, mapCdrLegWrite } from "../../src/cdr/writer/cdr-leg-mapping";

/**
 * The seam between a LOOSE event contract and a CHECKED reporting schema.
 *
 * `packages/events` deliberately types `destinationType`, `hangupCause` and `disposition` as
 * constrained strings so a new PBX feature does not need an events release, and `cdr-db` enforces
 * closed value sets with `check` constraints. Everything this file asserts is a case where the two
 * disagree — which is to say, every case where an untested mapper would produce a `23514` inside
 * the consume loop instead of a row.
 */

const ORG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const LEG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const CALL = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d";
const QUEUE = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6a";
const AGENT = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6b";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: LEG,
		callId: CALL,
		leg: "a",
		direction: "inbound",
		fromNumber: "+12125550100",
		toNumber: "1001",
		destinationType: "extension",
		startedAt: "2026-08-05T10:00:00.000Z",
		answeredAt: "2026-08-05T10:00:04.000Z",
		endedAt: "2026-08-05T10:01:00.000Z",
		durationMs: 60_000,
		billsecMs: 56_000,
		hangupCause: "NORMAL_CLEARING",
		hangupCauseCode: 16,
		hangupSide: "caller",
		disposition: "answered",
		...overrides,
	};
}

describe("cdr.leg.write → call_legs", () => {
	it("maps a well-formed leg without coercing anything", () => {
		const result = mapCdrLegWrite(ORG, payload());

		expect(result.coercions).to.have.length(0);
		expect(result.values.id).to.equal(LEG);
		expect(result.values.organizationId).to.equal(ORG);
		expect(result.values.destinationType).to.equal("extension");
		expect(result.values.startedAt.toISOString()).to.equal("2026-08-05T10:00:00.000Z");
		expect(result.values.billsecMs).to.equal(56_000);
	});

	it("takes the organization from the caller, never from the payload", () => {
		// The event contract keeps `organizationId` out of the payload on purpose. A producer that
		// smuggled one in must not be able to steer the write.
		const result = mapCdrLegWrite(ORG, payload({ organizationId: "not-this-org" }));

		expect(result.values.organizationId).to.equal(ORG);
		expect(result.values.raw.organizationId).to.equal("not-this-org");
	});

	it("translates the routing plan's kebab vocabulary into the reporting column's", () => {
		const cases: readonly [string, string][] = [
			["ring-group", "ring_group"],
			["ivr-menu", "ivr"],
			["time-condition", "time_condition"],
			["trunk-dial", "trunk"],
		];
		for (const [received, stored] of cases) {
			const result = mapCdrLegWrite(ORG, payload({ destinationType: received }));
			expect(result.values.destinationType, received).to.equal(stored);
			expect(result.coercions.map((entry) => entry.field)).to.include("destinationType");
		}
	});

	/**
	 * A paged leg is attributed, not filed under `unknown`.
	 *
	 * Both spellings arrive in practice — `paging` is the plan-node kind the engine copies out of the
	 * walk, `paging-group` is the `pbx-db` destination type on a row that routed into an announcement
	 * — and a page produces one leg per member, so getting this wrong would not lose a row here and
	 * there: it would make `unknown` the second-largest destination in the reports.
	 */
	it("attributes a page to the group rather than filing it under unknown", () => {
		for (const received of ["paging", "paging-group"]) {
			const result = mapCdrLegWrite(ORG, payload({ destinationType: received }));
			expect(result.values.destinationType, received).to.equal("paging");
		}
	});

	it("maps plan steps that are not destinations to unknown", () => {
		for (const step of ["playback", "feature-code", "hangup"]) {
			const result = mapCdrLegWrite(ORG, payload({ destinationType: step }));
			expect(result.values.destinationType, step).to.equal("unknown");
		}
	});

	it("never produces a destination type the column would refuse", () => {
		for (const received of ["ring-group", "ivr-menu", "who-knows", "", "playback"]) {
			const result = mapCdrLegWrite(ORG, payload({ destinationType: received }));
			expect(CALL_DESTINATION_TYPES as readonly string[]).to.include(result.values.destinationType);
		}
	});

	it("keeps a carrier cause we do not name as its numeric code", () => {
		const result = mapCdrLegWrite(
			ORG,
			payload({ hangupCause: "CARRIER_SPECIFIC_THING", hangupCauseCode: 811 }),
		);

		expect(result.values.hangupCause).to.equal("NORMAL_UNSPECIFIED");
		expect(result.values.hangupCauseCode).to.equal(811);
		expect(result.coercions.map((entry) => entry.field)).to.include("hangupCause");
	});

	it("falls back to failed rather than answered for an unreadable disposition", () => {
		const result = mapCdrLegWrite(ORG, payload({ disposition: "maybe" }));

		// Under-reporting revenue is a support ticket; over-reporting it is fraud.
		expect(result.values.disposition).to.equal("failed");
	});

	it("keeps a non-UUID destination ref in raw instead of discarding it", () => {
		const result = mapCdrLegWrite(
			ORG,
			payload({ destinationType: "external", destinationRef: "+441134960000" }),
		);

		expect(result.values.destinationRef).to.equal(null);
		expect(result.values.raw.destinationRefRaw).to.equal("+441134960000");
	});

	/**
	 * `queueRef` used to be this test's example of an unmapped key, and it is now a column — which is
	 * the whole point of the behaviour: a producer running ahead of the schema has its extra fields
	 * kept rather than dropped, and the day the column arrives they move without a backfill. The
	 * example moved to `ivrRef`, which is the next column in `call_legs` waiting for a writer.
	 */
	it("passes unknown payload keys through to raw", () => {
		const result = mapCdrLegWrite(ORG, payload({ ivrRef: "ivr-1", sipDisposition: "200 OK" }));

		expect(result.values.raw.ivrRef).to.equal("ivr-1");
		expect(result.values.raw.sipDisposition).to.equal("200 OK");
	});

	it("records every coercion inside raw so the row is self-diagnosing", () => {
		const result = mapCdrLegWrite(ORG, payload({ disposition: "maybe", hangupCause: "WEIRD" }));
		const writer = result.values.raw._writer as { coercions: { field: string }[] };

		expect(writer.coercions.map((entry) => entry.field)).to.have.members([
			"hangupCause",
			"disposition",
		]);
	});

	it("clamps negative and non-numeric durations to zero", () => {
		const result = mapCdrLegWrite(ORG, payload({ durationMs: -5, billsecMs: "56000" }));

		expect(result.values.durationMs).to.equal(0);
		expect(result.values.billsecMs).to.equal(0);
	});

	it("refuses a payload with no usable id", () => {
		expect(() => mapCdrLegWrite(ORG, payload({ id: "not-a-uuid" }))).to.throw(CdrLegMappingError);
	});

	it("refuses a payload with no usable partition key", () => {
		// `started_at` is the partition key and cannot be defaulted: a guessed month is a row in the
		// wrong partition, which retention would then drop at the wrong time.
		expect(() => mapCdrLegWrite(ORG, payload({ startedAt: "yesterday" }))).to.throw(
			CdrLegMappingError,
		);
	});

	it("treats a missing endedAt as an open leg rather than as zero", () => {
		const result = mapCdrLegWrite(ORG, payload({ endedAt: null }));

		expect(result.values.endedAt).to.equal(null);
	});
});

/**
 * The queue verdict.
 *
 * All four columns or none. Half a verdict in a service level is worse than none: a wait with no
 * outcome is counted by an average and by nothing else, which is the shape of a number that is
 * quietly wrong for a quarter before anybody notices.
 */
describe("the queue leg", () => {
	function queued(overrides: Record<string, unknown> = {}) {
		return mapCdrLegWrite(ORG, {
			...payload(),
			queueRef: QUEUE,
			queueOutcome: "answered",
			queueWaitMs: 12_000,
			queueAgentRef: AGENT,
			...overrides,
		}).values;
	}

	it("maps a served queue call", () => {
		const values = queued();
		expect(values.queueRef).to.equal(QUEUE);
		expect(values.queueOutcome).to.equal("answered");
		expect(values.queueWaitMs).to.equal(12_000);
		expect(values.queueAgentRef).to.equal(AGENT);
	});

	it("leaves every column null on a leg that never touched a queue", () => {
		const values = mapCdrLegWrite(ORG, payload()).values;
		expect(values.queueRef).to.equal(null);
		expect(values.queueOutcome).to.equal(null);
		expect(values.queueWaitMs).to.equal(null);
		expect(values.queueAgentRef).to.equal(null);
	});

	it("drops the whole verdict when the outcome is missing, rather than storing half of it", () => {
		const values = queued({ queueOutcome: undefined });
		expect(values.queueRef).to.equal(null);
		expect(values.queueWaitMs).to.equal(null);
	});

	it("drops the whole verdict when the queue is missing", () => {
		const values = queued({ queueRef: undefined });
		expect(values.queueOutcome).to.equal(null);
	});

	/** An agent id beside an abandonment would make "who took this call" answerable for nobody. */
	it("refuses an agent on any outcome but an answer", () => {
		const values = queued({ queueOutcome: "caller-hangup" });
		expect(values.queueOutcome).to.equal("caller-hangup");
		expect(values.queueAgentRef).to.equal(null);
	});

	it("records a coercion for an outcome nobody has taught it, and keeps the row", () => {
		const mapped = mapCdrLegWrite(ORG, {
			...payload(),
			queueRef: QUEUE,
			queueOutcome: "eaten-by-a-bear",
		});
		expect(mapped.values.queueOutcome).to.equal(null);
		expect(mapped.coercions.map((entry) => entry.field)).to.include("queueOutcome");
	});
});
