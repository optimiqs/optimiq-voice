import { expect } from "chai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTestModuleRuntime } from "@optimiq-voice/effect-runtime";
import { API_KEY_PRINCIPAL_ROLE } from "../../src/auth/auth-http.plugin";
import { ExtensionsService } from "../../src/pbx/extensions/extensions.service";
import { IvrMenuOptionsService } from "../../src/pbx/ivr-menus/ivr-menus.service";
import { OrgLimitsService } from "../../src/pbx/org-limits/org-limits.service";
import {
	actorFromSession,
	asInetAddress,
	asUuid,
	changedColumns,
	diffOf,
	REDACTED,
} from "../../src/pbx/shared/audit-log";
import { AuditLogService } from "../../src/pbx/shared/audit-log.service";
import { PbxRepository } from "../../src/pbx/shared/pbx.repository";
import type { AuditMutationInput } from "../../src/pbx/shared/audit-log.service";
import type { PbxRepositoryRuntime } from "../../src/pbx/shared/pbx-runtime";
import type { PbxRepositoryInterface } from "../../src/pbx/shared/pbx.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

/**
 * The `audit_log` writer.
 *
 * Three seams, all assertable without a database:
 *
 *  1. the ACTOR — who a session says did it, and the api-key/user split;
 *  2. the DIFF — that it is the changed columns and that a `secretColumns` value never appears;
 *  3. the THREADING — that the services pass an actor to the repository at all, which is the one
 *     thing that turns a ledger with a writer into a ledger with attributed rows.
 *
 * The insert itself is one Drizzle statement inside the mutation's transaction; `verify:pbx`
 * proves it against a real RLS-enforcing database.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const USER_ID = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

function sessionFor(overrides: Partial<AppSession["user"]> = {}, ip?: string | null): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER_ID,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: ORGANIZATION_ID,
			ipAddress: ip ?? null,
			userAgent: "Mozilla/5.0 (test)",
		},
		user: { id: USER_ID, email: "u@test", name: "U", emailVerified: true, ...overrides },
	};
}

/**
 * An organization with no quotas.
 *
 * These specs are about the generic service's plumbing — the tenant argument, the resource
 * descriptor, the actor — and `ExtensionsService` is the resource they happen to use. Its create
 * path now asks about the extension quota first, so it needs one; an unlimited organization is what
 * every tenant is until somebody sets a ceiling, and it keeps the quota out of assertions that are
 * not about it. `orgLimits.test.ts` is where the enforcement itself is tested.
 */
const NO_LIMITS = {
	assertMayCreate: async () => undefined,
} as unknown as OrgLimitsService;

describe("audit-log actor", () => {
	it("attributes a person to their user id and leaves actor_ref for the non-user cases", () => {
		const actor = actorFromSession(sessionFor());
		expect(actor.type).to.equal("user");
		expect(actor.userId).to.equal(USER_ID);
		expect(actor.ref).to.equal(null);
	});

	it("attributes an API key to the key, never to a user row that does not exist", () => {
		// `auth-http.plugin.ts` synthesises a session whose ids are the KEY's id and whose
		// `user.role` is the api-key marker. Writing that id into `actor_user_id` is how a join
		// starts attributing machine traffic to whichever person shares the uuid.
		const keyId = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
		const actor = actorFromSession(
			sessionFor({ id: keyId, email: "", role: API_KEY_PRINCIPAL_ROLE }),
		);
		expect(actor.type).to.equal("api-key");
		expect(actor.userId).to.equal(null);
		expect(actor.ref).to.equal(keyId);
	});

	it("carries the session's address and agent when it has them", () => {
		const actor = actorFromSession(sessionFor({}, "203.0.113.7"));
		expect(actor.ipAddress).to.equal("203.0.113.7");
		expect(actor.userAgent).to.equal("Mozilla/5.0 (test)");
	});

	it("degrades a value the typed column would reject to null rather than failing the write", () => {
		// The ledger insert shares the mutation's transaction, so a 22P02 here would roll the user's
		// change back. Every value that reaches a `uuid` / `inet` column is shape-checked first.
		expect(asUuid("not-a-uuid")).to.equal(null);
		expect(asUuid(USER_ID)).to.equal(USER_ID);
		expect(asInetAddress("<script>")).to.equal(null);
		expect(asInetAddress("2001:db8::1")).to.equal("2001:db8::1");
		expect(
			actorFromSession(sessionFor({ id: "legacy-string-id" }, "not-an-ip")).ipAddress,
		).to.equal(null);
	});
});

describe("audit-log diff", () => {
	it("records the columns that moved and nothing else", () => {
		const before = { id: "x", organizationId: ORGANIZATION_ID, label: "Front desk", enabled: true };
		const after = { id: "x", organizationId: ORGANIZATION_ID, label: "Reception", enabled: true };
		expect(changedColumns(before, after)).to.deep.equal(["label"]);
		const diff = diffOf(before, after, undefined);
		expect(diff.before).to.deep.equal({ label: "Front desk" });
		expect(diff.after).to.deep.equal({ label: "Reception" });
	});

	it("never treats the row's identity or its timestamps as a change", () => {
		// `updated_at` moves on EVERY update, so including it would put one meaningless key in every
		// diff and make "did anything really change?" unanswerable at a glance.
		const before = { id: "x", organizationId: ORGANIZATION_ID, updatedAt: new Date(0) };
		const after = { id: "x", organizationId: ORGANIZATION_ID, updatedAt: new Date(1_000) };
		expect(changedColumns(before, after)).to.deep.equal([]);
		expect(diffOf(before, after, undefined).after).to.equal(null);
	});

	it("keeps a secret column's NAME and never its value", () => {
		const diff = diffOf(
			{ sipPasswordHa1: "old-digest", label: "a" },
			{ sipPasswordHa1: "new-digest", label: "a" },
			["sipPasswordHa1", "sipSecretRef"],
		);
		expect(diff.changed).to.deep.equal(["sipPasswordHa1"]);
		expect(diff.before).to.deep.equal({ sipPasswordHa1: REDACTED });
		expect(diff.after).to.deep.equal({ sipPasswordHa1: REDACTED });
		expect(JSON.stringify(diff)).to.not.contain("digest");
	});

	it("renders a create as an after-only diff of the values that are actually set", () => {
		const diff = diffOf(undefined, { id: "x", label: "Sales", callerIdName: null }, undefined);
		expect(diff.before).to.equal(null);
		// `callerIdName: null` is indistinguishable from "absent" and is left out; `id` is the
		// ledger's own `resource_ref`.
		expect(diff.after).to.deep.equal({ label: "Sales" });
	});

	it("renders a delete as a before-only diff", () => {
		const diff = diffOf({ id: "x", label: "Sales" }, undefined, undefined);
		expect(diff.before).to.deep.equal({ label: "Sales" });
		expect(diff.after).to.equal(null);
	});

	it("compares JSON-shaped values structurally, so an equal destination trio is not a change", () => {
		const trio = { destinations: [{ type: "extension", ref: "a" }] };
		expect(
			changedColumns({ ...trio }, { destinations: [{ type: "extension", ref: "a" }] }),
		).to.deep.equal([]);
	});
});

describe("AuditLogService", () => {
	function fakeTransaction(): PbxDatabaseTransaction {
		// The service only ever hands the transaction to `insertAuditLog`; the recording here is of
		// what it decided, not of the SQL Drizzle emits.
		return {} as unknown as PbxDatabaseTransaction;
	}

	it("refuses to record an unattributed mutation", async () => {
		const service = new AuditLogService();
		const input: AuditMutationInput = {
			organizationId: ORGANIZATION_ID,
			resource: { kind: "extension", tableName: "extension" } as never,
			action: "update",
			resourceRef: "x",
			after: { label: "a" },
			actor: undefined,
		};
		await service.recordMutation(fakeTransaction(), input);
		expect(service.stats).to.deep.equal({ recorded: 0, skipped: 1 });
	});
});

// ---------------------------------------------------------------------------------------------
// The threading: an actor reaches the repository on every write, and never on a read
// ---------------------------------------------------------------------------------------------

interface Recorded {
	readonly method: string;
	readonly args: readonly unknown[];
}

function fakeRuntime(): { runtime: PbxRepositoryRuntime; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const record =
		<A>(method: string, result: () => Effect.Effect<A, never>) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
			return result();
		};
	const repository = {
		list: record("list", () =>
			Effect.succeed({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
		),
		get: record("get", () => Effect.succeed({ id: "row" })),
		create: record("create", () => Effect.succeed({ row: { id: "row" }, warnings: [] })),
		update: record("update", () => Effect.succeed({ row: { id: "row" }, warnings: [] })),
		remove: record("remove", () => Effect.succeed({ row: { id: "row" }, warnings: [] })),
		listChildren: record("listChildren", () => Effect.succeed([])),
		createChild: record("createChild", () => Effect.succeed({ row: { id: "c" }, warnings: [] })),
		updateChild: record("updateChild", () => Effect.succeed({ row: { id: "c" }, warnings: [] })),
		removeChild: record("removeChild", () => Effect.succeed({ row: { id: "c" }, warnings: [] })),
		reorderChildren: record("reorderChildren", () => Effect.succeed({ row: [], warnings: [] })),
		compile: record("compile", () => Effect.succeed({} as never)),
	} as unknown as PbxRepositoryInterface;
	const layer = Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(repository)));
	return { runtime: makeTestModuleRuntime(PbxRepository, layer), calls };
}

describe("audit actor threading", () => {
	it("passes an actor as the last argument of every parent write", async () => {
		const { runtime, calls } = fakeRuntime();
		const service = new ExtensionsService(runtime, NO_LIMITS);
		const session = sessionFor();
		await service.create(session, { number: "100" });
		await service.update(session, "id", { label: "x" });
		await service.remove(session, "id");

		expect(calls.map((entry) => entry.method)).to.deep.equal(["create", "update", "remove"]);
		for (const entry of calls) {
			const actor = entry.args.at(-1) as { type: string; userId: string };
			expect(actor.type, entry.method).to.equal("user");
			expect(actor.userId, entry.method).to.equal(USER_ID);
		}
	});

	it("passes an actor on every child write, including a reorder", async () => {
		const { runtime, calls } = fakeRuntime();
		const service = new IvrMenuOptionsService(runtime);
		const session = sessionFor();
		await service.create(session, "menu", { matchValue: "1" });
		await service.update(session, "menu", "opt", { label: "x" });
		await service.remove(session, "menu", "opt");
		await service.reorder(session, "menu", ["a", "b"]);

		expect(calls.map((entry) => entry.method)).to.deep.equal([
			"createChild",
			"updateChild",
			"removeChild",
			"reorderChildren",
		]);
		for (const entry of calls) {
			expect((entry.args.at(-1) as { userId: string }).userId, entry.method).to.equal(USER_ID);
		}
	});

	it("does not attach an actor to a read", async () => {
		// A read is not a change, and a ledger that recorded one would bury the changes.
		const { runtime, calls } = fakeRuntime();
		const service = new ExtensionsService(runtime, NO_LIMITS);
		await service.list(sessionFor(), { page: 1, limit: 20 } as never);
		await service.get(sessionFor(), "id");
		expect(calls[0]?.args).to.have.length(3);
		expect(calls[1]?.args).to.have.length(3);
	});
});
