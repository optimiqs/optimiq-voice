import { expect } from "chai";
import { LastCallerRpcController } from "../../src/cdr/query/last-caller-rpc.controller";
import { LastCallerService } from "../../src/cdr/query/last-caller.service";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * `rpc.pbx.v1.last-caller` — the responder behind `*69`.
 *
 * A read of a PARTITIONED ledger answered on the call path, which is what makes the three claims
 * below worth pinning without a database:
 *
 *  1. **The window is a lower bound on `started_at`, and it is not optional.** It is what lets
 *     PostgreSQL prune to the partitions the request names; without it "most recent" is a scan of
 *     every partition that exists.
 *  2. **A withheld caller is `found: true` with no number.** There WAS a call and there is nothing
 *     to dial, which the engine announces differently from "nobody rang you". Passing the stored
 *     word through would place a call to `sip:anonymous@…` that fails where nobody can see it.
 *  3. **Nothing throws.** A ledger that cannot be read answers `found: false` with a reason, because
 *     the caller is connected and a timeout is dead air.
 *
 * The SQL is not asserted here: the query is one predicate over one index and the shape of it is
 * `verify-cdr.ts`'s subject, against a real database. What IS asserted is the bound the predicate is
 * built from, which is a policy rather than a rendering.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";

interface LegRow {
	readonly fromNumber: string;
	readonly fromName: string | null;
	readonly startedAt: Date;
}

interface Captured {
	readonly organizationId: string;
	/** The `gte(startedAt, …)` bound, recovered from the predicate the query was given. */
	readonly since: Date | undefined;
}

/**
 * A database that returns rows and remembers the bounds it was asked for.
 *
 * `withTenantScope` is faked rather than stubbed per-query, on the same terms as the PBX area's
 * specs. The lower bound is recovered by intercepting the `Date` handed to the `where` builder,
 * which is the one part of the predicate that is a decision rather than a rendering.
 */
function fakeDatabase(rows: readonly LegRow[]): {
	database: CdrDatabaseClient;
	captured: Captured[];
	failing: CdrDatabaseClient;
} {
	const captured: Captured[] = [];
	let organizationId = "";

	const transaction = {
		select: () => ({
			from: () => ({
				where: (predicate: unknown) => ({
					orderBy: () => ({
						limit: async () => {
							captured.push({ organizationId, since: dateIn(predicate) });
							return rows;
						},
					}),
				}),
			}),
		}),
	};

	const database = {
		withTenantScope: async <T>(scope: string, work: (tx: never) => Promise<T>): Promise<T> => {
			organizationId = scope;
			return await work(transaction as never);
		},
	} as unknown as CdrDatabaseClient;

	const failing = {
		withTenantScope: async (): Promise<never> => {
			throw new Error("the ledger pool is exhausted");
		},
	} as unknown as CdrDatabaseClient;

	return { database, captured, failing };
}

/**
 * The first `Date` anywhere inside a Drizzle predicate.
 *
 * Walking the built SQL object rather than rendering it: the only value under test is the window's
 * lower bound, and the rendering is `verify-cdr.ts`'s job. One `Date` reaches this query and it is
 * that bound.
 */
function dateIn(value: unknown, depth = 0): Date | undefined {
	if (value instanceof Date) {
		return value;
	}
	if (depth > 12 || typeof value !== "object" || value === null) {
		return undefined;
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		const found = dateIn(child, depth + 1);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

const AT = new Date("2026-08-05T09:00:00.000Z");

describe("LastCallerService", () => {
	it("bounds the query by the requested window, so the ledger's partitions can be pruned", async () => {
		const { database, captured } = fakeDatabase([]);
		const before = Date.now();
		await new LastCallerService(database).lookupForBroker({
			orgId: ORG,
			extensionNumber: "1001",
			withinHours: 24,
		});

		const since = captured[0]?.since;
		expect(since).to.be.instanceOf(Date);
		const hoursBack = (before - (since as Date).getTime()) / 3_600_000;
		expect(hoursBack).to.be.closeTo(24, 0.01);
	});

	it("reads inside the request's own tenant scope, so RLS is the filter", async () => {
		const { database, captured } = fakeDatabase([]);
		await new LastCallerService(database).lookupForBroker({
			orgId: ORG,
			extensionNumber: "1001",
			withinHours: 168,
		});
		expect(captured[0]?.organizationId).to.equal(ORG);
	});

	it("answers found:false for an empty window rather than reaching further back", async () => {
		const { database } = fakeDatabase([]);
		const reply = await new LastCallerService(database).lookupForBroker({
			orgId: ORG,
			extensionNumber: "1001",
			withinHours: 1,
		});

		// A `*69` that dials somebody from three months ago is a wrong number, not a feature.
		expect(reply.found).to.equal(false);
		expect(reply.callerNumber).to.equal(undefined);
		expect(reply.reason).to.contain("inside the window");
	});

	it("returns the caller's number, name and when they rang", async () => {
		const { database } = fakeDatabase([
			{ fromNumber: "+15551234567", fromName: "Ada", startedAt: AT },
		]);
		const reply = await new LastCallerService(database).lookupForBroker({
			orgId: ORG,
			extensionNumber: "1001",
			withinHours: 168,
		});

		expect(reply).to.deep.equal({
			found: true,
			callerNumber: "+15551234567",
			callerName: "Ada",
			at: AT.toISOString(),
		});
	});

	it("reports a WITHHELD caller as found, with nothing to dial", async () => {
		const { database } = fakeDatabase([
			{ fromNumber: "anonymous", fromName: "Anonymous", startedAt: AT },
		]);
		const reply = await new LastCallerService(database).lookupForBroker({
			orgId: ORG,
			extensionNumber: "1001",
			withinHours: 168,
		});

		// Not a miss: there was a call and the switch has nothing to dial, which the engine announces
		// differently. Passing `anonymous` through would place a call to `sip:anonymous@…`.
		expect(reply.found).to.equal(true);
		expect(reply.callerNumber).to.equal(undefined);
		expect(reply.callerName).to.equal("Anonymous");
	});

	it("answers found:false when the ledger cannot be read, rather than throwing", async () => {
		const { failing } = fakeDatabase([]);
		const reply = await new LastCallerService(failing).lookupForBroker({
			orgId: ORG,
			extensionNumber: "1001",
			withinHours: 168,
		});

		expect(reply.found).to.equal(false);
		expect(reply.reason).to.contain("ledger pool is exhausted");
	});
});

describe("LastCallerRpcController", () => {
	it("answers a malformed request instead of letting it time out", async () => {
		const controller = new LastCallerRpcController({
			lookupForBroker: async () => {
				throw new Error("the service must not be reached");
			},
		} as unknown as LastCallerService);

		const reply = await controller.lookup({ orgId: "not-a-uuid" });

		expect(reply.found).to.equal(false);
		expect(reply.reason).to.contain("orgId");
	});

	it("applies the contract's default window when the request omits one", async () => {
		const seen: { withinHours?: number } = {};
		const controller = new LastCallerRpcController({
			lookupForBroker: async (request: { withinHours: number }) => {
				seen.withinHours = request.withinHours;
				return { found: false };
			},
		} as unknown as LastCallerService);

		await controller.lookup({ orgId: ORG, extensionNumber: "1001" });
		expect(seen.withinHours).to.equal(168);
	});
});
