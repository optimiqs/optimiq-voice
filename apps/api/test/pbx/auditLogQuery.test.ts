import { Reflector } from "@nestjs/core";
import { expect } from "chai";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { getSystemRoleTemplate, MissingActiveOrganizationError } from "@optimiq-voice/auth";
import { APP_SESSION_REQUEST_KEY } from "../../src/auth/app-session";
import { MissingPermissionException } from "../../src/auth/auth.errors";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import { RequirePermissionsGuard } from "../../src/auth/require-permissions.guard";
import { AuditLogQueryService } from "../../src/pbx/audit-log/audit-log-query.service";
import { AuditLogController } from "../../src/pbx/audit-log/audit-log.controller";
import {
	AuditLogCursorError,
	decodeAuditLogCursor,
	encodeAuditLogCursor,
	nextAuditLogCursor,
} from "../../src/pbx/audit-log/audit-log.cursor";
import {
	auditLogQuerySchema,
	auditRangeDays,
	DEFAULT_AUDIT_LIMIT,
	DEFAULT_RANGE_DAYS,
	MAX_AUDIT_LIMIT,
	MAX_RANGE_DAYS,
	resolveAuditRange,
} from "../../src/pbx/audit-log/audit-log.dto";
import { auditLogListQuery } from "../../src/pbx/audit-log/audit-log.repository";
import type { AuthService, ResolvedAccess } from "../../src/auth/auth.service";
import type { AuditLogQuery } from "../../src/pbx/audit-log/audit-log.dto";
import type { AuditLogRow } from "../../src/pbx/audit-log/audit-log.repository";
import type { ExecutionContext } from "@nestjs/common";
import type { AppSession, Permission } from "@optimiq-voice/auth";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

/**
 * The `audit_log` READ surface — `GET /api/v1/audit-log`.
 *
 * `auditLog.test.ts` covers the writer (who a mutation is attributed to, what the diff keeps and
 * what it redacts). This covers the four things a read surface over a tenant ledger can get
 * wrong, none of which need a database:
 *
 *  1. **Isolation** — the tenant comes from the session and only from the session, no parameter
 *     combination introduces an organization predicate, and the query itself relies on RLS rather
 *     than on a `where` clause somebody could delete.
 *  2. **Authorization** — the route demands `audit.read`, and a member whose role does not hold
 *     it is refused.
 *  3. **Immutability** — the controller exposes one GET and nothing else.
 *  4. **Paging and filtering** — the cursor is total, the window defaults and is capped, and each
 *     filter reaches SQL as the predicate it claims to be.
 *
 * The SQL assertions use Drizzle's standalone `QueryBuilder`, so they are the real rendering of
 * the real query with no connection anywhere near them.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORGANIZATION_ID = "019fd3c2-9999-76be-a6b3-b0f1914e39b6";
const USER_ID = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const ROW_ID = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const OLDER_ROW_ID = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";
const NOW = new Date("2026-08-11T12:00:00.000Z");

function sessionFor(activeOrganizationId: string | null = ORGANIZATION_ID): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER_ID,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId,
			ipAddress: null,
			userAgent: "Mozilla/5.0 (test)",
		},
		user: { id: USER_ID, email: "u@test", name: "U", emailVerified: true },
	} as AppSession;
}

// ---------------------------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------------------------

describe("audit-log cursor", () => {
	it("round trips a position", () => {
		const cursor = { occurredAt: new Date("2026-08-11T10:00:00.000Z"), id: ROW_ID };
		const decoded = decodeAuditLogCursor(encodeAuditLogCursor(cursor));

		expect(decoded.occurredAt.toISOString()).to.equal(cursor.occurredAt.toISOString());
		expect(decoded.id).to.equal(cursor.id);
	});

	it("refuses anything that is not one of ours", () => {
		for (const bad of ["", "not-base64!!", Buffer.from("nope").toString("base64url")]) {
			expect(() => decodeAuditLogCursor(bad), bad).to.throw(AuditLogCursorError);
		}
	});

	it("refuses a cursor whose id is not a uuid", () => {
		// The id reaches a `::uuid` cast in the keyset comparison; a forged one must be a 400 rather
		// than a 22P02 from the database.
		const forged = Buffer.from("2026-08-11T10:00:00.000Z|1 OR 1=1", "utf8").toString("base64url");

		expect(() => decodeAuditLogCursor(forged)).to.throw(AuditLogCursorError);
	});

	it("refuses a cursor whose timestamp is not readable", () => {
		const forged = Buffer.from(`never|${ROW_ID}`, "utf8").toString("base64url");

		expect(() => decodeAuditLogCursor(forged)).to.throw(AuditLogCursorError);
	});

	it("reports no next page when the sentinel row did not come back", () => {
		// Asked for 2, got 1 — a full last page and an empty next page are indistinguishable by
		// length alone, which is why the fetched count is what decides.
		expect(nextAuditLogCursor([{ id: ROW_ID, occurredAt: NOW }], 1, 1)).to.equal(null);
	});

	it("reports a next page when the sentinel row did come back", () => {
		expect(nextAuditLogCursor([{ id: ROW_ID, occurredAt: NOW }], 1, 2)).to.be.a("string");
	});

	it("reports no next page for an empty result, whatever the counts say", () => {
		expect(nextAuditLogCursor([], 25, 0)).to.equal(null);
	});
});

// ---------------------------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------------------------

describe("audit-log time range", () => {
	it("defaults to the last thirty days", () => {
		const range = resolveAuditRange({}, NOW);

		expect(range.to.toISOString()).to.equal(NOW.toISOString());
		expect(range.to.getTime() - range.from.getTime()).to.equal(DEFAULT_RANGE_DAYS * 24 * 3600_000);
	});

	it("anchors the default window on an explicit `to`", () => {
		const range = resolveAuditRange({ to: "2026-03-01T00:00:00.000Z" }, NOW);

		expect(range.to.toISOString()).to.equal("2026-03-01T00:00:00.000Z");
		expect(range.from.toISOString()).to.equal("2026-01-30T00:00:00.000Z");
	});

	it("normalizes an inverted range instead of rejecting it", () => {
		const range = resolveAuditRange(
			{ from: "2026-08-11T12:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
			NOW,
		);

		expect(range.from.toISOString()).to.equal("2026-08-01T00:00:00.000Z");
		expect(range.to.toISOString()).to.equal("2026-08-11T12:00:00.000Z");
	});

	it("measures a range in whole days so the ceiling is comparable", () => {
		const range = resolveAuditRange(
			{ from: "2024-01-01T00:00:00.000Z", to: "2026-08-11T00:00:00.000Z" },
			NOW,
		);

		expect(auditRangeDays(range)).to.be.greaterThan(MAX_RANGE_DAYS);
	});
});

// ---------------------------------------------------------------------------------------------
// The query DTO
// ---------------------------------------------------------------------------------------------

describe("audit-log query DTO", () => {
	it("applies the default limit and leaves the window to the service", () => {
		const parsed = auditLogQuerySchema.parse({});

		expect(parsed.limit).to.equal(DEFAULT_AUDIT_LIMIT);
		expect(parsed.from).to.equal(undefined);
		expect(parsed.cursor).to.equal(undefined);
	});

	it("coerces query strings, because query strings are strings", () => {
		expect(auditLogQuerySchema.parse({ limit: "50" }).limit).to.equal(50);
	});

	it("caps the limit at the API's own ceiling and refuses a non-positive page", () => {
		expect(() => auditLogQuerySchema.parse({ limit: String(MAX_AUDIT_LIMIT + 1) })).to.throw();
		expect(() => auditLogQuerySchema.parse({ limit: "0" })).to.throw();
	});

	it("accepts only the actor types the column declares", () => {
		expect(auditLogQuerySchema.parse({ actorType: "api-key" }).actorType).to.equal("api-key");
		expect(() => auditLogQuerySchema.parse({ actorType: "robot" })).to.throw();
	});

	it("refuses an action that is not a dotted verb", () => {
		expect(auditLogQuerySchema.parse({ action: "extension.update" }).action).to.equal(
			"extension.update",
		);
		expect(() => auditLogQuerySchema.parse({ action: "extension" })).to.throw();
		expect(() => auditLogQuerySchema.parse({ action: "extension.update; drop table" })).to.throw();
	});

	it("refuses a resource type that is not a table name", () => {
		expect(auditLogQuerySchema.parse({ resourceType: "org_setting" }).resourceType).to.equal(
			"org_setting",
		);
		expect(() => auditLogQuerySchema.parse({ resourceType: "Extension" })).to.throw();
	});

	it("refuses an id filter that is not a uuid", () => {
		expect(() => auditLogQuerySchema.parse({ resourceRef: "42" })).to.throw();
		expect(() => auditLogQuerySchema.parse({ actorUserId: "42" })).to.throw();
	});

	/**
	 * The tenant is never a parameter — so a client that sends one gets it dropped rather than
	 * honoured. This is belt to the RLS policy's braces, and it is the cheapest of the three
	 * layers to assert.
	 */
	it("drops an organization the client tried to name", () => {
		const parsed = auditLogQuerySchema.parse({
			organizationId: OTHER_ORGANIZATION_ID,
			organization_id: OTHER_ORGANIZATION_ID,
		});

		expect(Object.keys(parsed)).to.not.include("organizationId");
		expect(Object.keys(parsed)).to.not.include("organization_id");
	});
});

// ---------------------------------------------------------------------------------------------
// The SQL — rendered with Drizzle's standalone builder, no database involved
// ---------------------------------------------------------------------------------------------

function renderedQuery(query: Partial<AuditLogQuery>): { sql: string; params: unknown[] } {
	const parsed = auditLogQuerySchema.parse(query);
	const range = resolveAuditRange(parsed, NOW);
	const built = auditLogListQuery(
		new QueryBuilder() as unknown as PbxDatabaseTransaction,
		parsed,
		range,
	).toSQL();
	return { sql: built.sql, params: [...built.params] };
}

function whereClause(sql: string): string {
	return sql.slice(sql.indexOf(" where "), sql.indexOf(" order by "));
}

describe("audit-log SQL", () => {
	it("always bounds the window and always orders newest first", () => {
		const { sql, params } = renderedQuery({});

		expect(whereClause(sql)).to.contain('"occurred_at" >=');
		expect(whereClause(sql)).to.contain('"occurred_at" <=');
		expect(sql).to.contain('order by "audit_log"."occurred_at" desc, "audit_log"."id" desc');
		// limit + 1: the sentinel row that answers "is there a next page" with evidence.
		expect(params.at(-1)).to.equal(DEFAULT_AUDIT_LIMIT + 1);
	});

	/**
	 * The isolation invariant, stated as an assertion rather than as a comment.
	 *
	 * The tenant is enforced by `audit_log_tenant_select` inside `withTenantScope`, so the query
	 * carries no organization predicate at all. If one ever appears here it will be because
	 * somebody threaded a client-supplied id into the repository, which is the exact mistake this
	 * area's shape exists to prevent.
	 */
	it("carries no organization predicate under any filter combination", () => {
		const combinations: Partial<AuditLogQuery>[] = [
			{},
			{ actorUserId: USER_ID },
			{ actorType: "api-key", actorRef: "key-1" },
			{ action: "extension.update", resourceType: "extension", resourceRef: ROW_ID },
			{ from: "2026-08-01T00:00:00.000Z", to: "2026-08-11T00:00:00.000Z", limit: 100 },
			{
				actorType: "user",
				actorUserId: USER_ID,
				action: "org-setting.update",
				resourceType: "org_setting",
				resourceRef: ROW_ID,
				cursor: encodeAuditLogCursor({ occurredAt: NOW, id: ROW_ID }),
			},
		];

		for (const combination of combinations) {
			const { sql, params } = renderedQuery(combination);
			expect(whereClause(sql), JSON.stringify(combination)).to.not.contain("organization_id");
			expect(params, JSON.stringify(combination)).to.not.include(OTHER_ORGANIZATION_ID);
			expect(params, JSON.stringify(combination)).to.not.include(ORGANIZATION_ID);
		}
	});

	it("turns each filter into exactly the predicate it claims to be", () => {
		const { sql, params } = renderedQuery({
			actorType: "api-key",
			actorUserId: USER_ID,
			actorRef: "key-1",
			action: "extension.update",
			resourceType: "extension",
			resourceRef: ROW_ID,
		});
		const where = whereClause(sql);

		for (const column of [
			"actor_type",
			"actor_user_id",
			"actor_ref",
			"action",
			"resource_type",
			"resource_ref",
		]) {
			expect(where, column).to.contain(`"${column}" =`);
		}
		expect(params).to.include.members([
			"api-key",
			USER_ID,
			"key-1",
			"extension.update",
			"extension",
			ROW_ID,
		]);
	});

	it("adds no filter for a parameter that was not sent", () => {
		const where = whereClause(renderedQuery({ resourceRef: ROW_ID }).sql);

		expect(where).to.contain('"resource_ref" =');
		expect(where).to.not.contain('"actor_user_id" =');
		expect(where).to.not.contain('"action" =');
	});

	/**
	 * The keyset, as a ROW comparison.
	 *
	 * `(a, b) < (x, y)` is what PostgreSQL turns into a single seek on
	 * `(organization_id, occurred_at, id)`. The expanded boolean form means the same thing and
	 * usually degrades into a filter over the whole window, so the shape is worth pinning.
	 */
	it("pages with a row comparison over (occurred_at, id), not an offset", () => {
		const cursor = encodeAuditLogCursor({ occurredAt: NOW, id: ROW_ID });
		const { sql, params } = renderedQuery({ cursor });

		expect(whereClause(sql)).to.contain('"audit_log"."occurred_at", "audit_log"."id") < (');
		expect(sql).to.not.contain("offset");
		expect(params).to.include(NOW.toISOString());
		expect(params).to.include(ROW_ID);
	});
});

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

function auditRow(occurredAt: Date, id: string): AuditLogRow {
	return {
		id,
		organizationId: ORGANIZATION_ID,
		actorType: "user",
		actorUserId: USER_ID,
		actorRef: null,
		action: "extension.update",
		resourceType: "extension",
		resourceRef: ROW_ID,
		before: { label: "Front desk" },
		after: { label: "Reception" },
		ipAddress: null,
		userAgent: null,
		requestId: null,
		occurredAt,
		createdAt: occurredAt,
	};
}

/**
 * `withTenantScope` faked rather than stubbed per-query, on the same terms as
 * `queueAgentSession.test.ts`: asserting on the SQL here would be asserting on Drizzle, and the
 * SQL has its own section above. What this fake records is the ONE thing the service decides —
 * which organization the transaction is opened for.
 */
function fakeDatabase(rows: readonly AuditLogRow[]): {
	database: PbxDatabaseClient;
	scopes: string[];
} {
	const scopes: string[] = [];
	const transaction = {
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: () => ({
						limit: () => ({
							then: (resolve: (value: unknown) => void) => {
								resolve([...rows]);
							},
						}),
					}),
				}),
			}),
		}),
	};
	const database = {
		withTenantScope: async <T>(
			organizationId: string,
			work: (transaction: never) => Promise<T>,
		): Promise<T> => {
			scopes.push(organizationId);
			return await work(transaction as never);
		},
	} as unknown as PbxDatabaseClient;
	return { database, scopes };
}

async function caught(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("AuditLogQueryService", () => {
	it("returns the page, the echoed window and no next cursor when there is no more", async () => {
		const rows = [auditRow(NOW, ROW_ID)];
		const { database, scopes } = fakeDatabase(rows);
		const service = new AuditLogQueryService(database);

		const envelope = await service.list(sessionFor(), auditLogQuerySchema.parse({}));

		expect(scopes).to.deep.equal([ORGANIZATION_ID]);
		expect(envelope.data).to.have.length(1);
		expect(envelope.nextCursor).to.equal(null);
		expect(envelope.limit).to.equal(DEFAULT_AUDIT_LIMIT);
		// The window was DEFAULTED, so it is echoed: a filter the caller cannot see is what makes
		// "why is my change missing?" unanswerable.
		expect(
			new Date(envelope.range.to).getTime() - new Date(envelope.range.from).getTime(),
		).to.equal(DEFAULT_RANGE_DAYS * 24 * 3600_000);
	});

	it("trims the sentinel row and hands back a cursor onto the next page", async () => {
		const first = auditRow(new Date("2026-08-11T11:00:00.000Z"), ROW_ID);
		const sentinel = auditRow(new Date("2026-08-11T10:00:00.000Z"), OLDER_ROW_ID);
		const { database } = fakeDatabase([first, sentinel]);
		const service = new AuditLogQueryService(database);

		const envelope = await service.list(sessionFor(), auditLogQuerySchema.parse({ limit: "1" }));

		expect(envelope.data).to.have.length(1);
		expect(envelope.data[0]?.id).to.equal(ROW_ID);
		expect(envelope.nextCursor).to.be.a("string");
		// The handle names the LAST row of the page that was returned, not the sentinel.
		expect(decodeAuditLogCursor(envelope.nextCursor as string).id).to.equal(ROW_ID);
	});

	it("returns an empty page rather than a 404 when nothing matched", async () => {
		const { database } = fakeDatabase([]);
		const service = new AuditLogQueryService(database);

		const envelope = await service.list(
			sessionFor(),
			auditLogQuerySchema.parse({ resourceRef: ROW_ID }),
		);

		expect(envelope.data).to.deep.equal([]);
		expect(envelope.nextCursor).to.equal(null);
	});

	/**
	 * The isolation invariant at the layer that decides it.
	 *
	 * The DTO has already dropped the client's `organizationId` (above); this proves the service
	 * would not have used it even if it had survived — the only value that reaches
	 * `withTenantScope` is the session's.
	 */
	it("scopes to the session's organization and never to one the client named", async () => {
		const { database, scopes } = fakeDatabase([]);
		const service = new AuditLogQueryService(database);

		await service.list(
			sessionFor(),
			auditLogQuerySchema.parse({
				organizationId: OTHER_ORGANIZATION_ID,
				actorUserId: USER_ID,
				resourceRef: ROW_ID,
			}),
		);

		expect(scopes).to.deep.equal([ORGANIZATION_ID]);
	});

	it("refuses a session with no active organization instead of querying unscoped", async () => {
		const { database, scopes } = fakeDatabase([]);
		const service = new AuditLogQueryService(database);

		const error = await caught(async () =>
			service.list(sessionFor(null), auditLogQuerySchema.parse({})),
		);

		expect(error).to.be.instanceOf(MissingActiveOrganizationError);
		expect(scopes).to.deep.equal([]);
	});

	it("refuses a window wider than one request may scan, before opening a transaction", async () => {
		const { database, scopes } = fakeDatabase([]);
		const service = new AuditLogQueryService(database);

		const error = await caught(async () =>
			service.list(
				sessionFor(),
				auditLogQuerySchema.parse({
					from: "2020-01-01T00:00:00.000Z",
					to: "2026-08-11T00:00:00.000Z",
				}),
			),
		);

		expect((error as { getStatus(): number }).getStatus()).to.equal(400);
		expect((error as { getResponse(): { code: string } }).getResponse().code).to.equal(
			"AUDIT_RANGE_TOO_WIDE",
		);
		expect(scopes).to.deep.equal([]);
	});

	it("turns an unreadable cursor into a 400 rather than a 500", async () => {
		const { database } = fakeDatabase([]);
		const service = new AuditLogQueryService(database);

		const error = await caught(async () =>
			service.list(sessionFor(), auditLogQuerySchema.parse({ cursor: "not-one-of-ours!!" })),
		);

		expect((error as { getStatus(): number }).getStatus()).to.equal(400);
		expect((error as { getResponse(): { code: string } }).getResponse().code).to.equal(
			"AUDIT_INVALID_CURSOR",
		);
	});

	it("accepts the widest window the ceiling allows", async () => {
		const { database, scopes } = fakeDatabase([]);
		const service = new AuditLogQueryService(database);

		await service.list(
			sessionFor(),
			auditLogQuerySchema.parse({
				from: "2025-08-11T00:00:00.000Z",
				to: "2026-08-11T00:00:00.000Z",
				limit: String(MAX_AUDIT_LIMIT),
			}),
		);

		expect(scopes).to.deep.equal([ORGANIZATION_ID]);
	});
});

// ---------------------------------------------------------------------------------------------
// Authorization, and the absence of a write
// ---------------------------------------------------------------------------------------------

describe("audit-log authorization", () => {
	it("demands audit.read and nothing else", () => {
		const required = Reflect.getMetadata(
			REQUIRE_PERMISSIONS_METADATA,
			AuditLogController.prototype.list,
		) as readonly Permission[];

		expect([...required]).to.deep.equal(["audit.read"]);
	});

	/**
	 * The ledger is append-only in the DATABASE — the tenant role holds `SELECT, INSERT` under two
	 * policies rather than one `FOR ALL` — so there is no mutation for this controller to expose,
	 * and this asserts none was added. A handler here would fail against the real database anyway;
	 * failing here says why.
	 */
	it("exposes one handler, and it is the listing", () => {
		expect(Object.getOwnPropertyNames(AuditLogController.prototype)).to.deep.equal([
			"constructor",
			"list",
		]);
	});

	function guardFor(permissions: readonly Permission[]): {
		guard: RequirePermissionsGuard;
		context: ExecutionContext;
	} {
		const handler = () => undefined;
		Reflect.defineMetadata(REQUIRE_PERMISSIONS_METADATA, ["audit.read"], handler);
		const request: Record<string, unknown> = { [APP_SESSION_REQUEST_KEY]: sessionFor() };
		const context = {
			getHandler: () => handler,
			getClass: () => AuditLogController,
			switchToHttp: () => ({ getRequest: () => request }),
		} as unknown as ExecutionContext;
		const access: ResolvedAccess = {
			organizationId: ORGANIZATION_ID,
			role: "member",
			permissions: [...permissions],
		};
		const authService = { resolveAccess: async () => access } as unknown as AuthService;
		return { guard: new RequirePermissionsGuard(new Reflector(), authService), context };
	}

	it("refuses a member whose role does not hold it", async () => {
		// The `manager` template runs the phone system day to day and deliberately does NOT get the
		// change history of everyone else in the organization.
		const manager = getSystemRoleTemplate("manager").permissions;
		expect(manager).to.not.include("audit.read");

		const { guard, context } = guardFor(manager);
		const error = await caught(async () => guard.canActivate(context));

		expect(error).to.be.instanceOf(MissingPermissionException);
	});

	it("refuses the self-service roles outright", async () => {
		for (const roleId of ["user", "agent"] as const) {
			const permissions = getSystemRoleTemplate(roleId).permissions;
			expect(permissions, roleId).to.not.include("audit.read");

			const { guard, context } = guardFor(permissions);
			expect(await caught(async () => guard.canActivate(context)), roleId).to.be.instanceOf(
				MissingPermissionException,
			);
		}
	});

	it("lets an administrator and an owner through", async () => {
		for (const roleId of ["admin", "owner"] as const) {
			const { guard, context } = guardFor(getSystemRoleTemplate(roleId).permissions);
			expect(await guard.canActivate(context), roleId).to.equal(true);
		}
	});
});
