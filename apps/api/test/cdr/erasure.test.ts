import { Reflector } from "@nestjs/core";
import { expect } from "chai";
import { APP_SESSION_REQUEST_KEY } from "../../src/auth/app-session";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import { RequirePermissionsGuard } from "../../src/auth/require-permissions.guard";
import { CdrErasureController } from "../../src/cdr/erasure/erasure.controller";
import { parseErasureSubject } from "../../src/cdr/erasure/erasure.dto";
import { erasureHash } from "../../src/cdr/erasure/erasure.repository";
import { CdrErasureService } from "../../src/cdr/erasure/erasure.service";
import type { AuthService, ResolvedAccess } from "../../src/auth/auth.service";
import type { OrganizationSuspensionService } from "../../src/auth/organization-suspension.service";
import type {
	ErasureAudit,
	ErasureAuditEntry,
	VoicemailErasure,
} from "../../src/cdr/erasure/erasure-ports";
import type { ObjectStore } from "../../src/storage";
import type { ExecutionContext, HttpException } from "@nestjs/common";
import type { AppSession, Permission } from "@optimiq-voice/auth";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * `POST /api/v1/erasure{,/preview}` — the right to be forgotten, minus two databases.
 *
 * Everything worth proving here is about what the endpoint does NOT do. That a preview counts and
 * changes nothing, because it is the screen an operator reads immediately before an irreversible
 * action and a preview with a side effect would make the confirmation dialog a lie. That an apply
 * removes the object BEFORE the row in both stores, because the inverse leaves audio in a bucket
 * that the API says is deleted. That the call leg survives with a hashed number rather than being
 * deleted, because the invoice raised from it must still reconcile. That a second apply finds
 * nothing — not by remembering, but because the predicate no longer matches what it rewrote. That
 * every statement names the caller's organization, so an erasure is never cross-tenant. And that
 * both routes, preview included, sit behind `recordings.delete`.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORG = "019fd3c2-aaaa-76be-a6b3-b0f1914e39b6";
const USER = "019fd3c2-9999-76be-a6b3-b0f1914e39b6";
const NUMBER = "+12125550100";

function sessionFor(organizationId = ORG): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: organizationId,
		},
		user: { id: USER, email: "u@test", name: "U", emailVerified: true },
	} as AppSession;
}

interface ExecutedStatement {
	readonly scope: "tenant" | "admin";
	readonly text: string;
}

/**
 * A CDR client whose two principals answer scripted lists and record what they were asked.
 *
 * The scopes are kept apart on purpose: which statement ran under `withTenantScope` and which ran
 * on `adminDb` is a security property of this service — the leg rewrite CANNOT run under the tenant
 * role, and nothing else may leave it — so a fake that flattened them could not express it.
 */
function fakeDatabase(script: { tenant?: readonly unknown[]; admin?: readonly unknown[] }): {
	readonly database: CdrDatabaseClient;
	readonly statements: ExecutedStatement[];
} {
	const statements: ExecutedStatement[] = [];
	let tenantIndex = 0;
	let adminIndex = 0;
	const record = (scope: "tenant" | "admin", query: unknown): void => {
		statements.push({
			scope,
			text: JSON.stringify((query as { queryChunks?: unknown }).queryChunks ?? query),
		});
	};
	const database = {
		withTenantScope: async (organizationId: string, run: (t: unknown) => Promise<unknown>) => {
			const transaction = {
				execute: async (query: unknown) => {
					record("tenant", query);
					const result = (script.tenant ?? [])[tenantIndex] ?? [];
					tenantIndex += 1;
					return await Promise.resolve(result);
				},
				organizationId,
			};
			return await run(transaction);
		},
		adminDb: {
			execute: async (query: unknown) => {
				record("admin", query);
				const result = (script.admin ?? [])[adminIndex] ?? [];
				adminIndex += 1;
				return await Promise.resolve(result);
			},
		},
	} as unknown as CdrDatabaseClient;
	return { database, statements };
}

function fakeStore(refuse: readonly string[] = []): ObjectStore & { readonly deleted: string[] } {
	const deleted: string[] = [];
	return {
		driver: "local",
		deleted,
		delete: async (objectKey: string) => {
			if (refuse.includes(objectKey)) {
				throw new Error("the bucket is unreachable");
			}
			deleted.push(objectKey);
			await Promise.resolve();
		},
	} as unknown as ObjectStore & { readonly deleted: string[] };
}

/** The voicemail port, recorded call by call. Lives in the other database; here it is a stub. */
function fakeVoicemail(messages: number): VoicemailErasure & {
	readonly erased: number[];
	readonly counted: number;
} {
	const state = { counted: 0, remaining: messages };
	const erased: number[] = [];
	return {
		erased,
		get counted() {
			return state.counted;
		},
		count: async () => {
			state.counted += 1;
			return await Promise.resolve(state.remaining);
		},
		erase: async () => {
			const went = state.remaining;
			state.remaining = 0;
			erased.push(went);
			return await Promise.resolve({ messages: went, objects: went });
		},
	};
}

function fakeAudit(): ErasureAudit & { readonly entries: ErasureAuditEntry[] } {
	const entries: ErasureAuditEntry[] = [];
	return {
		entries,
		recordErasure: async (_organizationId, entry) => {
			entries.push(entry);
			await Promise.resolve();
		},
	};
}

function recording(id: string, key: string): Record<string, string> {
	return { id, object_key: key };
}

describe("erasure — preview", () => {
	it("counts recordings, voicemail and legs without touching an object or a row", async () => {
		const { database, statements } = fakeDatabase({
			tenant: [
				[recording("r1", `${ORG}/c1/r1.wav`), recording("r2", `${ORG}/c1/r2.wav`)],
				[{ count: 3 }],
			],
		});
		const store = fakeStore();
		const voicemail = fakeVoicemail(1);
		const service = new CdrErasureService(database, store, voicemail, fakeAudit());

		const result = await service.preview(sessionFor(), { phoneNumber: NUMBER });

		expect(result.data).to.deep.equal({
			recordings: 2,
			voicemailMessages: 1,
			callLegs: 3,
			objects: 3,
		});
		expect(store.deleted).to.deep.equal([]);
		expect(voicemail.erased).to.deep.equal([]);
		// Two statements, both reads, both under the tenant scope. An `update` or a `delete` here —
		// or anything at all on `adminDb` — is the bug this case exists for.
		expect(statements).to.have.length(2);
		for (const statement of statements) {
			expect(statement.scope).to.equal("tenant");
			expect(statement.text).to.not.contain("update");
			expect(statement.text).to.not.contain("delete from");
		}
	});

	it("scopes every statement to the caller's organization", async () => {
		const { database, statements } = fakeDatabase({ tenant: [[], [{ count: 0 }]] });
		const service = new CdrErasureService(database, fakeStore(), fakeVoicemail(0), fakeAudit());

		await service.preview(sessionFor(OTHER_ORG), { phoneNumber: NUMBER });

		// RLS would already filter these, and the predicate is still in every statement — because the
		// apply's leg rewrite runs where RLS does not, and a family of statements where only some
		// carry the tenant is one a reviewer has to check row by row.
		for (const statement of statements) {
			expect(statement.text).to.contain(OTHER_ORG);
			expect(statement.text).to.not.contain(ORG);
		}
	});
});

describe("erasure — apply", () => {
	it("deletes the object before it tombstones the row, and keeps the leg", async () => {
		const { database, statements } = fakeDatabase({
			tenant: [[recording("r1", `${ORG}/c1/r1.wav`)], [{ id: "r1" }]],
			admin: [[{ id: "leg-1" }, { id: "leg-2" }]],
		});
		const store = fakeStore();
		const audit = fakeAudit();
		const service = new CdrErasureService(database, store, fakeVoicemail(2), audit);

		const result = await service.apply(sessionFor(), { phoneNumber: NUMBER });

		expect(result.data).to.deep.equal({
			recordings: 1,
			voicemailMessages: 2,
			callLegs: 2,
			objects: 3,
		});
		expect(store.deleted).to.deep.equal([`${ORG}/c1/r1.wav`]);

		// Worklist, then the tombstone, then the leg rewrite. The SELECT is first and the object was
		// gone before the UPDATE ran — a service that marked rows before deleting would show it here.
		expect(statements.map((statement) => statement.scope)).to.deep.equal([
			"tenant",
			"tenant",
			"admin",
		]);
		expect(statements[1]?.text).to.contain("deleted_at");
		const rewrite = statements[2]?.text ?? "";
		expect(rewrite).to.contain("call_legs");
		// The row survives: an UPDATE, never a DELETE, so the month's billable leg count is unchanged.
		expect(rewrite).to.contain("update");
		expect(rewrite).to.not.contain("delete from");
		expect(rewrite).to.contain(erasureHash(NUMBER));
		for (const column of [
			"from_name",
			"sip_call_id",
			"account_code",
			"remote_media_address",
			"raw",
		]) {
			expect(rewrite).to.contain(column);
		}
	});

	it("leaves a recording live when its object could not be removed", async () => {
		const { database } = fakeDatabase({
			tenant: [
				[recording("r1", "keeps/failing.wav"), recording("r2", "goes/away.wav")],
				[{ id: "r2" }],
			],
			admin: [[]],
		});
		const store = fakeStore(["keeps/failing.wav"]);
		const service = new CdrErasureService(database, store, fakeVoicemail(0), fakeAudit());

		const result = await service.apply(sessionFor(), { phoneNumber: NUMBER });

		// One tombstoned, one still playable and still selected by the same predicate. Reporting the
		// refused one as erased while its audio is in the bucket is the outcome this must never have.
		expect(result.data.recordings).to.equal(1);
		expect(result.data.objects).to.equal(1);
		expect(store.deleted).to.deep.equal(["goes/away.wav"]);
	});

	it("reports zeroes on a second apply, because nothing still matches", async () => {
		const { database, statements } = fakeDatabase({
			tenant: [[recording("r1", `${ORG}/c1/r1.wav`)], [{ id: "r1" }], [], []],
			admin: [[{ id: "leg-1" }], []],
		});
		const store = fakeStore();
		const voicemail = fakeVoicemail(1);
		const service = new CdrErasureService(database, store, voicemail, fakeAudit());
		const subject = { phoneNumber: NUMBER };

		const first = await service.apply(sessionFor(), subject);
		const second = await service.apply(sessionFor(), subject);

		expect(first.data).to.deep.equal({
			recordings: 1,
			voicemailMessages: 1,
			callLegs: 1,
			objects: 2,
		});
		expect(second.data).to.deep.equal({
			recordings: 0,
			voicemailMessages: 0,
			callLegs: 0,
			objects: 0,
		});
		// Nothing was deleted twice, and the second pass skipped the tombstone statement entirely:
		// an empty worklist is not an UPDATE with no rows, it is no UPDATE.
		expect(store.deleted).to.deep.equal([`${ORG}/c1/r1.wav`]);
		expect(statements.filter((statement) => statement.scope === "tenant")).to.have.length(3);
	});

	it("never names an organization but the caller's", async () => {
		const { database, statements } = fakeDatabase({
			tenant: [[recording("r1", `${OTHER_ORG}/c1/r1.wav`)], [{ id: "r1" }]],
			admin: [[{ id: "leg-1" }]],
		});
		const service = new CdrErasureService(database, fakeStore(), fakeVoicemail(0), fakeAudit());

		await service.apply(sessionFor(OTHER_ORG), { phoneNumber: NUMBER });

		// The leg rewrite especially: it runs on `adminDb`, where RLS is not the filter and the
		// predicate is the entire tenancy boundary.
		const rewrite = statements.find((statement) => statement.scope === "admin");
		expect(rewrite?.text).to.contain(OTHER_ORG);
		expect(rewrite?.text).to.not.contain(ORG);
	});

	it("records the honoured request with the subject hashed, never the number", async () => {
		const { database } = fakeDatabase({
			tenant: [[recording("r1", `${ORG}/c1/r1.wav`)], [{ id: "r1" }]],
			admin: [[{ id: "leg-1" }]],
		});
		const audit = fakeAudit();
		const service = new CdrErasureService(database, fakeStore(), fakeVoicemail(0), audit);

		await service.apply(sessionFor(), { phoneNumber: NUMBER });

		expect(audit.entries).to.have.length(1);
		const entry = audit.entries[0];
		expect(entry?.selector).to.equal("phoneNumber");
		expect(entry?.subjectHash).to.equal(erasureHash(NUMBER));
		expect(entry?.subjectHash).to.not.contain(NUMBER);
		expect(entry?.callLegs).to.equal(1);
		expect(entry?.actorUserId).to.equal(USER);
	});

	it("still erases when there is no ledger to write to", async () => {
		const { database } = fakeDatabase({
			tenant: [[recording("r1", `${ORG}/c1/r1.wav`)], [{ id: "r1" }]],
			admin: [[{ id: "leg-1" }]],
		});
		const store = fakeStore();
		// No audit port and no voicemail port: a CDR-only deployment. Refusing a legal erasure
		// because the ledger is unreachable would be the tail wagging the dog.
		const service = new CdrErasureService(database, store);

		const result = await service.apply(sessionFor(), { phoneNumber: NUMBER });

		expect(result.data.recordings).to.equal(1);
		expect(result.data.voicemailMessages).to.equal(0);
		expect(store.deleted).to.have.length(1);
	});
});

describe("erasure — the selector", () => {
	it("refuses a body naming both, and says which two it saw", () => {
		let body: Record<string, unknown> | undefined;
		try {
			parseErasureSubject({ phoneNumber: NUMBER, extension: "1001" });
		} catch (error) {
			body = (error as HttpException).getResponse() as Record<string, unknown>;
		}
		expect(body?.statusCode).to.equal(400);
		expect(body?.code).to.equal("CDR_ERASURE_SELECTOR");
		expect(body?.supplied).to.deep.equal(["phoneNumber", "extension"]);
	});

	it("refuses a body naming neither", () => {
		let status = 0;
		try {
			parseErasureSubject({});
		} catch (error) {
			status = (error as HttpException).getStatus();
		}
		expect(status).to.equal(400);
	});

	it("normalises the number, and refuses one that is not E.164", () => {
		expect(parseErasureSubject({ phoneNumber: "+1 (212) 555-0100" })).to.deep.equal({
			phoneNumber: NUMBER,
		});
		let code: unknown;
		try {
			parseErasureSubject({ phoneNumber: "5550100" });
		} catch (error) {
			code = ((error as HttpException).getResponse() as Record<string, unknown>).code;
		}
		// A bare national number is a field error, not a selector error: the form can highlight it.
		expect(code).to.equal("PBX_INVALID_BODY");
	});

	it("accepts an extension on its own", () => {
		expect(parseErasureSubject({ extension: "1001" })).to.deep.equal({ extension: "1001" });
	});
});

describe("erasure — authorization", () => {
	function guardFor(
		handler: (...args: never[]) => unknown,
		permissions: readonly string[],
	): { guard: RequirePermissionsGuard; context: ExecutionContext } {
		const request: Record<string, unknown> = { [APP_SESSION_REQUEST_KEY]: sessionFor() };
		const context = {
			getHandler: () => handler,
			getClass: () => CdrErasureController,
			switchToHttp: () => ({ getRequest: () => request }),
		} as unknown as ExecutionContext;
		const access: ResolvedAccess = {
			organizationId: ORG,
			role: "member",
			permissions: permissions as Permission[],
		};
		const authService = { resolveAccess: async () => access } as unknown as AuthService;
		const suspension = {
			isSuspended: async () => false,
		} as unknown as OrganizationSuspensionService;
		return {
			guard: new RequirePermissionsGuard(new Reflector(), authService, suspension),
			context,
		};
	}

	it("declares `recordings.delete` on both routes, the preview included", () => {
		for (const handler of [
			CdrErasureController.prototype.preview,
			CdrErasureController.prototype.apply,
		]) {
			expect(Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA, handler)).to.deep.equal([
				"recordings.delete",
			]);
		}
	});

	it("refuses a preview from a caller who may read and download but not delete", async () => {
		// The exact caller the permission choice is about: a preview is a count of a named third
		// party's personal data, which is not a read of anything the caller owns.
		const { guard, context } = guardFor(CdrErasureController.prototype.preview, [
			"recordings.read",
			"recordings.download",
			"recordings.configure",
		]);
		let refused = false;
		try {
			await guard.canActivate(context);
		} catch {
			refused = true;
		}
		expect(refused).to.equal(true);
	});

	it("admits a caller holding `recordings.delete`", async () => {
		const { guard, context } = guardFor(CdrErasureController.prototype.apply, [
			"recordings.delete",
		]);
		expect(await guard.canActivate(context)).to.equal(true);
	});
});
