import { expect } from "chai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTestModuleRuntime } from "@optimiq-voice/effect-runtime";
import { ExtensionFeatureRpcController } from "../../src/pbx/extensions/extension-feature-rpc.controller";
import { ExtensionFeatureService } from "../../src/pbx/extensions/extension-feature.service";
import { PbxEntityNotFoundFailure } from "../../src/pbx/shared/pbx.errors";
import { PbxRepository } from "../../src/pbx/shared/pbx.repository";
import type { ExtensionFeatureRow } from "../../src/pbx/extensions/extension-feature.service";
import type { PbxRepositoryRuntime } from "../../src/pbx/shared/pbx-runtime";
import type { PbxRepositoryInterface } from "../../src/pbx/shared/pbx.repository";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * `rpc.pbx.v1.extension-feature` — the responder behind `*72`, `*74`, `*76`, `*78` and `*21`.
 *
 * This is the only write the engine makes, and it arrives over a broker with an extension NUMBER
 * rather than a session. What a first responder can get wrong, none of which needs a database:
 *
 *  1. **The claim.** An unknown number, a disabled extension and another tenant's extension must all
 *     be refused, and refused the same way — the handset is never told which, because the difference
 *     is a way to enumerate a tenant's extensions over a phone line.
 *  2. **Toggle semantics.** `enabled: false` writes the FLAG and nothing else, because the stored
 *     destination is what makes a bare `*72` a toggle rather than a re-typing exercise.
 *  3. **Enabling with nowhere to go.** A forward switched on beside a NULL destination compiles to a
 *     phone that stops ringing and gives no signal that it has, so it is refused.
 *  4. **Nothing throws.** Every failure — including a rolled-back compile — comes back as
 *     `applied: false`, because a caller who hears silence assumes forwarding is on.
 *
 * The write itself goes through `PbxRepository.update`, which is what carries compile-on-write, the
 * ledger row and the artifact publish. That the repository does those things is
 * `pbxResourceService.test.ts`'s and `verify-pbx.ts`'s subject; what is asserted here is that this
 * service goes through it rather than around it, and with which values.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const EXTENSION_ID = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";

function extensionRow(overrides: Partial<ExtensionFeatureRow> = {}): ExtensionFeatureRow {
	return {
		id: EXTENSION_ID,
		number: "1001",
		enabled: true,
		doNotDisturb: false,
		forwardAllEnabled: false,
		forwardAllDestination: null,
		forwardBusyEnabled: false,
		forwardBusyDestination: null,
		forwardNoAnswerEnabled: false,
		forwardNoAnswerDestination: null,
		followMe: null,
		...overrides,
	};
}

/**
 * A database that hands back one row, and remembers the tenant it was scoped to.
 *
 * `withTenantScope` is faked rather than stubbed per-query, on the same terms as
 * `queueAgentSession.test.ts`: the service issues one read, and asserting on its SQL would be
 * asserting on Drizzle. The tenancy claim these specs make is about the ARGUMENT — RLS is what
 * filters, and proving the right organization was published is proving the filter was right.
 */
function fakeDatabase(row: ExtensionFeatureRow | undefined): {
	database: PbxDatabaseClient;
	scopes: string[];
} {
	const scopes: string[] = [];
	const transaction = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => (row === undefined ? [] : [row]),
				}),
			}),
		}),
	};
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
	readonly id: string;
	readonly values: Record<string, unknown>;
}

/** A repository whose `update` records what it was asked for and answers with the merged row. */
function fakeRuntime(
	row: ExtensionFeatureRow,
	behaviour: "succeeds" | "fails" = "succeeds",
): { runtime: PbxRepositoryRuntime; updates: RecordedUpdate[] } {
	const updates: RecordedUpdate[] = [];
	const repository = {
		update: (
			organizationId: string,
			_resource: unknown,
			id: string,
			values: Record<string, unknown>,
		) => {
			updates.push({ organizationId, id, values });
			return behaviour === "fails"
				? Effect.fail(new PbxEntityNotFoundFailure({ kind: "extension", id }))
				: Effect.succeed({ row: { ...row, ...values }, warnings: [] });
		},
	} as unknown as PbxRepositoryInterface;
	const layer = Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(repository)));
	return { runtime: makeTestModuleRuntime(PbxRepository, layer), updates };
}

function serviceFor(
	row: ExtensionFeatureRow | undefined,
	behaviour: "succeeds" | "fails" = "succeeds",
) {
	const { database, scopes } = fakeDatabase(row);
	const { runtime, updates } = fakeRuntime(row ?? extensionRow(), behaviour);
	return {
		service: new ExtensionFeatureService(database, runtime),
		scopes,
		updates,
	};
}

describe("ExtensionFeatureService", () => {
	describe("resolving the claimed extension", () => {
		it("resolves the number inside the request's own tenant scope", async () => {
			const { service, scopes } = serviceFor(extensionRow());
			await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "1001",
				feature: "do-not-disturb",
				enabled: true,
			});
			expect(scopes).to.deep.equal([ORG]);
		});

		it("refuses an unknown number without writing anything", async () => {
			const { service, updates } = serviceFor(undefined);
			const reply = await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "9999",
				feature: "forward-all",
				enabled: true,
				destination: "+15559990000",
			});

			expect(reply.applied).to.equal(false);
			expect(reply.enabled).to.equal(false);
			expect(reply.reason).to.contain("no enabled extension 9999");
			expect(updates).to.have.length(0);
		});

		it("refuses a DISABLED extension the same way it refuses an unknown one", async () => {
			// Same refusal, deliberately: a caller who could tell the two apart could enumerate a
			// tenant's extensions from a handset. A disabled extension is also not in the compiled
			// artifact, so writing its flag would recompile a tenant for a row no call can reach.
			const { service, updates } = serviceFor(extensionRow({ enabled: false }));
			const reply = await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "1001",
				feature: "do-not-disturb",
				enabled: true,
			});

			expect(reply.applied).to.equal(false);
			expect(reply.reason).to.contain("no enabled extension 1001");
			expect(updates).to.have.length(0);
		});

		it("refuses an extension in another tenant, because RLS answers the read with nothing", async () => {
			// A cross-tenant claim is indistinguishable from a typo by the time it reaches here: the
			// scoped read returns no row, which is exactly the fake's `undefined`.
			const { service, updates } = serviceFor(undefined);
			const reply = await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "1001",
				feature: "follow-me",
				enabled: true,
			});

			expect(reply.applied).to.equal(false);
			expect(updates).to.have.length(0);
		});
	});

	describe("toggle semantics", () => {
		it("clears the flag and LEAVES the stored destination alone", async () => {
			const { service, updates } = serviceFor(
				extensionRow({ forwardAllEnabled: true, forwardAllDestination: "+15559990000" }),
			);
			const reply = await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "1001",
				feature: "forward-all",
				enabled: false,
			});

			// The columns are a flag/destination pair precisely so this is possible. Clearing the
			// destination would make the next bare `*72` a re-typing exercise.
			expect(updates[0]?.values).to.deep.equal({ forwardAllEnabled: false });
			expect(reply.applied).to.equal(true);
			expect(reply.enabled).to.equal(false);
			expect(reply.destination).to.equal("+15559990000");
		});

		it("writes both columns when a destination is dialled after the code", async () => {
			const { service, updates } = serviceFor(
				extensionRow({ forwardAllDestination: "+15550000000" }),
			);
			const reply = await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "1001",
				feature: "forward-all",
				enabled: true,
				destination: "+15559990000",
			});

			// The sent destination OVERWRITES the stored one: the user has just named where their calls
			// go, and honouring the old number would send them elsewhere under a confirmation tone.
			expect(updates[0]?.values).to.deep.equal({
				forwardAllEnabled: true,
				forwardAllDestination: "+15559990000",
			});
			expect(reply.destination).to.equal("+15559990000");
		});

		it("reuses the stored destination when the code was dialled alone", async () => {
			const { service, updates } = serviceFor(
				extensionRow({ forwardBusyDestination: "+15551112222" }),
			);
			await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "1001",
				feature: "forward-busy",
				enabled: true,
			});

			expect(updates[0]?.values).to.deep.equal({
				forwardBusyEnabled: true,
				forwardBusyDestination: "+15551112222",
			});
		});

		it("refuses to switch forwarding on with nowhere to send the calls", async () => {
			const { service, updates } = serviceFor(extensionRow());
			const reply = await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "1001",
				feature: "forward-no-answer",
				enabled: true,
			});

			// The alternative is a phone that stops ringing and gives no signal that it has.
			expect(reply.applied).to.equal(false);
			expect(reply.reason).to.contain("none is stored");
			expect(updates).to.have.length(0);
		});

		it("writes do-not-disturb as a plain flag and ignores a stray destination", async () => {
			const { service, updates } = serviceFor(extensionRow());
			await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "1001",
				feature: "do-not-disturb",
				enabled: true,
				destination: "+15559990000",
			});

			expect(updates[0]?.values).to.deep.equal({ doNotDisturb: true });
		});

		it("flips follow-me's switch without touching the hops it is configured with", async () => {
			const targets = [{ destination: "+15551112222", delaySeconds: 0, timeoutSeconds: 20 }];
			const { service, updates } = serviceFor(
				extensionRow({ followMe: { enabled: false, targets } }),
			);
			const reply = await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "1001",
				feature: "follow-me",
				enabled: true,
			});

			expect(updates[0]?.values).to.deep.equal({ followMe: { enabled: true, targets } });
			expect(reply.enabled).to.equal(true);
		});

		it("refuses to switch an EMPTY follow-me ladder on", async () => {
			// A ladder replaces the plain dial, so switching an empty one on does not add hops — it
			// removes the desk phone.
			const { service, updates } = serviceFor(
				extensionRow({ followMe: { enabled: false, targets: [] } }),
			);
			const reply = await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "1001",
				feature: "follow-me",
				enabled: true,
			});

			expect(reply.applied).to.equal(false);
			expect(reply.reason).to.contain("no follow-me destinations");
			expect(updates).to.have.length(0);
		});
	});

	describe("failures answer rather than throw", () => {
		it("turns a failing write into applied:false with the state as it still stands", async () => {
			const { service } = serviceFor(
				extensionRow({ forwardAllEnabled: true, forwardAllDestination: "+15559990000" }),
				"fails",
			);
			const reply = await service.applyForBroker({
				orgId: ORG,
				extensionNumber: "1001",
				feature: "forward-all",
				enabled: false,
			});

			expect(reply.applied).to.equal(false);
			// The row is unchanged, so the reply describes the row rather than the request.
			expect(reply.enabled).to.equal(true);
			expect(reply.destination).to.equal("+15559990000");
		});
	});
});

describe("ExtensionFeatureRpcController", () => {
	it("answers a malformed request instead of letting it time out", async () => {
		const controller = new ExtensionFeatureRpcController({
			applyForBroker: async () => {
				throw new Error("the service must not be reached");
			},
		} as unknown as ExtensionFeatureService);

		const reply = await controller.apply({ orgId: "not-a-uuid", feature: "follow-me" });

		expect(reply.applied).to.equal(false);
		// The feature is read off the raw payload so a support log correlates with the code somebody
		// pressed, even when the rest of the request did not survive parsing.
		expect(reply.feature).to.equal("follow-me");
		expect(reply.reason).to.contain("orgId");
	});

	it("catches a throwing service, because a broker timeout is dead air on a live call", async () => {
		const controller = new ExtensionFeatureRpcController({
			applyForBroker: async () => {
				throw new Error("the pool is exhausted");
			},
		} as unknown as ExtensionFeatureService);

		const reply = await controller.apply({
			orgId: ORG,
			extensionNumber: "1001",
			feature: "do-not-disturb",
			enabled: true,
		});

		expect(reply.applied).to.equal(false);
		expect(reply.reason).to.contain("the pool is exhausted");
	});
});
