import { HttpException, NotFoundException } from "@nestjs/common";
import { expect } from "chai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MissingActiveOrganizationError } from "@optimiq-voice/auth";
import { makeTestModuleRuntime } from "@optimiq-voice/effect-runtime";
import { ExtensionsService } from "../../src/pbx/extensions/extensions.service";
import { IvrMenuOptionsService } from "../../src/pbx/ivr-menus/ivr-menus.service";
import {
	PagingGroupMembersService,
	PagingGroupsService,
} from "../../src/pbx/paging-groups/paging-groups.service";
import {
	PbxEntityNotFoundFailure,
	PbxEntityReferencedFailure,
	RoutingCompileFailure,
} from "../../src/pbx/shared/pbx.errors";
import { PbxRepository } from "../../src/pbx/shared/pbx.repository";
import type { PbxRepositoryRuntime } from "../../src/pbx/shared/pbx-runtime";
import type { PbxRepositoryInterface } from "../../src/pbx/shared/pbx.repository";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * The services, over a fake repository.
 *
 * The point of these is the seam, not the SQL: that the tenant comes from the session and is
 * passed as the first argument, that the envelopes are shaped the way `apps/web` expects, and that
 * a typed failure crossing `runEffect` arrives as the HTTP exception it declared. The SQL is
 * `verify-pbx.ts`'s job, against a real database.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";

function sessionFor(organizationId: string | null): AppSession {
	return {
		session: {
			id: "sess",
			userId: "019fd3c2-2222-76be-a6b3-b0f1914e39b6",
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: organizationId,
		},
		user: { id: "u", email: "u@test", name: "U", emailVerified: true },
	};
}

interface Recorded {
	readonly method: string;
	readonly args: readonly unknown[];
}

function fakeRuntime(overrides: Partial<PbxRepositoryInterface>): {
	runtime: PbxRepositoryRuntime;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const record =
		<A>(method: string, result: () => Effect.Effect<A, never>) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
			return result();
		};

	const base = {
		list: record("list", () =>
			Effect.succeed({ data: [], total: 0, page: 1, limit: 20, totalPages: 0 }),
		),
		get: record("get", () => Effect.succeed({ id: "row" })),
		create: record("create", () => Effect.succeed({ row: { id: "row" }, warnings: [] })),
		update: record("update", () => Effect.succeed({ row: { id: "row" }, warnings: [] })),
		remove: record("remove", () => Effect.succeed({ row: { id: "row" }, warnings: [] })),
		listChildren: record("listChildren", () => Effect.succeed([])),
		createChild: record("createChild", () =>
			Effect.succeed({ row: { id: "child" }, warnings: [] }),
		),
		updateChild: record("updateChild", () =>
			Effect.succeed({ row: { id: "child" }, warnings: [] }),
		),
		removeChild: record("removeChild", () =>
			Effect.succeed({ row: { id: "child" }, warnings: [] }),
		),
		compile: record("compile", () => Effect.succeed({} as never)),
	} as unknown as PbxRepositoryInterface;

	const repository = { ...base, ...overrides };
	const layer = Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(repository)));
	return { runtime: makeTestModuleRuntime(PbxRepository, layer), calls };
}

describe("PbxResourceService", () => {
	it("passes the session's organization as the repository's first argument", async () => {
		const { runtime, calls } = fakeRuntime({});
		const service = new ExtensionsService(runtime);
		await service.list(sessionFor(ORGANIZATION_ID), { page: 1, limit: 20 } as never);
		expect(calls[0]?.method).to.equal("list");
		expect(calls[0]?.args[0]).to.equal(ORGANIZATION_ID);
	});

	it("passes its own resource descriptor, not one the caller chose", async () => {
		const { runtime, calls } = fakeRuntime({});
		await new ExtensionsService(runtime).get(sessionFor(ORGANIZATION_ID), "abc");
		const resource = calls[0]?.args[1] as { kind: string; tableName: string };
		expect(resource.kind).to.equal("extension");
		expect(resource.tableName).to.equal("extension");
	});

	it("refuses to act on a session with no active organization", async () => {
		const { runtime, calls } = fakeRuntime({});
		const service = new ExtensionsService(runtime);
		let thrown: unknown;
		try {
			await service.list(sessionFor(null), { page: 1, limit: 20 } as never);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(MissingActiveOrganizationError);
		expect(calls).to.have.length(0);
	});

	it("returns the paging envelope unchanged", async () => {
		const { runtime } = fakeRuntime({
			list: (() =>
				Effect.succeed({
					data: [{ id: "a" }],
					total: 41,
					page: 2,
					limit: 20,
					totalPages: 3,
				})) as never,
		});
		const result = await new ExtensionsService(runtime).list(sessionFor(ORGANIZATION_ID), {
			page: 2,
			limit: 20,
		} as never);
		expect(result).to.deep.equal({
			data: [{ id: "a" }],
			total: 41,
			page: 2,
			limit: 20,
			totalPages: 3,
		});
	});

	it("wraps a single row as { data }", async () => {
		const { runtime } = fakeRuntime({});
		const result = await new ExtensionsService(runtime).get(sessionFor(ORGANIZATION_ID), "abc");
		expect(result).to.deep.equal({ data: { id: "row" } });
	});

	it("carries compiler warnings out of a mutation with the field attached", async () => {
		const { runtime } = fakeRuntime({
			create: (() =>
				Effect.succeed({
					row: { id: "rg" },
					warnings: [
						{
							severity: "warning" as const,
							code: "empty-ring-group" as const,
							message: "no members",
							subject: { kind: "ring-group", id: "rg" },
							path: "ringGroups[0].destinations",
						},
					],
				})) as never,
		});
		const result = await new ExtensionsService(runtime).create(sessionFor(ORGANIZATION_ID), {});
		expect(result.warnings).to.have.length(1);
		expect(result.warnings[0]?.code).to.equal("empty-ring-group");
		expect(result.warnings[0]?.field).to.equal("destinations");
	});

	it("always returns a warnings array, even when there is nothing to say", async () => {
		const { runtime } = fakeRuntime({});
		const result = await new ExtensionsService(runtime).update(
			sessionFor(ORGANIZATION_ID),
			"id",
			{},
		);
		expect(result.warnings).to.deep.equal([]);
	});

	it("turns a repository failure into the HTTP exception the failure declares", async () => {
		const { runtime } = fakeRuntime({
			get: (() =>
				Effect.fail(new PbxEntityNotFoundFailure({ kind: "extension", id: "x" }))) as never,
		});
		let thrown: unknown;
		try {
			await new ExtensionsService(runtime).get(sessionFor(ORGANIZATION_ID), "x");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(NotFoundException);
	});

	it("surfaces a compile refusal as a 422 with the diagnostics", async () => {
		const { runtime } = fakeRuntime({
			create: (() =>
				Effect.fail(
					new RoutingCompileFailure({
						organizationId: ORGANIZATION_ID,
						diagnostics: [
							{
								severity: "error" as const,
								code: "dangling-destination" as const,
								message: "points at nothing",
								path: "inboundRoutes[0].destinationRef",
							},
						],
					}),
				)) as never,
		});
		let thrown: HttpException | undefined;
		try {
			await new ExtensionsService(runtime).create(sessionFor(ORGANIZATION_ID), {});
		} catch (error) {
			thrown = error as HttpException;
		}
		expect(thrown?.getStatus()).to.equal(422);
		const body = thrown?.getResponse() as Record<string, unknown>;
		expect(body.code).to.equal("ROUTING_COMPILE_FAILED");
	});

	it("surfaces a referenced-delete refusal as a 409", async () => {
		const { runtime } = fakeRuntime({
			remove: (() =>
				Effect.fail(
					new PbxEntityReferencedFailure({
						kind: "ring-group",
						id: "rg",
						references: [
							{ kind: "ivr-menu-option", id: "o", name: "Sales", field: "destination_ref" },
						],
					}),
				)) as never,
		});
		let thrown: HttpException | undefined;
		try {
			await new ExtensionsService(runtime).remove(sessionFor(ORGANIZATION_ID), "rg");
		} catch (error) {
			thrown = error as HttpException;
		}
		expect(thrown?.getStatus()).to.equal(409);
	});

	it("renders an unexpected defect as an opaque 500 reference", async () => {
		const { runtime } = fakeRuntime({
			get: (() => Effect.die(new Error("password=hunter2 leaked into the message"))) as never,
		});
		let thrown: HttpException | undefined;
		try {
			await new ExtensionsService(runtime).get(sessionFor(ORGANIZATION_ID), "x");
		} catch (error) {
			thrown = error as HttpException;
		}
		expect(thrown?.getStatus()).to.equal(500);
		const body = thrown?.getResponse() as Record<string, unknown>;
		expect(String(body.message)).to.contain("Reference: err_");
		expect(String(body.message)).to.not.contain("hunter2");
	});
});

describe("PbxChildResourceService", () => {
	it("threads the parent id through every child operation", async () => {
		const { runtime, calls } = fakeRuntime({});
		const service = new IvrMenuOptionsService(runtime);
		const session = sessionFor(ORGANIZATION_ID);
		await service.list(session, "menu");
		await service.create(session, "menu", { matchValue: "1" });
		await service.update(session, "menu", "opt", { label: "x" });
		await service.remove(session, "menu", "opt");

		expect(calls.map((entry) => entry.method)).to.deep.equal([
			"listChildren",
			"createChild",
			"updateChild",
			"removeChild",
		]);
		for (const entry of calls) {
			expect(entry.args[0]).to.equal(ORGANIZATION_ID);
			expect(entry.args[2]).to.equal("menu");
		}
	});

	it("wraps a child collection as { data } without paging it", async () => {
		const { runtime } = fakeRuntime({
			listChildren: (() => Effect.succeed([{ id: "a" }, { id: "b" }])) as never,
		});
		const result = await new IvrMenuOptionsService(runtime).list(sessionFor(ORGANIZATION_ID), "m");
		expect(result).to.deep.equal({ data: [{ id: "a" }, { id: "b" }] });
	});
});

/**
 * Paging groups, over the same fake.
 *
 * The seam is the point here too, and one part of it is specific to this slice: a paging group is
 * the entity a `*81` code may pin in `params.groupId`, a reference no foreign key expresses, so the
 * 409 on a referenced delete is the only thing standing between deleting a group and a recompile
 * failing on somebody else's unrelated save two hours later. That the failure carries the JSONB
 * path as its field is what lets the admin UI say WHICH code is holding the group.
 */
describe("PagingGroupsService", () => {
	it("passes the session's organization as the repository's first argument", async () => {
		const { runtime, calls } = fakeRuntime({});
		await new PagingGroupsService(runtime).list(sessionFor(ORGANIZATION_ID), {
			page: 1,
			limit: 20,
		} as never);
		expect(calls[0]?.method).to.equal("list");
		expect(calls[0]?.args[0]).to.equal(ORGANIZATION_ID);
	});

	it("passes its own resource descriptor, not one the caller chose", async () => {
		const { runtime, calls } = fakeRuntime({});
		await new PagingGroupsService(runtime).get(sessionFor(ORGANIZATION_ID), "pg");
		const resource = calls[0]?.args[1] as {
			kind: string;
			tableName: string;
			destinationType: string;
		};
		expect(resource.kind).to.equal("paging-group");
		expect(resource.tableName).to.equal("paging_group");
		// Something has to be able to point at a group, or an IVR option could never reach one.
		expect(resource.destinationType).to.equal("paging-group");
	});

	it("refuses to act on a session with no active organization", async () => {
		const { runtime, calls } = fakeRuntime({});
		let thrown: unknown;
		try {
			await new PagingGroupsService(runtime).list(sessionFor(null), {
				page: 1,
				limit: 20,
			} as never);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(MissingActiveOrganizationError);
		expect(calls).to.have.length(0);
	});

	it("returns the mutation envelope apps/web expects, warnings included", async () => {
		const { runtime } = fakeRuntime({});
		const result = await new PagingGroupsService(runtime).create(sessionFor(ORGANIZATION_ID), {
			name: "Warehouse",
		});
		expect(result).to.deep.equal({ data: { id: "row" }, warnings: [] });
	});

	it("surfaces a delete refused by a feature code as a 409 naming params.groupId", async () => {
		const { runtime } = fakeRuntime({
			remove: (() =>
				Effect.fail(
					new PbxEntityReferencedFailure({
						kind: "paging-group",
						id: "pg",
						references: [{ kind: "feature-code", id: "fc", name: "*81", field: "params.groupId" }],
					}),
				)) as never,
		});
		let thrown: HttpException | undefined;
		try {
			await new PagingGroupsService(runtime).remove(sessionFor(ORGANIZATION_ID), "pg");
		} catch (error) {
			thrown = error as HttpException;
		}
		expect(thrown?.getStatus()).to.equal(409);
		const body = thrown?.getResponse() as { references?: readonly { field?: string }[] };
		expect(body.references?.[0]?.field).to.equal("params.groupId");
	});
});

describe("PagingGroupMembersService", () => {
	it("threads the group id through every member operation", async () => {
		const { runtime, calls } = fakeRuntime({});
		const service = new PagingGroupMembersService(runtime);
		const session = sessionFor(ORGANIZATION_ID);
		await service.list(session, "group");
		await service.create(session, "group", { extensionId: "ext", ordinal: 0 });
		await service.update(session, "group", "member", { enabled: false });
		await service.remove(session, "group", "member");

		expect(calls.map((entry) => entry.method)).to.deep.equal([
			"listChildren",
			"createChild",
			"updateChild",
			"removeChild",
		]);
		for (const entry of calls) {
			expect(entry.args[0]).to.equal(ORGANIZATION_ID);
			expect(entry.args[2]).to.equal("group");
		}
	});

	/**
	 * The reorder returns the collection, not an acknowledgement.
	 *
	 * A page is fanned out in ordinal order, so the caller has to render what the server stored
	 * rather than the optimistic order it sent — and `paging_group_member` has a unique
	 * `(group, ordinal)` index, so a client that assumed its own order took hold would be wrong in
	 * exactly the case that matters: the one where the write was rejected.
	 */
	it("hands back the reordered collection", async () => {
		// Recorded in the override rather than read off `calls`: an override replaces the recording
		// stub, so the arguments have to be captured by whoever replaced it.
		let received: readonly unknown[] = [];
		const { runtime } = fakeRuntime({
			reorderChildren: ((...args: unknown[]) => {
				received = args;
				return Effect.succeed({
					row: [
						{ id: "b", ordinal: 0 },
						{ id: "a", ordinal: 1 },
					],
					warnings: [],
				});
			}) as never,
		});
		const result = await new PagingGroupMembersService(runtime).reorder(
			sessionFor(ORGANIZATION_ID),
			"group",
			["b", "a"],
		);
		expect(received[0]).to.equal(ORGANIZATION_ID);
		expect(received[2]).to.equal("group");
		expect(received[3]).to.deep.equal(["b", "a"]);
		expect(result.data.map((row) => row.id)).to.deep.equal(["b", "a"]);
		expect(result.warnings).to.deep.equal([]);
	});
});
