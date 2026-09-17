import { HttpException } from "@nestjs/common";
import { expect } from "chai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTestModuleRuntime } from "@optimiq-voice/effect-runtime";
import { OrgLimitsService } from "../../src/pbx/org-limits/org-limits.service";
import { PbxRepository } from "../../src/pbx/shared/pbx.repository";
import { TrunksService } from "../../src/pbx/trunks/trunks.service";
import type { PbxRepositoryRuntime } from "../../src/pbx/shared/pbx-runtime";
import type { PbxRepositoryInterface } from "../../src/pbx/shared/pbx.repository";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * Admission of a registering trunk.
 *
 * sipd refuses a `register` gateway with no auth user at ingest and keeps the previous
 * configuration, so a row the API accepted without one is permanently un-loadable. These specs pin
 * the refusal at the write.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";

const SESSION = {
	session: {
		id: "sess",
		userId: "019fd3c2-2222-76be-a6b3-b0f1914e39b6",
		token: "t",
		expiresAt: new Date(Date.now() + 3_600_000),
		activeOrganizationId: ORGANIZATION_ID,
	},
	user: { id: "019fd3c2-2222-76be-a6b3-b0f1914e39b6", email: "a@b.test" },
	permissions: ["trunks.read", "trunks.write"],
} as unknown as AppSession;

const NO_LIMITS = { assertMayCreate: async () => undefined } as unknown as OrgLimitsService;

function serviceOver(stored: Record<string, unknown>): {
	service: TrunksService;
	writes: Record<string, unknown>[];
} {
	const writes: Record<string, unknown>[] = [];
	const repository = {
		get: () => Effect.succeed(stored),
		create: (_organizationId: string, _resource: unknown, values: Record<string, unknown>) => {
			writes.push(values);
			return Effect.succeed({ row: { id: "trunk" }, warnings: [] });
		},
		update: (
			_organizationId: string,
			_resource: unknown,
			_id: string,
			values: Record<string, unknown>,
		) => {
			writes.push(values);
			return Effect.succeed({ row: { id: "trunk" }, warnings: [] });
		},
	} as unknown as PbxRepositoryInterface;
	const layer = Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(repository)));
	const runtime: PbxRepositoryRuntime = makeTestModuleRuntime(PbxRepository, layer);
	return { service: new TrunksService(runtime, NO_LIMITS), writes };
}

async function refusal(work: () => Promise<unknown>): Promise<Record<string, unknown>> {
	try {
		await work();
	} catch (error) {
		expect(error).to.be.instanceOf(HttpException);
		const exception = error as HttpException;
		expect(exception.getStatus()).to.equal(422);
		return exception.getResponse() as Record<string, unknown>;
	}
	throw new Error("the write was accepted");
}

const VALID = {
	name: "carrier",
	kind: "register",
	sipDomain: "sip.carrier.test",
	sipProxy: "sip.carrier.test",
	authUser: "acct-1",
	sipSecretRef: "secret://carrier/acct-1",
};

describe("registering trunks need a credential", () => {
	it("refuses a create with no auth user, naming the field", async () => {
		const { service, writes } = serviceOver({});
		const { authUser: _dropped, ...body } = VALID;
		const response = await refusal(async () => await service.create(SESSION, body));
		expect(response.code).to.equal("PBX_INVALID_TRUNK_REGISTRATION");
		expect(response.field).to.equal("authUser");
		expect(writes).to.have.length(0);
	});

	it("treats an absent kind as register, because the column defaults to it", async () => {
		const { service } = serviceOver({});
		const { authUser: _dropped, kind: _kind, ...body } = VALID;
		expect((await refusal(async () => await service.create(SESSION, body))).field).to.equal(
			"authUser",
		);
	});

	it("refuses a create with a username and no secret reference", async () => {
		const { service } = serviceOver({});
		const { sipSecretRef: _dropped, ...body } = VALID;
		expect((await refusal(async () => await service.create(SESSION, body))).field).to.equal(
			"sipSecretRef",
		);
	});

	it("accepts an ip-auth trunk with no credential at all", async () => {
		const { service, writes } = serviceOver({});
		const { authUser: _user, sipSecretRef: _ref, ...body } = VALID;
		await service.create(SESSION, { ...body, kind: "ip-auth" });
		expect(writes).to.have.length(1);
	});

	it("accepts a valid registering trunk", async () => {
		const { service, writes } = serviceOver({});
		await service.create(SESSION, VALID);
		expect(writes).to.have.length(1);
	});

	it("refuses a patch that clears the auth user of a registering trunk", async () => {
		const { service, writes } = serviceOver({ ...VALID, id: "trunk" });
		const response = await refusal(
			async () => await service.update(SESSION, "trunk", { authUser: null }),
		);
		expect(response.field).to.equal("authUser");
		expect(writes).to.have.length(0);
	});

	it("refuses a patch that flips an ip-auth trunk to register with no credential", async () => {
		const { service } = serviceOver({
			...VALID,
			kind: "ip-auth",
			authUser: null,
			sipSecretRef: null,
		});
		expect(
			(await refusal(async () => await service.update(SESSION, "trunk", { kind: "register" })))
				.field,
		).to.equal("authUser");
	});

	it("lets an already-valid registering trunk be patched on an unrelated field", async () => {
		const { service, writes } = serviceOver({ ...VALID, id: "trunk" });
		await service.update(SESSION, "trunk", { name: "renamed" });
		expect(writes).to.deep.equal([{ name: "renamed" }]);
	});
});
