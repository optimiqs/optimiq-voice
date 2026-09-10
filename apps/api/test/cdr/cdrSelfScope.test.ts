import { expect } from "chai";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { callLegs } from "@optimiq-voice/cdr-db";
import { hasAnyParty, ownPartyFilter, ownPartyMatcher } from "../../src/cdr/query/cdr-self-scope";
import {
	cdrCallQuerySchema,
	cdrLegQuerySchema,
	cdrListQuerySchema,
} from "../../src/cdr/query/cdr.dto";
import { CdrService } from "../../src/cdr/query/cdr.service";
import type { OwnedParties } from "../../src/cdr/query/cdr-self-scope";
import type { CallLegListRow } from "../../src/cdr/query/cdr.repository";
import type { CdrSelfParties } from "../../src/cdr/query/self-parties";
import type { AppSession, Permission } from "@optimiq-voice/auth";
import type { CdrDatabaseClient, CdrDatabaseTransaction, SQL } from "@optimiq-voice/cdr-db";

/**
 * `cdr.read.own` — the narrowing, in the three states that matter: the unscoped holder who sees the
 * whole tenant, the scoped holder who sees their own calls, and the scoped holder asking for
 * somebody else's.
 *
 * Two layers, the split this area already uses (`queueStats.test.ts`): the predicate as SQL TEXT,
 * rendered by a real Drizzle builder over the real schema so the assertion is about what Postgres
 * would see; and the service's DECISION, driven against a fake client. The decision is the half a
 * reviewer cannot check by reading the SQL — whether the predicate is applied at all, and to whom.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const USER = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const MY_EXTENSION = "019fd3c2-aaaa-7000-8000-000000000001";
const MINE: OwnedParties = { extensionIds: [MY_EXTENSION], numbers: ["1001"] };

function sessionWith(permissions: readonly Permission[]): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: ORG,
		},
		user: { id: USER, email: "u@test", name: "U", emailVerified: true },
		permissions,
	};
}

function legRow(overrides: Partial<CallLegListRow> = {}): CallLegListRow {
	return {
		id: "019fd3c2-cccc-7000-8000-000000000001",
		callId: "019fd3c2-dddd-7000-8000-000000000001",
		leg: "a",
		originatingLegId: null,
		bridgeLegId: null,
		direction: "inbound",
		fromNumber: "+15551230000",
		fromName: null,
		toNumber: "+15559990000",
		destinationType: "queue",
		destinationRef: null,
		startedAt: new Date("2026-08-05T10:00:00.000Z"),
		answeredAt: null,
		endedAt: null,
		durationMs: 0,
		billsecMs: 0,
		hangupCause: "NORMAL_CLEARING",
		hangupCauseCode: 16,
		hangupSide: "caller",
		disposition: "answered",
		...overrides,
	} as CallLegListRow;
}

/** The predicates a `where` renders to, through a real builder over the real table. */
function predicatesOf(condition: SQL): string {
	// The builder is cast to the area's own transaction type, as `queueStats.test.ts` does: the
	// workspace resolves `drizzle-orm` twice and a directly-typed builder cannot be handed
	// `cdr-db`'s table.
	const builder = new QueryBuilder() as unknown as CdrDatabaseTransaction;
	const { sql } = builder.select({ id: callLegs.id }).from(callLegs).where(condition).toSQL();
	return sql.slice(sql.indexOf(" where "));
}

interface FakeDb {
	readonly client: CdrDatabaseClient;
	/** Every `where` the service's queries issued, in order. */
	readonly conditions: SQL[];
	readonly scopes: string[];
}

/** A CDR client whose every select records its `where` and answers the queued rows. */
function fakeDatabase(...resultSets: readonly (readonly CallLegListRow[])[]): FakeDb {
	const queue = [...resultSets];
	const conditions: SQL[] = [];
	const scopes: string[] = [];
	const builder: Record<string, unknown> = {};
	builder.select = () => builder;
	builder.from = () => builder;
	builder.where = (condition: SQL) => {
		conditions.push(condition);
		return builder;
	};
	builder.orderBy = () => builder;
	builder.limit = async () => queue.shift() ?? [];
	const client = {
		withTenantScope: async <T>(organizationId: string, work: (t: never) => Promise<T>) => {
			scopes.push(organizationId);
			return await work(builder as never);
		},
	} as unknown as CdrDatabaseClient;
	return { client, conditions, scopes };
}

function selfParties(owned: OwnedParties): { port: CdrSelfParties; calls: string[] } {
	const calls: string[] = [];
	return {
		port: {
			forUser: async (organizationId, userId) => {
				calls.push(`${organizationId}/${userId}`);
				return owned;
			},
		},
		calls,
	};
}

const LIST = cdrListQuerySchema.parse({});
const LEG = cdrLegQuerySchema.parse({});
const CALL = cdrCallQuerySchema.parse({});

describe("the cdr.read.own party predicate", () => {
	it("matches either end of the leg AND the extension a B-leg was dialled to", () => {
		const predicates = predicatesOf(ownPartyFilter(MINE));

		// Both spellings: the number the ledger records on a call they placed or answered directly,
		// and the row id on the legs a ring group or a queue delivered to them.
		expect(predicates).to.contain('"from_number" in');
		expect(predicates).to.contain('"to_number" in');
		expect(predicates).to.contain('"destination_type" = ');
		expect(predicates).to.contain('"destination_ref" in');
		// The tenant is still RLS's job, here as everywhere else in this area.
		expect(predicates).to.not.contain("organization_id");
	});

	it("names only the numbers when the user's extensions have no ids to match", () => {
		const predicates = predicatesOf(ownPartyFilter({ extensionIds: [], numbers: ["1001"] }));
		expect(predicates).to.contain('"from_number" in');
		expect(predicates).to.not.contain('"destination_ref"');
	});

	it("knows when there is nothing to match on at all", () => {
		expect(hasAnyParty({ extensionIds: [], numbers: [] })).to.equal(false);
		expect(hasAnyParty(MINE)).to.equal(true);
	});

	it("recognises a row by number in either direction, and by the destination it was dialled to", () => {
		const matches = ownPartyMatcher(MINE);
		expect(matches(legRow({ fromNumber: "1001" }))).to.equal(true);
		expect(matches(legRow({ toNumber: "1001" }))).to.equal(true);
		expect(
			matches(legRow({ destinationType: "extension", destinationRef: MY_EXTENSION })),
		).to.equal(true);
		// A B-leg dialled to somebody ELSE's extension, in a call they are not on.
		expect(
			matches(
				legRow({
					destinationType: "extension",
					destinationRef: "019fd3c2-bbbb-7000-8000-000000000002",
				}),
			),
		).to.equal(false);
		expect(matches(legRow())).to.equal(false);
	});
});

describe("the CDR service under cdr.read versus cdr.read.own", () => {
	it("leaves an unscoped holder unnarrowed, and never asks who they are", async () => {
		const database = fakeDatabase([legRow()]);
		const parties = selfParties(MINE);
		const service = new CdrService(database.client, parties.port);

		const page = await service.list(sessionWith(["cdr.read"]), LIST);

		expect(page.data).to.have.length(1);
		expect(parties.calls).to.have.length(0);
		expect(predicatesOf(database.conditions[0] as SQL)).to.not.contain('"from_number" in');
	});

	it("narrows a scoped holder to the calls their own extensions are a party to", async () => {
		const database = fakeDatabase([legRow({ toNumber: "1001" })]);
		const parties = selfParties(MINE);
		const service = new CdrService(database.client, parties.port);

		const page = await service.list(sessionWith(["cdr.read.own"]), LIST);

		expect(parties.calls).to.deep.equal([`${ORG}/${USER}`]);
		expect(database.scopes).to.deep.equal([ORG]);
		expect(page.data).to.have.length(1);
		expect(predicatesOf(database.conditions[0] as SQL)).to.contain('"from_number" in');
	});

	it("answers a scoped holder who has no extension with an empty page, and asks the ledger nothing", async () => {
		const database = fakeDatabase([legRow()]);
		const service = new CdrService(
			database.client,
			selfParties({ extensionIds: [], numbers: [] }).port,
		);

		const page = await service.list(sessionWith(["cdr.read.own"]), LIST);

		// An ordinary state — a member with no phone — and their own call history really is empty.
		expect(page.data).to.have.length(0);
		expect(database.conditions).to.have.length(0);
	});

	it("carries the same narrowing into the single-leg read", async () => {
		const database = fakeDatabase([legRow({ fromNumber: "1001" })], []);
		const service = new CdrService(database.client, selfParties(MINE).port);

		await service.get(sessionWith(["cdr.read.own"]), legRow().id, LEG);

		expect(predicatesOf(database.conditions[0] as SQL)).to.contain('"to_number" in');
	});

	it("returns a call's WHOLE tree once the caller is a party to any leg of it", async () => {
		const legs = [
			legRow({ id: "019fd3c2-cccc-7000-8000-00000000000a", leg: "a" }),
			legRow({
				id: "019fd3c2-cccc-7000-8000-00000000000b",
				leg: "b",
				destinationType: "extension",
				destinationRef: MY_EXTENSION,
			}),
		];
		const database = fakeDatabase(legs, []);
		const service = new CdrService(database.client, selfParties(MINE).port);

		const found = await service.getCall(sessionWith(["cdr.read.own"]), legs[0]?.callId ?? "", CALL);

		// The A-leg names a caller from outside; without it the timeline the UI draws starts nowhere.
		expect(found.data.legs).to.have.length(2);
	});

	it("refuses a call the scoped holder is not a party to, as a not-found", async () => {
		const database = fakeDatabase([legRow(), legRow({ leg: "b" })], []);
		const service = new CdrService(database.client, selfParties(MINE).port);

		await service.getCall(sessionWith(["cdr.read.own"]), legRow().callId, CALL).then(
			() => expect.fail("a call belonging to somebody else was returned"),
			(error: { getStatus?: () => number }) => {
				expect(error.getStatus?.()).to.equal(404);
			},
		);
	});

	it("still returns another user's call to an unscoped holder", async () => {
		const database = fakeDatabase([legRow(), legRow({ leg: "b" })], []);
		const service = new CdrService(database.client, selfParties(MINE).port);

		const found = await service.getCall(sessionWith(["cdr.read"]), legRow().callId, CALL);

		expect(found.data.legs).to.have.length(2);
	});

	it("refuses the scoped grant by name where no link to a user exists at all", async () => {
		const database = fakeDatabase([legRow()]);
		const service = new CdrService(database.client);

		await service.list(sessionWith(["cdr.read.own"]), LIST).then(
			() => expect.fail("a deployment with no PBX area answered a self-scoped read"),
			(error: { getStatus?: () => number; getResponse?: () => { code?: string } }) => {
				expect(error.getStatus?.()).to.equal(403);
				expect(error.getResponse?.().code).to.equal("CDR_SELF_SCOPE_UNAVAILABLE");
			},
		);
		expect(database.conditions).to.have.length(0);
	});
});
