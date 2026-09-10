import { expect } from "chai";
import { ProvisioningRateLimiter } from "../../src/provisioning/render/provision-rate-limit";
import { mintProvisioningToken } from "../../src/provisioning/render/provision-token";
import { ProvisionRefusedException } from "../../src/provisioning/render/provision.errors";
import { ProvisionService } from "../../src/provisioning/render/provision.service";
import type { ProvisioningEnv } from "../../src/provisioning/provisioning-env";
import type {
	RenderSnapshot,
	TokenLookup,
} from "../../src/provisioning/render/provision.repository";

/**
 * A phone whose organization has configured no SIP domain is REFUSED, not rendered.
 *
 * The realm a phone registers into resolves to exactly one organization
 * (`sip-credentials.service.ts`), so rendering the deployment's `PROVISION_SIP_SERVER` into a
 * tenant's accounts hands that tenant another tenant's identity: a credential that can never
 * register, and — when both tenants use the same extension number — one that authenticates against
 * the wrong tenant's account. The refusal reason is `not-configured`, which is the same 404 to the
 * phone and a named reason in the log and the `device.rejected` event (see `provision.errors.ts`).
 */

const ORG = "019fd3c2-1111-7000-8000-000000000001";
const DEVICE = "019fd3c2-4444-7000-8000-000000000004";

const ENV = {
	PROVISION_SIP_SERVER: "pbx.example.test",
	PROVISION_SIP_SECRET_KEY: "test-root-key-0123456789abcdef",
	PROVISION_SIP_PORT: 5060,
	PROVISION_SIP_TRANSPORT: "inherit",
	PROVISION_RATE_LIMIT_PER_MINUTE: 60,
	PROVISION_REQUIRE_IP_ALLOWLIST: false,
} as unknown as ProvisioningEnv;

describe("provisioning refuses a tenant with no SIP domain", () => {
	it("renders when the organization owns a domain and refuses when it does not", async () => {
		for (const sipRealm of ["tenant-b.example.test", null]) {
			const minted = mintProvisioningToken();
			const rejected: string[] = [];
			const found: TokenLookup = {
				id: DEVICE,
				organizationId: ORG,
				macAddress: "001565abcdef",
				vendor: "yealink",
				model: "T54W",
				enabled: true,
				provisioningToken: minted.reference,
				provisioningTokenHash: minted.secretHash,
				provisioningTokenExpiresAt: null,
			};
			const service = new ProvisionService(
				{
					findByTokenReference: async () => found,
					checkAllowlist: async () => ({ hasEntries: false, evaluable: true, allowed: true }),
					loadSnapshot: async () => snapshot(sipRealm),
					recordCheckIn: async () => undefined,
				} as never,
				{
					publish: async (type: string, _org: string, body: { reason?: string }) => {
						if (type === "device.rejected") {
							rejected.push(body.reason ?? "");
						}
					},
				} as never,
				ENV,
				new ProvisioningRateLimiter(60),
				{ record: async () => undefined } as never,
			);

			if (sipRealm === null) {
				let thrown: unknown;
				try {
					await service.renderConfig(request(minted.token));
				} catch (error) {
					thrown = error;
				}
				expect(thrown).to.be.instanceOf(ProvisionRefusedException);
				expect((thrown as ProvisionRefusedException).reason).to.equal("not-configured");
				expect(rejected).to.deep.equal(["not-configured"]);
			} else {
				const rendered = await service.renderConfig(request(minted.token));
				expect(rendered.context.sipDomain).to.equal("tenant-b.example.test");
				// The deployment's edge remains the transport target — the two are different facts.
				expect(rendered.context.lines[0]?.serverAddress).to.equal("pbx.example.test");
				expect(rejected).to.deep.equal([]);
			}
		}
	});
});

function request(token: string) {
	return {
		token,
		sourceAddress: "127.0.0.1:5060",
		sourceIp: "127.0.0.1",
		path: undefined,
		userAgent: undefined,
	};
}

function snapshot(sipRealm: string | null): RenderSnapshot {
	return {
		device: {
			id: DEVICE,
			vendor: "yealink",
			model: "T54W",
			macAddress: "001565abcdef",
			label: "Reception",
			settings: {},
		},
		profile: undefined,
		sipRealm,
		lines: [
			{
				line: {
					lineNumber: 1,
					enabled: true,
					extensionId: "019fd3c2-3333-7000-8000-000000000003",
					authUser: null,
					sipSecretRef: null,
					serverAddress: null,
					serverPort: 5060,
					transport: "udp",
					registerExpiresSeconds: 3600,
					sharedLine: false,
					label: null,
				},
				extension: {
					id: "019fd3c2-3333-7000-8000-000000000003",
					number: "1001",
					sipSecretRef: "secret-ref",
					callerIdName: "Alice Nguyen",
					label: "Reception",
					voicemailEnabled: false,
				},
			},
		],
		keys: [],
		profileKeys: [],
		organizationSettings: {},
		sharedLineExtensionIds: new Set<string>(),
	} as unknown as RenderSnapshot;
}
