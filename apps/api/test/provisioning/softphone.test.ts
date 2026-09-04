import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { expect } from "chai";
import { deriveSipPassword } from "../../src/provisioning/render/provision-secret";
import { SoftphoneCredentialsService } from "../../src/provisioning/softphone/softphone.service";
import type { ProvisioningEnv } from "../../src/provisioning/provisioning-env";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * `GET /api/v1/me/softphone` — the self-service credential read.
 *
 * The database is faked the way the rest of the area fakes it (`sipCredentials.test.ts`): a
 * `withTenantScope` that answers a queue of result sets in the order the service issues its selects
 * — the extension lookup first, then the realm setting. The claims are about the REPLY (the derived
 * password, the realm, the WSS URL and the honesty flag), not the SQL.
 */

const ORG = "019fd3c2-1111-7000-8000-000000000001";
const USER = "019fd3c2-2222-7000-8000-000000000002";
const EXTENSION_ID = "019fd3c2-3333-7000-8000-000000000003";
const ROOT_KEY = "a-development-root-key-16+";

function session(): AppSession {
	return {
		session: { activeOrganizationId: ORG },
		user: { id: USER },
	} as unknown as AppSession;
}

function env(overrides: Partial<ProvisioningEnv> = {}): ProvisioningEnv {
	return {
		PROVISION_SIP_SECRET_KEY: ROOT_KEY,
		PROVISION_SIP_PORT: 5060,
		PROVISION_SIP_TRANSPORT: "udp",
		PROVISION_RATE_LIMIT_PER_MINUTE: 12,
		PROVISION_REQUIRE_IP_ALLOWLIST: false,
		PROVISION_TOKEN_TTL_DAYS: 0,
		...overrides,
	} as unknown as ProvisioningEnv;
}

/** A database whose tenant-scoped selects dequeue the queued result sets, in order. */
function fakeDatabase(...resultSets: readonly unknown[][]): PbxDatabaseClient {
	const queue = [...resultSets];
	const next = (): unknown[] => queue.shift() ?? [];
	const chain = (): Record<string, unknown> => {
		const self: Record<string, unknown> = {};
		for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy"]) {
			self[method] = () => self;
		}
		self.limit = async () => next();
		return self;
	};
	return {
		withTenantScope: async <T>(_organizationId: string, work: (tx: never) => Promise<T>) =>
			await work({ select: () => chain() } as never),
	} as unknown as PbxDatabaseClient;
}

const EXTENSION_ROW = {
	id: EXTENSION_ID,
	number: "1001",
	label: "Reception",
	callerIdName: "Front Desk",
	sipSecretRef: "secret-ref-1001",
	voicemailEnabled: true,
};

describe("SoftphoneCredentialsService", () => {
	it("returns a derived-password account for the caller's own extension", async () => {
		const service = new SoftphoneCredentialsService(
			fakeDatabase([EXTENSION_ROW], [{ value: "pbx.example.test" }]),
			env({ PROVISION_SIP_WSS_URL: "wss://sip.example.test:8089" }),
		);

		const reply = await service.forSelf(session());

		expect(reply.extension).to.deep.equal({
			id: EXTENSION_ID,
			number: "1001",
			label: "Reception",
			displayName: "Front Desk",
		});
		expect(reply.account.username).to.equal("1001");
		expect(reply.account.authUsername).to.equal("1001");
		expect(reply.account.realm).to.equal("pbx.example.test");
		expect(reply.account.voicemailNumber).to.equal("1001");
		// The password is the SAME derivation a provisioned desk phone gets — so the registrar
		// authenticates a softphone REGISTER the same way. This is the load-bearing claim.
		expect(reply.account.password).to.equal(
			deriveSipPassword({ rootKey: ROOT_KEY, organizationId: ORG, secretRef: "secret-ref-1001" }),
		);
		expect(reply.transport.wssUrl).to.equal("wss://sip.example.test:8089");
		// The honesty boundary is on the wire: signalling works, media does not, yet.
		expect(reply.media.webrtcSupported).to.equal(false);
	});

	it("falls back to PROVISION_SIP_SERVER as the realm when no org realm setting exists", async () => {
		const service = new SoftphoneCredentialsService(
			fakeDatabase([EXTENSION_ROW], []),
			env({ PROVISION_SIP_SERVER: "sip.fallback.test" }),
		);
		const reply = await service.forSelf(session());
		expect(reply.account.realm).to.equal("sip.fallback.test");
		// No explicit WSS URL configured → null, and the web derives one from its own https origin.
		expect(reply.transport.wssUrl).to.equal(null);
	});

	it("404s when the caller holds no extension", async () => {
		const service = new SoftphoneCredentialsService(fakeDatabase([], []), env());
		let thrown: unknown;
		try {
			await service.forSelf(session());
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(NotFoundException);
	});

	it("503s when the deployment has no SIP secret key to derive a password from", async () => {
		const service = new SoftphoneCredentialsService(
			fakeDatabase([EXTENSION_ROW], [{ value: "pbx.example.test" }]),
			env({ PROVISION_SIP_SECRET_KEY: undefined }),
		);
		let thrown: unknown;
		try {
			await service.forSelf(session());
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(ServiceUnavailableException);
	});

	it("503s when neither an org realm nor PROVISION_SIP_SERVER is configured", async () => {
		const service = new SoftphoneCredentialsService(
			fakeDatabase([EXTENSION_ROW], []),
			env({ PROVISION_SIP_SERVER: undefined }),
		);
		let thrown: unknown;
		try {
			await service.forSelf(session());
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(ServiceUnavailableException);
	});
});
