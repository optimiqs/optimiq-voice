import { expect } from "chai";
import { templateFor } from "../../src/provisioning/catalog/catalog";
import { renderWith } from "../../src/provisioning/catalog/template";
import { ProvisionService } from "../../src/provisioning/render/provision.service";
import type { RenderContext } from "../../src/provisioning/catalog/render-context";
import type { ProvisioningEnv } from "../../src/provisioning/provisioning-env";
import type { RenderSnapshot } from "../../src/provisioning/render/provision.repository";

/**
 * `device_line.shared_line` is now derived from the rows, not read from the flag alone.
 *
 * `provisioningCatalog.test.ts` proves the templates render a shared line correctly GIVEN a
 * `RenderContext` with `sharedLine: true`. It cannot prove the wiring that decides that boolean,
 * because it builds the context by hand. This suite proves the wiring: a device line whose extension
 * is a shared-line appearance renders `sharedLine: true` even though the line's own manual flag is
 * `false`, and a line that is neither stays `false`.
 *
 * The assertion is made at the `buildContext` seam — the pure function of a snapshot that
 * `provision.service.ts` documents as the one place environment and derivation happen — so the test
 * needs no database, no token and no broker. The membership set is exactly what
 * `provision.repository.ts` loads for the device's line extensions; here it is supplied directly.
 */

const ORG = "019fd3c2-1111-7000-8000-000000000001";
const MEMBER_EXTENSION_ID = "019fd3c2-2222-7000-8000-000000000002";
const PLAIN_EXTENSION_ID = "019fd3c2-3333-7000-8000-000000000003";

const ENV = {
	PROVISION_SIP_SERVER: "pbx.example.test",
	PROVISION_SIP_SECRET_KEY: "test-root-key-0123456789abcdef",
	PROVISION_SIP_OUTBOUND_PROXY: undefined,
	PROVISION_BASE_URL: undefined,
} as unknown as ProvisioningEnv;

/** A service with only the env wired — `buildContext` touches nothing else. */
function service(): {
	buildContext(organizationId: string, snapshot: RenderSnapshot, token: string): RenderContext;
} {
	return new ProvisionService(
		undefined as never,
		undefined as never,
		ENV,
		undefined as never,
		undefined as never,
	) as unknown as {
		buildContext(organizationId: string, snapshot: RenderSnapshot, token: string): RenderContext;
	};
}

/**
 * A one-line Yealink snapshot whose single line points at `extensionId`, with the manual
 * `shared_line` flag OFF, and a membership set the caller supplies.
 */
function snapshot(extensionId: string, sharedLineMembers: readonly string[]): RenderSnapshot {
	return {
		device: {
			id: "019fd3c2-4444-7000-8000-000000000004",
			vendor: "yealink",
			model: "T54W",
			macAddress: "001565abcdef",
			label: "Reception",
			settings: {},
		},
		profile: undefined,
		lines: [
			{
				line: {
					lineNumber: 1,
					enabled: true,
					extensionId,
					authUser: null,
					sipSecretRef: null,
					serverAddress: null,
					serverPort: 5060,
					transport: "udp",
					registerExpiresSeconds: 3600,
					// The manual flag is deliberately OFF: the derivation, not the column, must light it.
					sharedLine: false,
					label: null,
				},
				extension: {
					id: extensionId,
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
		sharedLineExtensionIds: new Set(sharedLineMembers),
	} as unknown as RenderSnapshot;
}

describe("provisioning — shared line derived from appearances", () => {
	it("renders sharedLine true when the extension is a shared-line member and the flag is off", () => {
		const context = service().buildContext(
			ORG,
			snapshot(MEMBER_EXTENSION_ID, [MEMBER_EXTENSION_ID]),
			"token",
		);

		expect(context.lines).to.have.length(1);
		expect(context.lines[0]?.sharedLine).to.equal(true);
	});

	it("leaves sharedLine false when the extension is on no shared line", () => {
		const context = service().buildContext(ORG, snapshot(PLAIN_EXTENSION_ID, []), "token");

		expect(context.lines[0]?.sharedLine).to.equal(false);
	});

	it("stamps the derived shared line into the Yealink and Poly renders", () => {
		const context = service().buildContext(
			ORG,
			snapshot(MEMBER_EXTENSION_ID, [MEMBER_EXTENSION_ID]),
			"token",
		);

		const yealink = templateFor("yealink");
		const poly = templateFor("poly");
		expect(yealink, "yealink template").to.not.equal(undefined);
		expect(poly, "poly template").to.not.equal(undefined);

		const yealinkBody = renderWith(yealink as never, context).body;
		const polyBody = renderWith(poly as never, context).body;

		expect(yealinkBody).to.contain("account.1.shared_line = 2");
		expect(polyBody).to.contain('reg.1.type="shared"');
	});
});
