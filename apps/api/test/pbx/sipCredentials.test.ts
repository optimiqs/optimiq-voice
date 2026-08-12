import { expect } from "chai";
import { SipCredentialsService } from "../../src/pbx/sip-credentials/sip-credentials.service";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The shared-line half of the credential reply.
 *
 * `sip-credentials.service.ts` resolves an extension's HA1 the same way it always has; this suite
 * asserts the field it learned to add — that a REGISTER from an extension which is an appearance on
 * an enabled shared line comes back carrying `sharedLineNumber` and `appearanceIndex`, and that a
 * REGISTER from an extension on no shared line carries neither.
 *
 * The database is faked the way the rest of this area fakes it (`authzCheck.test.ts`): a queue of
 * result sets answered in the order the service issues its selects, and `withTenantScope` faked
 * rather than stubbed per-query, because the claim under test is about the REPLY, not the SQL — RLS
 * is what scopes the reads and Drizzle is what builds them, and asserting on either would be
 * asserting on somebody else's code.
 */

const ORG = "019fd3c2-1111-7000-8000-000000000001";
const EXTENSION_ID = "019fd3c2-2222-7000-8000-000000000002";
const REALM = "pbx.example.test";
const USERNAME = "1001";
/** A precomputed digest, so the test never depends on the secret key or the derivation. */
const STORED_HA1 = "0123456789abcdef0123456789abcdef";

interface Scenario {
	/** The rows the shared-line appearance lookup returns, in order. */
	readonly appearanceRows: readonly {
		readonly sharedLineNumber: string | null;
		readonly appearanceIndex: number;
	}[];
}

/**
 * A database whose every select dequeues the next queued result set.
 *
 * The service issues, in order: the realm→org directory (`adminDb`), the device-line lookup, the
 * bare-extension lookup, and — new — the shared-line appearance lookup. The queue mirrors that
 * order, and every chain method returns the chain so `from/leftJoin/innerJoin/where/orderBy/limit`
 * all compose before the terminal resolves.
 */
function fakeDatabase(scenario: Scenario): PbxDatabaseClient {
	const results: unknown[][] = [
		// resolveOrganizationForRealm → the tenant that owns this realm.
		[{ organizationId: ORG }],
		// findDeviceLine → none, so the service falls through to the bare extension.
		[],
		// findExtension → an enabled extension with a stored digest.
		[
			{
				id: EXTENSION_ID,
				enabled: true,
				secretRef: "secret-ref",
				storedHa1: STORED_HA1,
			},
		],
		// findSharedLineAppearance → the scenario's rows.
		[...scenario.appearanceRows],
	];

	const next = (): unknown[] => results.shift() ?? [];

	const chain = (rows: unknown[]): Record<string, unknown> => {
		const self: Record<string, unknown> = {};
		for (const method of ["from", "leftJoin", "innerJoin", "where", "orderBy"]) {
			self[method] = () => self;
		}
		self.limit = async () => rows;
		return self;
	};

	const select = () => chain(next());

	return {
		adminDb: { select },
		withTenantScope: async <T>(_organizationId: string, work: (tx: never) => Promise<T>) =>
			await work({ select } as never),
	} as unknown as PbxDatabaseClient;
}

describe("SipCredentialsService — shared line appearance", () => {
	it("carries appearanceIndex and sharedLineNumber for an appearance on a shared line", async () => {
		const service = new SipCredentialsService(
			fakeDatabase({ appearanceRows: [{ sharedLineNumber: "5000", appearanceIndex: 2 }] }),
		);

		const reply = await service.resolve({ realm: REALM, username: USERNAME });

		expect(reply.found).to.equal(true);
		expect(reply.enabled).to.equal(true);
		expect(reply.ha1).to.equal(STORED_HA1);
		expect(reply.extensionId).to.equal(EXTENSION_ID);
		expect(reply.appearanceIndex).to.equal(2);
		expect(reply.sharedLineNumber).to.equal("5000");
	});

	it("carries the appearance index but no number for a shared-key-only line", async () => {
		const service = new SipCredentialsService(
			fakeDatabase({ appearanceRows: [{ sharedLineNumber: null, appearanceIndex: 0 }] }),
		);

		const reply = await service.resolve({ realm: REALM, username: USERNAME });

		expect(reply.appearanceIndex).to.equal(0);
		expect(reply.sharedLineNumber).to.equal(undefined);
	});

	it("omits both fields for an extension on no shared line", async () => {
		const service = new SipCredentialsService(fakeDatabase({ appearanceRows: [] }));

		const reply = await service.resolve({ realm: REALM, username: USERNAME });

		expect(reply.found).to.equal(true);
		expect(reply.ha1).to.equal(STORED_HA1);
		expect(reply.appearanceIndex).to.equal(undefined);
		expect(reply.sharedLineNumber).to.equal(undefined);
	});
});
