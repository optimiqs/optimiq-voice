import { createHash } from "node:crypto";
import { expect } from "chai";
import { TrunkCredentialsService } from "../../src/pbx/sip-credentials/trunk-credentials.service";
import type { SipTrunkCredentialRequest } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";
import type { TelnyxClient } from "@optimiq-voice/telnyx";

const request: SipTrunkCredentialRequest = {
	orgId: "019fd3c2-1111-76be-a6b3-b0f1914e39b6",
	trunkId: "019fd3c2-3333-76be-a6b3-b0f1914e39b6",
	secretRef: "secret://carrier",
	username: "account",
	realm: "sip.telnyx.example",
	algorithm: "MD5",
};

function fixture() {
	const row = {
		enabled: true,
		kind: "register",
		authUser: request.username,
		secretRef: request.secretRef,
		provider: "telnyx",
		carrierRef: "connection-1",
		updatedAt: new Date(0),
	};
	const scopes: string[] = [];
	const chain = { from: () => chain, where: () => chain, limit: async () => [row] };
	const database = {
		withTenantScope: async <T>(orgId: string, work: (tx: never) => Promise<T>) => {
			scopes.push(orgId);
			return await work({ select: () => chain } as never);
		},
	} as unknown as PbxDatabaseClient;
	let reads = 0;
	const carrier = {
		credentialConnections: {
			get: async () => {
				reads++;
				return { user_name: "account", password: "synthetic-password", active: true };
			},
		},
	} as unknown as TelnyxClient;
	return {
		row,
		scopes,
		service: new TrunkCredentialsService(database, carrier),
		reads: () => reads,
	};
}

describe("carrier digest resolution", () => {
	it("scopes the lookup and returns the digest without the carrier password", async () => {
		const f = fixture();
		for (const algorithm of ["MD5", "SHA-256", "SHA-512-256"] as const) {
			const result = await f.service.resolve({ ...request, algorithm });
			const hash = { MD5: "md5", "SHA-256": "sha256", "SHA-512-256": "sha512-256" }[algorithm];
			expect(result.ha1).to.equal(
				createHash(hash).update("account:sip.telnyx.example:synthetic-password").digest("hex"),
			);
			expect(JSON.stringify(result)).not.to.contain("synthetic-password");
		}
		expect(f.scopes).to.deep.equal([request.orgId, request.orgId, request.orgId]);
	});

	it("checks current trunk state even when its digest is cached", async () => {
		const f = fixture();
		expect((await f.service.resolve(request)).ok).to.equal(true);
		expect((await f.service.resolve(request)).ok).to.equal(true);
		expect(f.reads()).to.equal(1);
		f.row.enabled = false;
		expect((await f.service.resolve(request)).ok).to.equal(false);
		f.row.enabled = true;
		f.row.updatedAt = new Date(1);
		expect((await f.service.resolve(request)).ok).to.equal(true);
		expect(f.reads()).to.equal(2);
	});

	it("does not fetch a carrier credential for a stale secret or another username", async () => {
		const f = fixture();
		expect((await f.service.resolve({ ...request, secretRef: "stale" })).ok).to.equal(false);
		expect((await f.service.resolve({ ...request, username: "other" })).ok).to.equal(false);
		expect(f.reads()).to.equal(0);
	});
});
