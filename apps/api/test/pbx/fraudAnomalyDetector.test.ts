import { expect } from "chai";
import { floorToWindow } from "../../src/pbx/shared/shared-rate-window";
import {
	burstFindings,
	FraudAnomalyDetector,
	groupByOrganization,
	highRiskFindings,
	isInternational,
} from "../../src/pbx/toll-fraud/fraud-anomaly-detector.service";
import { SHORT_CALL_SECONDS } from "../../src/pbx/toll-fraud/fraud-cdr.port";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type {
	FraudCdrSource,
	InternationalLegGroup,
} from "../../src/pbx/toll-fraud/fraud-cdr.port";
import type { FraudSignalPublisher } from "../../src/pbx/toll-fraud/fraud-signal.publisher";
import type { TollFraudService } from "../../src/pbx/toll-fraud/toll-fraud.service";
import type { SecurityFraudSignalData } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The backward-looking half of toll-fraud defence, over SYNTHETIC call records.
 *
 * The detector exists because the gate's blind spot is the tenant who has configured no ceilings —
 * which is every tenant on the day they sign up, and most of them forever. What a first
 * implementation can get wrong:
 *
 *  1. **The default threshold.** A tenant's own ceiling has to win when they have one, or the
 *     detector is one a call centre mutes in week two and nobody reads afterwards.
 *  2. **The burst shape.** Many calls to one destination is a busy sales desk; many SHORT calls to
 *     one destination is a dialer. A rule that cannot tell them apart is noise.
 *  3. **Auto-suspension is opt-in.** A false positive at 09:00 on a Monday is a dead phone, and the
 *     detector runs on heuristics.
 *  4. **A CDR-less deployment must not break.** The port is optional and the pass must stand down.
 *
 * Everything here runs through a fake repository, so no database is touched.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORG = "019fd3c2-8888-76be-a6b3-b0f1914e39b6";
const EXTENSION = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

function leg(overrides: Partial<InternationalLegGroup> = {}): InternationalLegGroup {
	return {
		organizationId: ORG,
		fromNumber: "1001",
		toNumber: "+37120000000",
		legs: 1,
		minutes: 1,
		shortLegs: 0,
		...overrides,
	};
}

/** A CDR source that answers with whatever rows the test hands it. */
function fakeCdr(rows: readonly InternationalLegGroup[]): FraudCdrSource & { calls: number } {
	const source = {
		calls: 0,
		internationalCandidates: async () => {
			source.calls += 1;
			return rows;
		},
	};
	return source;
}

/** A toll-fraud service stub: a policy, a home country, and a recorded auto-suspension. */
function fakeTollFraud(options: {
	readonly maxInternationalMinutesPerHour?: number | null;
	readonly autoSuspendOnSignal?: boolean;
	readonly homeCountry?: string;
}) {
	const suspensions: { organizationId: string; extensionId: string; reason: string }[] = [];
	const service = {
		policyFor: async () => ({
			id: "policy",
			organizationId: ORG,
			enabled: true,
			maxConcurrentInternationalCalls: null,
			maxInternationalMinutesPerHour: options.maxInternationalMinutesPerHour ?? null,
			maxInternationalMinutesPerDay: null,
			allowedCountries: null,
			deniedCountries: null,
			holdFirstCallToNewCountry: false,
			offHoursInternationalLock: false,
			offHoursStartMinute: 1_200,
			offHoursEndMinute: 420,
			offHoursTimezone: null,
			autoSuspendOnSignal: options.autoSuspendOnSignal ?? false,
		}),
		homeCountry: async () => options.homeCountry,
		seenCountries: async () => new Set<string>(),
		autoSuspend: async (organizationId: string, extensionId: string, reason: string) => {
			suspensions.push({ organizationId, extensionId, reason });
			return { id: "override" };
		},
	} as unknown as TollFraudService;
	return { service, suspensions };
}

/** A publisher that records what it was asked to raise. */
function fakePublisher() {
	const published: SecurityFraudSignalData[] = [];
	const publisher = {
		publish: async (_organizationId: string, data: SecurityFraudSignalData) => {
			published.push(data);
		},
	} as unknown as FraudSignalPublisher;
	return { publisher, published };
}

/**
 * A database whose tenant-scoped reads answer empty and whose inserts are captured.
 *
 * The detector's own SQL is one `adminDb` group-by for the tenants with auth events and one scoped
 * query per tenant; both answer empty here so the CDR-derived findings are what the test is about.
 */
function fakeDatabase() {
	const inserted: Record<string, unknown>[] = [];
	const scopes: string[] = [];
	const transaction = {
		select: () => ({
			from: () => ({
				where: () => ({
					groupBy: () => ({ having: async () => [] }),
					limit: async () => [{ id: EXTENSION, number: "1001" }],
				}),
				groupBy: async () => [],
			}),
		}),
		insert: () => ({
			values: async (row: Record<string, unknown>) => {
				inserted.push(row);
			},
		}),
	};
	const database = {
		adminDb: {
			select: () => ({ from: () => ({ where: () => ({ groupBy: async () => [] }) }) }),
		},
		withTenantScope: async <T>(organizationId: string, run: (t: never) => Promise<T>) => {
			scopes.push(organizationId);
			return await run(transaction as never);
		},
	} as unknown as PbxDatabaseClient;
	return { database, inserted, scopes };
}

function detectorFor(
	rows: readonly InternationalLegGroup[],
	options: Parameters<typeof fakeTollFraud>[0] = {},
) {
	const cdr = fakeCdr(rows);
	const { service, suspensions } = fakeTollFraud(options);
	const { publisher, published } = fakePublisher();
	const { database, inserted } = fakeDatabase();
	const env = { PBX_FRAUD_DETECTOR_INTERVAL_MS: 0 } as unknown as PbxEnv;
	const detector = new FraudAnomalyDetector(env, database, service, publisher, cdr);
	return { detector, published, suspensions, inserted, cdr };
}

describe("what the detector counts as international", () => {
	it("counts an unresolvable prefix", () => {
		// A global-network or satellite range is the exact shape of a revenue-share number.
		expect(isInternational("+8821234567", "US")).to.equal(true);
	});

	it("counts everything when the tenant has no home country", () => {
		// The fail-closed direction for something that only ever raises alerts.
		expect(isInternational("+12125550100", undefined)).to.equal(true);
	});

	it("does not count the tenant's own country", () => {
		expect(isInternational("+12125550100", "US")).to.equal(false);
	});
});

describe("groupByOrganization", () => {
	it("keeps one tenant's rows out of another's", () => {
		const grouped = groupByOrganization([
			leg(),
			leg({ organizationId: OTHER_ORG }),
			leg({ toNumber: "+441632960111" }),
		]);
		expect(grouped.size).to.equal(2);
		expect(grouped.get(ORG)).to.have.length(2);
		expect(grouped.get(OTHER_ORG)).to.have.length(1);
	});
});

describe("the high-risk prefix heuristic", () => {
	it("flags a global-network destination", () => {
		const findings = highRiskFindings(ORG, [leg({ toNumber: "+8821234567", legs: 2 })]);
		expect(findings).to.have.length(1);
		expect(findings[0]?.kind).to.equal("high-risk-prefix");
		expect(findings[0]?.severity).to.equal("critical");
		expect(findings[0]?.destination).to.equal("+8821234567");
	});

	it("leaves an ordinary international destination alone", () => {
		// The list is a signal, not a block list: every entry on it is a real country somebody has
		// real business with, and Latvia is not on it.
		expect(highRiskFindings(ORG, [leg()])).to.have.length(0);
	});
});

describe("the short-call burst heuristic", () => {
	it("flags many short calls to one destination", () => {
		const findings = burstFindings(ORG, [leg({ legs: 20, shortLegs: 18, minutes: 20 })]);
		expect(findings).to.have.length(1);
		expect(findings[0]?.kind).to.equal("short-call-burst");
		expect(findings[0]?.observed).to.equal(20);
	});

	it("leaves a busy sales desk alone", () => {
		// Twenty long calls to one client is a relationship, not a dialer. The RATIO is what tells
		// them apart, and a rule without it is noise every tenant learns to ignore.
		expect(burstFindings(ORG, [leg({ legs: 20, shortLegs: 2, minutes: 200 })])).to.have.length(0);
	});

	it("leaves a handful of short calls alone", () => {
		expect(burstFindings(ORG, [leg({ legs: 4, shortLegs: 4, minutes: 4 })])).to.have.length(0);
	});

	it("uses the same short-call boundary the CDR side filters on", () => {
		expect(SHORT_CALL_SECONDS).to.equal(20);
	});
});

describe("a detector pass", () => {
	it("raises a minutes spike against the platform floor when the tenant has no ceiling", async () => {
		const { detector, published } = detectorFor(
			[leg({ legs: 40, minutes: 400, toNumber: "+37120000000" })],
			{ homeCountry: "US" },
		);
		const findings = await detector.pass(new Date("2026-09-10T12:00:00Z"));
		expect(findings.map((finding) => finding.kind)).to.include("international-minutes-spike");
		const spike = published.find((one) => one.kind === "international-minutes-spike");
		expect(spike?.observed).to.equal(400);
		expect(spike?.threshold).to.equal(300);
		expect(spike?.severity).to.equal("critical");
		expect(spike?.action).to.equal("none");
	});

	it("prefers the tenant's own ceiling over the platform floor", async () => {
		// A call centre that told the platform it does five hundred minutes an hour is not alerted at
		// three hundred. A detector a tenant has to mute is a detector nobody reads.
		const { detector, published } = detectorFor([leg({ legs: 40, minutes: 400 })], {
			homeCountry: "US",
			maxInternationalMinutesPerHour: 500,
		});
		await detector.pass(new Date("2026-09-10T12:00:00Z"));
		expect(published.filter((one) => one.kind === "international-minutes-spike")).to.have.length(0);
	});

	it("does not suspend unless the tenant asked for it", async () => {
		const { detector, suspensions, published } = detectorFor(
			[leg({ toNumber: "+8821234567", legs: 3, minutes: 3 })],
			{ homeCountry: "US" },
		);
		await detector.pass(new Date("2026-09-10T12:00:00Z"));
		expect(suspensions).to.have.length(0);
		expect(published.every((one) => one.action === "none")).to.equal(true);
	});

	it("suspends when the tenant did", async () => {
		const { detector, suspensions, published } = detectorFor(
			[leg({ toNumber: "+8821234567", legs: 3, minutes: 3 })],
			{ homeCountry: "US", autoSuspendOnSignal: true },
		);
		await detector.pass(new Date("2026-09-10T12:00:00Z"));
		expect(suspensions).to.have.length(1);
		expect(suspensions[0]?.extensionId).to.equal(EXTENSION);
		expect(published.some((one) => one.action === "extension-suspended")).to.equal(true);
	});

	it("writes a ledger row for every signal it raises", async () => {
		// The publish is fire-and-forget by design; the audit row is the durable record, so a signal
		// that published and did not file would leave nothing to answer the question afterwards.
		const { detector, inserted, published } = detectorFor(
			[leg({ toNumber: "+8821234567", legs: 3, minutes: 3 })],
			{ homeCountry: "US" },
		);
		await detector.pass(new Date("2026-09-10T12:00:00Z"));
		expect(inserted.length).to.equal(published.length);
		expect(inserted[0]?.action).to.equal("toll-fraud.signal");
		expect(inserted[0]?.actorType).to.equal("service");
		expect(inserted[0]?.actorRef).to.equal("api.fraud-anomaly-detector");
	});

	it("stands down with no CDR database rather than failing", async () => {
		const { service } = fakeTollFraud({});
		const { publisher, published } = fakePublisher();
		const { database } = fakeDatabase();
		const detector = new FraudAnomalyDetector(
			{ PBX_FRAUD_DETECTOR_INTERVAL_MS: 0 } as unknown as PbxEnv,
			database,
			service,
			publisher,
		);
		expect(await detector.pass(new Date("2026-09-10T12:00:00Z"))).to.deep.equal([]);
		expect(published).to.have.length(0);
	});

	it("refuses a re-entrant pass rather than queueing one", async () => {
		// A pass that overran its interval is a pass whose database is slow, and starting a second
		// one on top of it is how a slow control plane becomes a stopped one.
		const { detector } = detectorFor([leg({ legs: 40, minutes: 400 })], { homeCountry: "US" });
		const [first, second] = await Promise.all([
			detector.pass(new Date("2026-09-10T12:00:00Z")),
			detector.pass(new Date("2026-09-10T12:00:00Z")),
		]);
		expect(first.length + second.length).to.be.greaterThan(0);
		expect(Math.min(first.length, second.length)).to.equal(0);
	});
});

describe("the shared window's boundary arithmetic", () => {
	it("floors against the epoch so every replica agrees without coordinating", () => {
		const window = 3_600_000;
		const start = floorToWindow(new Date("2026-09-10T12:34:56.789Z"), window);
		expect(start.toISOString()).to.equal("2026-09-10T12:00:00.000Z");
		expect(floorToWindow(new Date("2026-09-10T12:00:00.000Z"), window).getTime()).to.equal(
			start.getTime(),
		);
	});

	it("floors a daily window to midnight UTC", () => {
		expect(floorToWindow(new Date("2026-09-10T23:59:59.999Z"), 86_400_000).toISOString()).to.equal(
			"2026-09-10T00:00:00.000Z",
		);
	});
});
