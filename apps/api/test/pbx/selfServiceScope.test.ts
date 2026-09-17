import { ForbiddenException } from "@nestjs/common";
import { expect } from "chai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTestModuleRuntime } from "@optimiq-voice/effect-runtime";
import { ExtensionsService } from "../../src/pbx/extensions/extensions.service";
import { OrgLimitsService } from "../../src/pbx/org-limits/org-limits.service";
import { PbxRepository } from "../../src/pbx/shared/pbx.repository";
import {
	assertOwnsRow,
	holdsUnscoped,
	ownedDeviceIds,
	ownedExtensionIds,
	ownedVoicemailBoxIds,
	SelfServiceScopeForbiddenException,
} from "../../src/pbx/shared/self-ownership";
import type { PbxRepositoryRuntime } from "../../src/pbx/shared/pbx-runtime";
import type { PbxRepositoryInterface } from "../../src/pbx/shared/pbx.repository";
import type { AppSession, Permission } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The `.own` narrowing — owner passes, non-owner 403, unscoped holder sees everything.
 *
 * This is the enforcement half of the fix `permissionEnforcement.test.ts` documents: the six scoped
 * self-service grants (`extensions.read.own`/`write.own`, `devices.read.own`,
 * `voicemail.read.own`/`delete.own`/`listen.own`) are now a ROW check in the service, exactly the
 * shape `queue-agent-session.service.ts` set. The database is faked the way the rest of the area
 * fakes it (`sipCredentials.test.ts`): a `withTenantScope` that answers a queue of result sets in
 * the order the code issues its selects. The repository is faked so `super.list`/`super.get` are
 * observable without SQL — the claim is the narrowing decision, not the Drizzle.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const USER = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const MY_EXTENSION = "019fd3c2-aaaa-7000-8000-000000000001";
const OTHER_EXTENSION = "019fd3c2-bbbb-7000-8000-000000000002";

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

/** A database whose every tenant-scoped select dequeues the next queued result set, in order. */
function fakeDatabase(...resultSets: readonly unknown[][]): PbxDatabaseClient {
	const queue = [...resultSets];
	const next = (): unknown[] => queue.shift() ?? [];
	const chain = (): Record<string, unknown> => {
		const self: Record<string, unknown> = {};
		self.from = () => self;
		self.where = async () => next();
		return self;
	};
	const tx = {
		select: () => chain(),
		selectDistinct: () => chain(),
	};
	return {
		withTenantScope: async <T>(_organizationId: string, work: (t: never) => Promise<T>) =>
			await work(tx as never),
	} as unknown as PbxDatabaseClient;
}

interface FakeRepo {
	readonly runtime: PbxRepositoryRuntime;
	readonly listArgs: unknown[][];
}

/** A repository that records `list` calls (so the 4th `restrictToIds` argument is observable). */
function fakeRepository(rows: readonly Record<string, unknown>[]): FakeRepo {
	const listArgs: unknown[][] = [];
	const repository = {
		list: (...args: unknown[]) => {
			listArgs.push(args);
			return Effect.succeed({
				data: rows,
				total: rows.length,
				page: 1,
				limit: 20,
				totalPages: rows.length === 0 ? 0 : 1,
			});
		},
		get: () => Effect.succeed({ id: "row" }),
		create: () => Effect.succeed({ row: { id: "row" }, warnings: [] }),
		update: () => Effect.succeed({ row: { id: "row" }, warnings: [] }),
		remove: () => Effect.succeed({ row: { id: "row" }, warnings: [] }),
		listChildren: () => Effect.succeed([]),
		createChild: () => Effect.succeed({ row: { id: "c" }, warnings: [] }),
		updateChild: () => Effect.succeed({ row: { id: "c" }, warnings: [] }),
		removeChild: () => Effect.succeed({ row: { id: "c" }, warnings: [] }),
		compile: () => Effect.succeed({} as never),
	} as unknown as PbxRepositoryInterface;
	const layer = Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(repository)));
	return { runtime: makeTestModuleRuntime(PbxRepository, layer), listArgs };
}

const NO_LIMITS = { assertMayCreate: async () => undefined } as unknown as OrgLimitsService;

describe("self-ownership helpers", () => {
	it("SelfServiceScopeForbiddenException is a 403 with a code", () => {
		const error = new SelfServiceScopeForbiddenException("nope");
		expect(error).to.be.instanceOf(ForbiddenException);
		expect(error.getStatus()).to.equal(403);
		expect((error.getResponse() as { code: string }).code).to.equal("SELF_SERVICE_SCOPE_FORBIDDEN");
	});

	it("holdsUnscoped reads the unscoped grant off the session", () => {
		expect(holdsUnscoped(sessionWith(["extensions.read"]), "extensions.read")).to.equal(true);
		expect(holdsUnscoped(sessionWith(["extensions.read.own"]), "extensions.read")).to.equal(false);
	});

	it("assertOwnsRow passes an owned id and 403s an unowned one", () => {
		expect(() => assertOwnsRow([MY_EXTENSION], MY_EXTENSION, "x")).to.not.throw();
		expect(() => assertOwnsRow([MY_EXTENSION], OTHER_EXTENSION, "x")).to.throw(
			SelfServiceScopeForbiddenException,
		);
	});

	it("ownedExtensionIds returns the linked extension ids", async () => {
		const db = fakeDatabase([{ extensionId: MY_EXTENSION }]);
		expect(await ownedExtensionIds(db, ORG, USER)).to.deep.equal([MY_EXTENSION]);
	});

	it("ownedVoicemailBoxIds resolves boxes through the owned extensions", async () => {
		// First select → the owned extension; second → the boxes on it.
		const db = fakeDatabase([{ extensionId: MY_EXTENSION }], [{ id: "box-1" }]);
		expect(await ownedVoicemailBoxIds(db, ORG, USER)).to.deep.equal(["box-1"]);
	});

	it("ownedVoicemailBoxIds short-circuits to empty when the user owns no extension", async () => {
		const db = fakeDatabase([]); // no owned extensions → no second query
		expect(await ownedVoicemailBoxIds(db, ORG, USER)).to.deep.equal([]);
	});

	it("ownedDeviceIds resolves devices through the owned extensions' lines", async () => {
		const db = fakeDatabase([{ extensionId: MY_EXTENSION }], [{ deviceId: "dev-1" }]);
		expect(await ownedDeviceIds(db, ORG, USER)).to.deep.equal(["dev-1"]);
	});
});

describe("ExtensionsService — .own narrowing", () => {
	it("an unscoped extensions.read holder lists the whole org (no restriction)", async () => {
		const { runtime, listArgs } = fakeRepository([{ id: OTHER_EXTENSION }]);
		const service = new ExtensionsService(runtime, NO_LIMITS, fakeDatabase());
		await service.list(sessionWith(["extensions.read"]), { page: 1, limit: 20 } as never);
		expect(listArgs).to.have.length(1);
		// The 4th argument (restrictToIds) is absent on the unscoped path.
		expect(listArgs[0]?.[3]).to.equal(undefined);
	});

	it("a .own holder's list is restricted to the extensions they own", async () => {
		const { runtime, listArgs } = fakeRepository([{ id: MY_EXTENSION }]);
		const service = new ExtensionsService(
			runtime,
			NO_LIMITS,
			fakeDatabase([{ extensionId: MY_EXTENSION }]),
		);
		await service.list(sessionWith(["extensions.read.own"]), { page: 1, limit: 20 } as never);
		expect(listArgs).to.have.length(1);
		expect(listArgs[0]?.[3]).to.deep.equal([MY_EXTENSION]);
	});

	it("a .own holder who owns nothing gets an empty page and never queries the repository", async () => {
		const { runtime, listArgs } = fakeRepository([{ id: "unreachable" }]);
		const service = new ExtensionsService(runtime, NO_LIMITS, fakeDatabase([]));
		const result = await service.list(sessionWith(["extensions.read.own"]), {
			page: 1,
			limit: 20,
		} as never);
		expect(result.data).to.deep.equal([]);
		expect(result.total).to.equal(0);
		expect(listArgs).to.have.length(0);
	});

	it("a .own holder may GET their own extension", async () => {
		const { runtime } = fakeRepository([]);
		const service = new ExtensionsService(
			runtime,
			NO_LIMITS,
			fakeDatabase([{ extensionId: MY_EXTENSION }]),
		);
		const result = await service.get(sessionWith(["extensions.read.own"]), MY_EXTENSION);
		expect(result).to.deep.equal({ data: { id: "row" } });
	});

	it("a .own holder is 403'd on GET of an extension they do not own", async () => {
		const { runtime } = fakeRepository([]);
		const service = new ExtensionsService(
			runtime,
			NO_LIMITS,
			fakeDatabase([{ extensionId: MY_EXTENSION }]),
		);
		let thrown: unknown;
		try {
			await service.get(sessionWith(["extensions.read.own"]), OTHER_EXTENSION);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(SelfServiceScopeForbiddenException);
	});

	it("a .own holder may edit forwarding on their own extension", async () => {
		const { runtime } = fakeRepository([]);
		const service = new ExtensionsService(
			runtime,
			NO_LIMITS,
			fakeDatabase([{ extensionId: MY_EXTENSION }]),
		);
		const result = await service.update(sessionWith(["extensions.write.own"]), MY_EXTENSION, {
			forwardAllEnabled: true,
			forwardAllDestination: "2000",
			doNotDisturb: true,
		});
		expect(result.warnings).to.deep.equal([]);
	});

	it("a .own holder cannot change a privileged field on their own extension (tollClass)", async () => {
		const { runtime } = fakeRepository([]);
		const service = new ExtensionsService(
			runtime,
			NO_LIMITS,
			fakeDatabase([{ extensionId: MY_EXTENSION }]),
		);
		let thrown: unknown;
		try {
			await service.update(sessionWith(["extensions.write.own"]), MY_EXTENSION, {
				tollClass: "international",
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(SelfServiceScopeForbiddenException);
	});

	it("a .own holder is 403'd editing an extension they do not own", async () => {
		const { runtime } = fakeRepository([]);
		const service = new ExtensionsService(
			runtime,
			NO_LIMITS,
			fakeDatabase([{ extensionId: MY_EXTENSION }]),
		);
		let thrown: unknown;
		try {
			await service.update(sessionWith(["extensions.write.own"]), OTHER_EXTENSION, {
				doNotDisturb: true,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(SelfServiceScopeForbiddenException);
	});

	it("an unscoped extensions.write holder may change any field on any extension", async () => {
		const { runtime } = fakeRepository([]);
		const service = new ExtensionsService(runtime, NO_LIMITS, fakeDatabase());
		const result = await service.update(sessionWith(["extensions.write"]), OTHER_EXTENSION, {
			tollClass: "international",
		});
		expect(result.warnings).to.deep.equal([]);
	});
});
