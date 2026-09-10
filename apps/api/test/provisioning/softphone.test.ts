import { createHmac } from "node:crypto";
import { expect } from "chai";
import { loadProvisioningEnv } from "../../src/provisioning/provisioning-env";
import { deriveSipPassword } from "../../src/provisioning/render/provision-secret";
import { SoftphoneCredentialsService } from "../../src/provisioning/softphone/softphone.service";
import type { ProvisioningEnv } from "../../src/provisioning/provisioning-env";
import type {
	SoftphoneConfiguredResponse,
	SoftphoneCredentialsResponse,
	SoftphoneUnavailableResponse,
} from "../../src/provisioning/softphone/softphone.service";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * `GET /api/v1/me/softphone` — the self-service credential read.
 *
 * The database is faked the way the rest of the area fakes it (`sipCredentials.test.ts`): a
 * `withTenantScope` that answers a queue of result sets in the order the service issues its selects
 * — the extension lookup first, then the realm setting. The claims are about the REPLY (the derived
 * password, the realm, the WSS URL and the honesty flag), not the SQL.
 *
 * Every answer is a 200 — see the service header for why none of the three "no softphone" states is
 * a request failure — so the assertions narrow on `configured` rather than catching an exception.
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
		PROVISION_WEBRTC_ENABLED: false,
		PROVISION_TURN_TTL_SECONDS: 3600,
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

/** Narrows the reply to the configured arm, failing the test with a readable message if it is not. */
function asConfigured(reply: SoftphoneCredentialsResponse): SoftphoneConfiguredResponse {
	expect(reply.configured, `expected credentials, got ${JSON.stringify(reply)}`).to.equal(true);
	return reply as SoftphoneConfiguredResponse;
}

/** The other arm, narrowed the same way. */
function asUnavailable(reply: SoftphoneCredentialsResponse): SoftphoneUnavailableResponse {
	expect(reply.configured, `expected a refusal, got credentials`).to.equal(false);
	return reply as SoftphoneUnavailableResponse;
}

describe("SoftphoneCredentialsService", () => {
	it("returns a derived-password account for the caller's own extension", async () => {
		const service = new SoftphoneCredentialsService(
			fakeDatabase([EXTENSION_ROW], [{ value: "pbx.example.test" }]),
			env({ PROVISION_SIP_WSS_URL: "wss://sip.example.test:8089" }),
		);

		const reply = asConfigured(await service.forSelf(session()));

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
		// Enabling WSS alone does not advertise encrypted media readiness.
		expect(reply.media.webrtcSupported).to.equal(false);
		expect(reply.media.iceServers).to.deep.equal([]);
	});

	it("issues expiring authenticated TURN credentials without exposing the shared secret", async () => {
		const secret = "test-turn-shared-secret-32-characters";
		const service = new SoftphoneCredentialsService(
			fakeDatabase([EXTENSION_ROW], [{ value: "pbx.example.test" }]),
			env({
				PROVISION_WEBRTC_ENABLED: true,
				PROVISION_SIP_WSS_URL: "wss://sip.example.test:8089",
				PROVISION_TURN_URLS: [
					"turn:turn.example.test:3478?transport=udp",
					"turns:turn.example.test:5349?transport=tcp",
				],
				PROVISION_TURN_SECRET: secret,
				PROVISION_TURN_TTL_SECONDS: 600,
			}),
		);
		const before = Math.floor(Date.now() / 1000);
		const reply = asConfigured(await service.forSelf(session()));
		const ice = reply.media.iceServers[0]!;
		expect(reply.media.webrtcSupported).to.equal(true);
		expect(ice.urls).to.have.length(2);
		const [expires, organizationId, userId] = ice.username.split(":");
		expect(Number(expires)).to.be.within(before + 600, Math.floor(Date.now() / 1000) + 600);
		expect(organizationId).to.equal(ORG);
		expect(userId).to.equal(USER);
		expect(ice.credential).to.equal(
			createHmac("sha1", secret).update(ice.username).digest("base64"),
		);
		expect(JSON.stringify(reply)).not.to.contain(secret);
	});

	it("rejects incomplete TURN and WebRTC deployment configuration at startup", () => {
		expect(() => loadProvisioningEnv({ PROVISION_WEBRTC_ENABLED: "true" })).to.throw(
			/PROVISION_SIP_WSS_URL is required/,
		);
		expect(() => loadProvisioningEnv({ PROVISION_TURN_URLS: "turn:turn.example.test" })).to.throw(
			/configured together/,
		);
		expect(() =>
			loadProvisioningEnv({ PROVISION_TURN_SECRET: "test-turn-secret-32-characters" }),
		).to.throw(/configured together/);
		expect(() =>
			loadProvisioningEnv({
				PROVISION_TURN_URLS: "https://turn.example.test",
				PROVISION_TURN_SECRET: "test-turn-secret-32-characters",
			}),
		).to.throw(/TURN URLs/);
	});

	it("refuses by name when the organization has no SIP domain, even with a deployment default", async () => {
		// PROVISION_SIP_SERVER is the deployment's SIP edge, not a tenant's realm: a realm resolves to
		// exactly one organization, so handing this one out would hand over another tenant's identity.
		const service = new SoftphoneCredentialsService(
			fakeDatabase([EXTENSION_ROW], []),
			env({ PROVISION_SIP_SERVER: "sip.fallback.test" }),
		);
		const reply = asUnavailable(await service.forSelf(session()));
		expect(reply.reason).to.equal("no-realm");
		expect(reply.code).to.equal("SOFTPHONE_NO_REALM");
		expect(reply.message).to.match(/SIP domain not configured/i);
		// The refusal carries no realm at all — the bug it replaced handed out another tenant's.
		expect(JSON.stringify(reply)).not.to.contain("sip.fallback.test");
	});

	it("hands out the organization's own realm when it has one", async () => {
		const service = new SoftphoneCredentialsService(
			fakeDatabase([EXTENSION_ROW], [{ value: "tenant-b.example.test" }]),
			env({ PROVISION_SIP_SERVER: "sip.fallback.test" }),
		);
		const reply = asConfigured(await service.forSelf(session()));
		expect(reply.account.realm).to.equal("tenant-b.example.test");
		// No explicit WSS URL configured → null, and the web derives one from its own https origin.
		expect(reply.transport.wssUrl).to.equal(null);
	});

	/**
	 * The finding this shape exists for (E2E-admin F-4).
	 *
	 * An administrator holding no extension is the ORDINARY case, and the docked provider asks on
	 * every authenticated page — so a 404 here wrote a console error onto all 35 admin screens.
	 */
	it("answers 200 with reason no-extension when the caller holds no extension", async () => {
		const service = new SoftphoneCredentialsService(fakeDatabase([], []), env());
		const reply = asUnavailable(await service.forSelf(session()));
		expect(reply.reason).to.equal("no-extension");
		expect(reply.code).to.equal("SOFTPHONE_NO_EXTENSION");
	});

	it("answers 200 with reason not-provisioned when there is no SIP secret key", async () => {
		const service = new SoftphoneCredentialsService(
			fakeDatabase([EXTENSION_ROW], [{ value: "pbx.example.test" }]),
			env({ PROVISION_SIP_SECRET_KEY: undefined }),
		);
		const reply = asUnavailable(await service.forSelf(session()));
		expect(reply.reason).to.equal("not-provisioned");
		expect(reply.code).to.equal("SOFTPHONE_NOT_CONFIGURED");
		// It names the variable an operator has to set, and nothing about the caller.
		expect(reply.message).to.contain("PROVISION_SIP_SECRET_KEY");
	});

	it("answers 200 with reason no-realm when neither the org nor the deployment names one", async () => {
		const service = new SoftphoneCredentialsService(
			fakeDatabase([EXTENSION_ROW], []),
			env({ PROVISION_SIP_SERVER: undefined }),
		);
		expect(asUnavailable(await service.forSelf(session())).reason).to.equal("no-realm");
	});

	/**
	 * The union is closed and discriminated: a client that narrows on `configured` never has to
	 * guess, and a refusal never carries a password-shaped field for one to leak through.
	 */
	it("never carries account material on the unavailable arm", async () => {
		const service = new SoftphoneCredentialsService(fakeDatabase([], []), env());
		const reply = await service.forSelf(session());
		expect(Object.keys(reply).sort()).to.deep.equal(["code", "configured", "message", "reason"]);
	});
});
