import { expect } from "chai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTestModuleRuntime } from "@optimiq-voice/effect-runtime";
import { HotDeskRpcController } from "../../src/pbx/extensions/hot-desk-rpc.controller";
import { HotDeskService } from "../../src/pbx/extensions/hot-desk.service";
import { PbxEntityNotFoundFailure } from "../../src/pbx/shared/pbx.errors";
import { PbxRepository } from "../../src/pbx/shared/pbx.repository";
import { hashVoicemailPin } from "../../src/pbx/voicemail-boxes/voicemail-pin.service";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { PbxRepositoryRuntime } from "../../src/pbx/shared/pbx-runtime";
import type { PbxRepositoryInterface } from "../../src/pbx/shared/pbx.repository";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * `rpc.pbx.v1.hot-desk` — the responder behind `*31` and `*32`.
 *
 * The third and last write the engine makes, and the only one that arrives carrying a CREDENTIAL.
 * What a first implementation gets wrong, none of which needs a database:
 *
 *  1. **The gate.** An extension with no `hot_desk_pin_set_id` is not hot-deskable and must be
 *     refused, and refused identically to a wrong PIN — the two are the same fact to the handset,
 *     and telling them apart over a phone line enumerates a tenant's extensions.
 *  2. **The home binding.** A login must record where the line CAME FROM, and a second login onto
 *     an already-claimed desk must not overwrite it with the previous occupant's extension. That is
 *     the whole difference between a logout that restores and a logout that guesses.
 *  3. **The credential invariant.** The rebind writes `extension_id` and `home_extension_id` and
 *     touches NOTHING that a registration resolves against — no `auth_user`, no `sip_secret_ref`.
 *     `sip-credentials.service.ts` reads the home binding, so the handset's digest username and HA1
 *     are unchanged and it never has to re-REGISTER. This is asserted on the VALUES, because it is
 *     the property that keeps a hot-desked phone on the register.
 *  4. **Nothing throws.** Every failure is `applied: false`, because a caller who hears silence has
 *     no way to know whether they are logged in.
 *
 * The write goes through `PbxRepository.updateChild`, which is what carries compile-on-write, the
 * audit row and — via the mutation seam — the SIP credential-cache eviction. That the repository
 * does those things is `pbxResourceService.test.ts`'s subject; what is asserted here is that this
 * service goes through it rather than around it, and with which values.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const DEVICE = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const LINE = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
/** The handset's own extension — where a logout must land. */
const HOME_EXT = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";
/** The agent's extension — what a login claims. */
const AGENT_EXT = "019fd3c2-5555-76be-a6b3-b0f1914e39b6";
const PIN_SET = "019fd3c2-6666-76be-a6b3-b0f1914e39b6";

const PIN = "4321";

interface LineRow {
	readonly id: string;
	readonly deviceId: string;
	readonly extensionId: string | null;
	readonly homeExtensionId: string | null;
}

interface ExtensionRow {
	readonly id: string;
	readonly number: string;
	readonly hotDeskPinSetId: string | null;
}

/**
 * A database that answers a QUEUE of results, one per `select()`.
 *
 * A queue rather than a per-query stub, on the same terms `extensionFeatureRpc.test.ts` argues: the
 * service issues three reads in a fixed order (the line, the extension, the digests) and asserting
 * on their SQL would be asserting on Drizzle. The chain is a proxy that answers every builder method
 * with itself and resolves to the next queued batch, which is what lets one fake serve a query with
 * an `innerJoin` and one without.
 */
function fakeDatabase(batches: readonly (readonly unknown[])[]): {
	database: PbxDatabaseClient;
	scopes: string[];
} {
	const scopes: string[] = [];
	const pending = [...batches];
	const chain = (): unknown => {
		const rows = pending.shift() ?? [];
		const proxy: unknown = new Proxy(
			{},
			{
				get: (_target, property) => {
					if (property === "then") {
						return (resolve: (value: readonly unknown[]) => unknown) => resolve(rows);
					}
					return () => proxy;
				},
			},
		);
		return proxy;
	};
	const transaction = { select: () => chain() };
	const database = {
		withTenantScope: async <T>(
			organizationId: string,
			work: (tx: never) => Promise<T>,
		): Promise<T> => {
			scopes.push(organizationId);
			return await work(transaction as never);
		},
	} as unknown as PbxDatabaseClient;
	return { database, scopes };
}

interface RecordedUpdate {
	readonly organizationId: string;
	readonly parentId: string;
	readonly id: string;
	readonly values: Record<string, unknown>;
	readonly actorRef: string | undefined;
}

function fakeRuntime(behaviour: "succeeds" | "fails" = "succeeds"): {
	runtime: PbxRepositoryRuntime;
	updates: RecordedUpdate[];
} {
	const updates: RecordedUpdate[] = [];
	const repository = {
		updateChild: (
			organizationId: string,
			_resource: unknown,
			parentId: string,
			id: string,
			values: Record<string, unknown>,
			actor?: { readonly ref?: string },
		) => {
			updates.push({ organizationId, parentId, id, values, actorRef: actor?.ref });
			return behaviour === "fails"
				? Effect.fail(new PbxEntityNotFoundFailure({ kind: "device-line", id }))
				: Effect.succeed({ row: { id, ...values }, warnings: [] });
		},
	} as unknown as PbxRepositoryInterface;
	const layer = Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(repository)));
	return { runtime: makeTestModuleRuntime(PbxRepository, layer), updates };
}

const env = {
	PBX_HOT_DESK_SESSION_SECONDS: 9 * 3600,
	PBX_HOT_DESK_SWEEP_INTERVAL_MS: 0,
} as unknown as PbxEnv;

function loginService(options: {
	readonly line?: LineRow;
	readonly extension?: ExtensionRow;
	readonly digests?: readonly string[];
	readonly behaviour?: "succeeds" | "fails";
}) {
	const batches: (readonly unknown[])[] = [
		options.line === undefined ? [] : [options.line],
		options.extension === undefined ? [] : [options.extension],
		(options.digests ?? []).map((pinHash) => ({ pinHash })),
		// The read that resolves the resulting extension's number for the reply.
		[{ number: "1104" }],
	];
	const { database, scopes } = fakeDatabase(batches);
	const { runtime, updates } = fakeRuntime(options.behaviour ?? "succeeds");
	return { service: new HotDeskService(database, runtime, env), scopes, updates };
}

describe("HotDeskService", () => {
	let digest: string;

	before(async () => {
		digest = await hashVoicemailPin(PIN);
	});

	describe("login", () => {
		const line: LineRow = {
			id: LINE,
			deviceId: DEVICE,
			extensionId: HOME_EXT,
			homeExtensionId: null,
		};
		const claimable: ExtensionRow = {
			id: AGENT_EXT,
			number: "1104",
			hotDeskPinSetId: PIN_SET,
		};

		it("rebinds the line and records where it came from", async () => {
			const { service, scopes, updates } = loginService({
				line,
				extension: claimable,
				digests: [digest],
			});
			const reply = await service.applyForBroker({
				orgId: ORG,
				action: "login",
				deviceId: DEVICE,
				extensionNumber: "1104",
				pin: PIN,
			});

			expect(reply.applied).to.equal(true);
			expect(reply.extensionNumber).to.equal("1104");
			expect(reply.expiresAt).to.be.a("string");
			expect(scopes[0]).to.equal(ORG);
			expect(updates).to.have.length(1);
			expect(updates[0].organizationId).to.equal(ORG);
			expect(updates[0].parentId).to.equal(DEVICE);
			expect(updates[0].id).to.equal(LINE);
			expect(updates[0].values.extensionId).to.equal(AGENT_EXT);
			expect(updates[0].values.homeExtensionId).to.equal(HOME_EXT);
			expect(updates[0].values.hotDeskExpiresAt).to.be.instanceOf(Date);
			expect(updates[0].actorRef).to.equal("engine.feature-code");
		});

		/**
		 * The credential invariant, asserted where it is decided. A rebind that also wrote `authUser`
		 * or `sipSecretRef` would change the digest username or the HA1, and the phone would fall off
		 * the register mid-shift.
		 */
		it("touches nothing a registration resolves against", async () => {
			const { service, updates } = loginService({
				line,
				extension: claimable,
				digests: [digest],
			});
			await service.applyForBroker({
				orgId: ORG,
				action: "login",
				deviceId: DEVICE,
				extensionNumber: "1104",
				pin: PIN,
			});

			expect(Object.keys(updates[0].values).sort()).to.deep.equal([
				"extensionId",
				"homeExtensionId",
				"hotDeskExpiresAt",
				"hotDeskLoginAt",
			]);
		});

		/**
		 * A desk somebody is already logged into. The home must stay the PHONE's own extension —
		 * taking the current binding would make the previous occupant's extension the "home", and the
		 * next logout would leave their calls ringing a desk they had walked away from.
		 */
		it("keeps the ORIGINAL home when a second agent claims the same desk", async () => {
			const { service, updates } = loginService({
				line: { ...line, extensionId: AGENT_EXT, homeExtensionId: HOME_EXT },
				extension: {
					id: "019fd3c2-7777-76be-a6b3-b0f1914e39b6",
					number: "1105",
					hotDeskPinSetId: PIN_SET,
				},
				digests: [digest],
			});
			await service.applyForBroker({
				orgId: ORG,
				action: "login",
				deviceId: DEVICE,
				extensionNumber: "1105",
				pin: PIN,
			});

			expect(updates[0].values.homeExtensionId).to.equal(HOME_EXT);
		});

		it("refuses a wrong PIN without writing anything", async () => {
			const { service, updates } = loginService({
				line,
				extension: claimable,
				digests: [digest],
			});
			const reply = await service.applyForBroker({
				orgId: ORG,
				action: "login",
				deviceId: DEVICE,
				extensionNumber: "1104",
				pin: "9999",
			});

			expect(reply.applied).to.equal(false);
			expect(updates).to.have.length(0);
		});

		/**
		 * The gate. `hot_desk_pin_set_id` NULL means "not hot-deskable", and the refusal must be
		 * indistinguishable from a wrong PIN to the handset — only the log tells them apart.
		 */
		it("refuses an extension with no hot-desk PIN set", async () => {
			const { service, updates } = loginService({
				line,
				extension: { ...claimable, hotDeskPinSetId: null },
				digests: [digest],
			});
			const reply = await service.applyForBroker({
				orgId: ORG,
				action: "login",
				deviceId: DEVICE,
				extensionNumber: "1104",
				pin: PIN,
			});

			expect(reply.applied).to.equal(false);
			expect(reply.reason).to.contain("hot-deskable");
			expect(updates).to.have.length(0);
		});

		it("refuses a device with no line to rebind", async () => {
			const { service, updates } = loginService({ extension: claimable, digests: [digest] });
			const reply = await service.applyForBroker({
				orgId: ORG,
				action: "login",
				deviceId: DEVICE,
				extensionNumber: "1104",
				pin: PIN,
			});

			expect(reply.applied).to.equal(false);
			expect(updates).to.have.length(0);
		});

		it("answers a failed write as a refusal rather than throwing", async () => {
			const { service } = loginService({
				line,
				extension: claimable,
				digests: [digest],
				behaviour: "fails",
			});
			const reply = await service.applyForBroker({
				orgId: ORG,
				action: "login",
				deviceId: DEVICE,
				extensionNumber: "1104",
				pin: PIN,
			});

			expect(reply.applied).to.equal(false);
			expect(reply.action).to.equal("login");
		});
	});

	describe("logout", () => {
		it("restores the home binding and clears the session", async () => {
			const { database, scopes } = fakeDatabase([
				[{ id: LINE, deviceId: DEVICE, extensionId: AGENT_EXT, homeExtensionId: HOME_EXT }],
				[{ number: "1001" }],
			]);
			const { runtime, updates } = fakeRuntime();
			const reply = await new HotDeskService(database, runtime, env).applyForBroker({
				orgId: ORG,
				action: "logout",
				deviceId: DEVICE,
			});

			expect(reply.applied).to.equal(true);
			expect(reply.extensionNumber).to.equal("1001");
			expect(reply.expiresAt).to.equal(undefined);
			expect(scopes[0]).to.equal(ORG);
			expect(updates[0].values).to.deep.equal({
				extensionId: HOME_EXT,
				homeExtensionId: null,
				hotDeskExpiresAt: null,
				hotDeskLoginAt: null,
			});
		});

		/**
		 * A logout from a phone nobody is logged into is APPLIED, not refused. The agent asked for the
		 * phone to be its own again and it already is; a handset that says "not available" to that
		 * teaches people to keep pressing the key.
		 */
		it("is a no-op success when the line is already on its home binding", async () => {
			const { database } = fakeDatabase([
				[{ id: LINE, deviceId: DEVICE, extensionId: HOME_EXT, homeExtensionId: null }],
				[{ number: "1001" }],
			]);
			const { runtime, updates } = fakeRuntime();
			const reply = await new HotDeskService(database, runtime, env).applyForBroker({
				orgId: ORG,
				action: "logout",
				deviceId: DEVICE,
			});

			expect(reply.applied).to.equal(true);
			expect(updates).to.have.length(0);
		});

		/** The sweeper's path, which must leave the row in exactly the state a dialled logout does. */
		it("restores under the sweeper's own actor ref", async () => {
			const { database } = fakeDatabase([[{ number: "1001" }]]);
			const { runtime, updates } = fakeRuntime();
			await new HotDeskService(database, runtime, env).restore(
				ORG,
				{ id: LINE, deviceId: DEVICE, extensionId: AGENT_EXT, homeExtensionId: HOME_EXT },
				"api.hot-desk-sweeper",
			);

			expect(updates[0].actorRef).to.equal("api.hot-desk-sweeper");
			expect(updates[0].values.homeExtensionId).to.equal(null);
		});
	});
});

describe("HotDeskRpcController", () => {
	/**
	 * Version skew across two deployables is expected, not impossible — and the reply matters more
	 * here than anywhere else on this path: a timeout leaves a handset silent, and an agent who hears
	 * nothing has no way to know whether they are logged in.
	 */
	it("answers a malformed request instead of throwing", async () => {
		const controller = new HotDeskRpcController({
			applyForBroker: async () => {
				throw new Error("must not be reached");
			},
		} as unknown as HotDeskService);

		const reply = await controller.apply({ orgId: "not-a-uuid", action: "logout" });
		expect(reply.applied).to.equal(false);
		expect(reply.action).to.equal("logout");
		expect(reply.reason).to.contain("orgId");
	});

	it("answers a thrown service as a refusal, so a defect is never a broker timeout", async () => {
		const controller = new HotDeskRpcController({
			applyForBroker: async () => {
				throw new Error("the database is on fire");
			},
		} as unknown as HotDeskService);

		const reply = await controller.apply({
			orgId: ORG,
			action: "login",
			deviceId: DEVICE,
			extensionNumber: "1104",
			pin: PIN,
		});
		expect(reply.applied).to.equal(false);
		expect(reply.reason).to.contain("the database is on fire");
	});
});
