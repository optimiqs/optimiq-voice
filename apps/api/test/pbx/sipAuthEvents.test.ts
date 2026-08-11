import { Reflector } from "@nestjs/core";
import { expect } from "chai";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import {
	resolveEventRange,
	sipAuthEventListQuery,
	SipAuthEventQueryService,
} from "../../src/pbx/security/sip-auth-event-query.service";
import { SipAuthEventController } from "../../src/pbx/security/sip-auth-event.controller";
import {
	DEFAULT_EVENT_LIMIT,
	DEFAULT_EVENT_RANGE_DAYS,
	MAX_EVENT_LIMIT,
	sipAuthEventQuerySchema,
} from "../../src/pbx/security/sip-auth-event.dto";
import { SipAuthEventService } from "../../src/pbx/security/sip-auth-event.service";
import type { SipAuthEventQuery } from "../../src/pbx/security/sip-auth-event.dto";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

/**
 * The attack log — `sip_auth_event`, its writer and `GET /api/v1/sip-auth-events`.
 *
 * The parity audit's row 1.25 says the platform has no attack-log surface at all. What a first one
 * can get wrong, none of which needs a database:
 *
 *  1. **Isolation** — the tenant comes from the session, the write goes through `withTenantScope`,
 *     and no query parameter can introduce an organization predicate.
 *  2. **The writer cannot make things worse.** It runs on a path where something has ALREADY been
 *     refused; a failure there must not turn a correct 404 into a 500, which is exactly what a
 *     database under load during an attack would otherwise produce.
 *  3. **What never reaches a column** — no credential, and no unbounded attacker-chosen string.
 *  4. **Paging and filtering** — the address filter has to reach SQL as an `inet` comparison, or it
 *     is a scan that also stops matching the v4-mapped forms a dual-stack listener reports.
 *
 * The SQL assertions use Drizzle's standalone `QueryBuilder`, so they are the real rendering.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORG = "019fd3c2-8888-76be-a6b3-b0f1914e39b6";
const USER = "019fd3c2-9999-76be-a6b3-b0f1914e39b6";
const ROW_ID = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";

function sessionFor(): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: ORG,
			ipAddress: null,
			userAgent: "Mozilla/5.0 (test)",
		},
		user: { id: USER, email: "u@test", name: "U", emailVerified: true },
	} as AppSession;
}

function sqlFor(query: SipAuthEventQuery): string {
	const builder = new QueryBuilder() as unknown as PbxDatabaseTransaction;
	return sipAuthEventListQuery(builder, query, resolveEventRange(query)).toSQL().sql;
}

/**
 * Just the predicates.
 *
 * `auditLogQuery.test.ts` slices the same way and for the same reason: the SELECT projection names
 * `organization_id` as a COLUMN, so a substring search over the whole statement can never prove
 * that no predicate mentions the tenant.
 */
function whereClause(sql: string): string {
	return sql.slice(sql.indexOf(" where "), sql.indexOf(" order by "));
}

/** A database whose tenant scope is observable and whose insert is captured. */
function fakeDatabase(options: { readonly failInsert?: boolean } = {}) {
	const scopes: string[] = [];
	const inserted: Record<string, unknown>[] = [];
	const database = {
		withTenantScope: async <T>(
			organizationId: string,
			run: (transaction: PbxDatabaseTransaction) => Promise<T>,
		): Promise<T> => {
			scopes.push(organizationId);
			const transaction = {
				insert: () => ({
					values: async (row: Record<string, unknown>) => {
						if (options.failInsert === true) {
							throw new Error("deadlock detected");
						}
						inserted.push(row);
					},
				}),
			} as unknown as PbxDatabaseTransaction;
			return await run(transaction);
		},
	} as unknown as PbxDatabaseClient;
	return { database, scopes, inserted };
}

describe("the sip auth event query DTO", () => {
	it("defaults to a seven-day window, not the ledger's thirty", () => {
		// An attack log is read operationally — something is happening now, or happened last night.
		// Thirty days of an ongoing attack is a lot of rows to page through to reach the ones that
		// matter.
		const range = resolveEventRange({});
		expect(range.to.getTime() - range.from.getTime()).to.equal(
			DEFAULT_EVENT_RANGE_DAYS * 24 * 3600_000,
		);
	});

	it("swaps an inverted range rather than refusing it", () => {
		const range = resolveEventRange({
			from: "2026-08-11T00:00:00.000Z",
			to: "2026-08-01T00:00:00.000Z",
		});
		expect(range.from.toISOString()).to.equal("2026-08-01T00:00:00.000Z");
	});

	it("caps the page size", () => {
		expect(sipAuthEventQuerySchema.parse({}).limit).to.equal(DEFAULT_EVENT_LIMIT);
		expect(sipAuthEventQuerySchema.safeParse({ limit: MAX_EVENT_LIMIT + 1 }).success).to.equal(
			false,
		);
	});

	it("takes an address and not a network", () => {
		// A prefix filter is the shape that invites `?sourceIp=0.0.0.0/0`, which is a full scan of the
		// window spelled as a filter.
		expect(sipAuthEventQuerySchema.safeParse({ sourceIp: "203.0.113.9" }).success).to.equal(true);
		expect(sipAuthEventQuerySchema.safeParse({ sourceIp: "2001:db8::1" }).success).to.equal(true);
		expect(sipAuthEventQuerySchema.safeParse({ sourceIp: "203.0.113.0/24" }).success).to.equal(
			false,
		);
	});

	it("refuses an event type or scope that is not in the column's own set", () => {
		expect(sipAuthEventQuerySchema.safeParse({ eventType: "acl-denied" }).success).to.equal(true);
		expect(sipAuthEventQuerySchema.safeParse({ eventType: "brute-force" }).success).to.equal(false);
		expect(sipAuthEventQuerySchema.safeParse({ scope: "registration" }).success).to.equal(true);
		expect(sipAuthEventQuerySchema.safeParse({ scope: "everything" }).success).to.equal(false);
	});

	it("drops an organizationId a client tried to send", () => {
		const parsed = sipAuthEventQuerySchema.parse({ organizationId: OTHER_ORG });
		expect(parsed).to.not.have.property("organizationId");
	});
});

describe("the sip auth event listing SQL", () => {
	it("never carries an organization predicate — RLS is the filter", () => {
		expect(whereClause(sqlFor(sipAuthEventQuerySchema.parse({})))).to.not.contain(
			"organization_id",
		);
		expect(
			whereClause(
				sqlFor(
					sipAuthEventQuerySchema.parse({
						eventType: "acl-denied",
						scope: "registration",
						sourceIp: "203.0.113.9",
						accountRef: "1001",
					}),
				),
			),
		).to.not.contain("organization_id");
	});

	it("always carries the window, which leads the index", () => {
		const sql = sqlFor(sipAuthEventQuerySchema.parse({}));
		expect(sql).to.contain('"sip_auth_event"."occurred_at" >=');
		expect(sql).to.contain('"sip_auth_event"."occurred_at" <=');
	});

	it("casts the address so the comparison is an inet seek rather than a column cast", () => {
		const sql = sqlFor(sipAuthEventQuerySchema.parse({ sourceIp: "203.0.113.9" }));
		expect(sql).to.contain("::inet");
	});

	it("fetches one more row than the page, so 'is there more' is evidence", () => {
		const sql = sqlFor(sipAuthEventQuerySchema.parse({ limit: 10 }));
		expect(sql).to.contain("limit");
		expect(sql).to.not.contain("count(");
	});

	it("orders newest first on the pair the cursor walks", () => {
		const sql = sqlFor(sipAuthEventQuerySchema.parse({}));
		expect(sql).to.contain(
			'order by "sip_auth_event"."occurred_at" desc, "sip_auth_event"."id" desc',
		);
	});
});

describe("SipAuthEventService", () => {
	it("writes inside the tenant scope and nowhere else", async () => {
		const { database, scopes, inserted } = fakeDatabase();
		await new SipAuthEventService(database).record({
			organizationId: ORG,
			eventType: "acl-denied",
			scope: "provisioning",
			sourceIp: "203.0.113.9",
			accountRef: "001565abcdef",
		});
		expect(scopes).to.deep.equal([ORG]);
		expect(inserted[0]?.organizationId).to.equal(ORG);
		expect(inserted[0]?.sourceIp).to.equal("203.0.113.9");
	});

	it("swallows its own failure, because the refusal must not change shape", async () => {
		// A database problem during an attack — which is when this table is written hardest — must not
		// turn a correct 404 into a 500 on a path that was answering correctly.
		const { database } = fakeDatabase({ failInsert: true });
		const service = new SipAuthEventService(database);
		await service.record({ organizationId: ORG, eventType: "rate-limited", scope: "provisioning" });
		expect(service.stats).to.deep.equal({ recorded: 0, failed: 1 });
	});

	it("stores a hostname or an empty peer as NULL rather than losing the whole event", async () => {
		const { database, inserted } = fakeDatabase();
		const service = new SipAuthEventService(database);
		for (const sourceIp of [undefined, "", "proxy.internal"]) {
			await service.record({
				organizationId: ORG,
				eventType: "acl-denied",
				scope: "api",
				sourceIp,
			});
		}
		expect(inserted.map((row) => row.sourceIp)).to.deep.equal([null, null, null]);
		expect(service.stats.recorded).to.equal(3);
	});

	it("bounds every attacker-chosen string", async () => {
		// Otherwise a 64 KB User-Agent repeated at attack rate is a disk-fill written by the thing
		// that is supposed to be defending against it.
		const { database, inserted } = fakeDatabase();
		await new SipAuthEventService(database).record({
			organizationId: ORG,
			eventType: "unknown-account",
			scope: "registration",
			accountRef: "a".repeat(4096),
			userAgent: "u".repeat(4096),
		});
		expect((inserted[0]?.accountRef as string).length).to.equal(128);
		expect((inserted[0]?.userAgent as string).length).to.equal(256);
	});
});

describe("the sip auth event listing", () => {
	/**
	 * The scope is asserted on the CLIENT, not on the query.
	 *
	 * `withTenantScope` is the only way this service reaches a transaction, so proving that the id it
	 * passes comes from the session — and never from the query string, which the DTO already dropped
	 * — is the whole isolation claim at this layer. The SQL assertions above cover the other half:
	 * there is no organization predicate for a bug to get wrong.
	 */
	function listWith(rows: readonly unknown[]) {
		const scopes: string[] = [];
		const database = {
			withTenantScope: async <T>(organizationId: string): Promise<T> => {
				scopes.push(organizationId);
				return rows as unknown as T;
			},
		} as unknown as PbxDatabaseClient;
		return { service: new SipAuthEventQueryService(database), scopes };
	}

	const row = (id: string) => ({ id, occurredAt: new Date("2026-08-11T09:00:00.000Z") });

	it("takes the tenant from the session and echoes the window it applied", async () => {
		const { service, scopes } = listWith([row(ROW_ID)]);

		const envelope = await service.list(sessionFor(), sipAuthEventQuerySchema.parse({}));

		expect(scopes).to.deep.equal([ORG]);
		expect(envelope.data).to.have.length(1);
		expect(envelope.nextCursor).to.equal(null);
		// The window was DEFAULTED, so it is echoed: a filter the caller cannot see is what makes
		// "why is this attempt missing?" unanswerable.
		expect(
			new Date(envelope.range.to).getTime() - new Date(envelope.range.from).getTime(),
		).to.equal(DEFAULT_EVENT_RANGE_DAYS * 24 * 3600_000);
	});

	it("uses the session's tenant even when the caller named another one", async () => {
		const { service, scopes } = listWith([]);

		await service.list(
			sessionFor(),
			sipAuthEventQuerySchema.parse({ organizationId: OTHER_ORG, sourceIp: "203.0.113.9" }),
		);

		expect(scopes).to.deep.equal([ORG]);
	});

	it("hands back a cursor only when the sentinel row came with the page", async () => {
		const { service } = listWith([row(ROW_ID), row("019fd3c2-4444-76be-a6b3-b0f1914e39b6")]);

		const envelope = await service.list(sessionFor(), sipAuthEventQuerySchema.parse({ limit: 1 }));

		expect(envelope.data).to.have.length(1);
		expect(envelope.nextCursor).to.be.a("string");
	});
});

describe("the sip auth event controller", () => {
	it("exposes one GET and nothing else — the table is append-only in the database", () => {
		const methods = Object.getOwnPropertyNames(SipAuthEventController.prototype).filter(
			(name) => name !== "constructor",
		);
		expect(methods).to.deep.equal(["list"]);
	});

	it("guards the listing with security.read", () => {
		expect(
			new Reflector().get(REQUIRE_PERMISSIONS_METADATA, SipAuthEventController.prototype.list),
		).to.deep.equal(["security.read"]);
	});
});
