import { expect } from "chai";
import { AuthzCheckRpcController } from "../../src/auth/authz/authz-check-rpc.controller";
import { AuthzService } from "../../src/auth/authz/authz.service";
import type { AuthRepository } from "../../src/auth/auth.repository";
import type { AuthzCheckRequest } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * `rpc.authz.v1.check` — the responder `*0` supervision asks before any audio is tapped.
 *
 * What a first responder for this subject can get wrong, none of which needs a database:
 *
 *  1. **The extension claim.** An unknown number, a disabled extension, another tenant's extension
 *     and an extension nobody is `primary` on must all be refused, and refused identically — the
 *     difference is a way to enumerate a tenant's extensions from a handset.
 *  2. **The two databases.** `extension_user.userId` has no foreign key because the auth tables live
 *     elsewhere, so the resolution is two lookups against two handles and the second one is allowed
 *     to find nothing.
 *  3. **The partition.** `allowed` is EVERY requested permission, and an unscoped grant has to
 *     satisfy its scoped variant, because that is the rule the HTTP guard applies.
 *  4. **Nothing throws.** A denial and a broker timeout look identical from the far side, and this
 *     is the one subject whose entire value is that they do not.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORG = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const USER = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const EXTENSION_ID = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";

interface ExtensionRow {
	readonly id: string;
	readonly enabled: boolean;
}

/**
 * A tenant-scoped handle that answers the two selects in order and remembers the scope it was
 * opened with.
 *
 * `withTenantScope` is faked rather than stubbed per-query, on the terms `extensionFeatureRpc.test.ts`
 * records: asserting on the SQL would be asserting on Drizzle, while the tenancy claim these specs
 * make is about the ARGUMENT — RLS is what filters, so proving the right organization was scoped is
 * proving the filter was right.
 */
function fakeDatabase(
	extensionRow: ExtensionRow | undefined,
	link: { readonly userId: string } | undefined,
): { database: PbxDatabaseClient; scopes: string[] } {
	const scopes: string[] = [];
	let reads = 0;
	const transaction = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => {
						reads += 1;
						if (reads === 1) {
							return extensionRow === undefined ? [] : [extensionRow];
						}
						return link === undefined ? [] : [link];
					},
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

/** The auth database: one membership table, keyed exactly as the real lookup keys it. */
function fakeRepository(memberships: Readonly<Record<string, string>>): {
	repository: AuthRepository;
	lookups: string[];
} {
	const lookups: string[] = [];
	const repository = {
		findMembership: async (userId: string, organizationId?: string) => {
			lookups.push(`${userId}@${organizationId ?? "*"}`);
			const role = memberships[`${userId}@${organizationId ?? ""}`];
			return role === undefined ? null : { organizationId: organizationId ?? "", role };
		},
	} as unknown as AuthRepository;
	return { repository, lookups };
}

function serviceFor(options: {
	extension?: ExtensionRow | undefined;
	link?: { readonly userId: string } | undefined;
	memberships?: Readonly<Record<string, string>>;
}) {
	const { database, scopes } = fakeDatabase(options.extension, options.link);
	const { repository, lookups } = fakeRepository(options.memberships ?? {});
	return { service: new AuthzService(repository, database), scopes, lookups };
}

function request(overrides: Partial<AuthzCheckRequest> = {}): AuthzCheckRequest {
	return {
		orgId: ORG,
		subject: { type: "user", id: USER },
		permissions: ["calls.supervise"],
		...overrides,
	} as AuthzCheckRequest;
}

describe("AuthzService", () => {
	describe("a user subject", () => {
		it("expands the membership role through the same table the HTTP guard uses", async () => {
			const { service, lookups } = serviceFor({ memberships: { [`${USER}@${ORG}`]: "manager" } });
			const reply = await service.check(request());

			expect(reply.allowed).to.equal(true);
			expect(reply.granted).to.deep.equal(["calls.supervise"]);
			expect(reply.missing).to.have.length(0);
			// Scoped by the REQUEST's organization, not by whichever membership happens to be first.
			expect(lookups).to.deep.equal([`${USER}@${ORG}`]);
		});

		it("denies a member of a DIFFERENT organization without leaking that they exist", async () => {
			const { service } = serviceFor({ memberships: { [`${USER}@${OTHER_ORG}`]: "owner" } });
			const reply = await service.check(request());

			expect(reply.allowed).to.equal(false);
			expect(reply.granted).to.have.length(0);
			// The whole request comes back as missing, so a caller intersecting the two finds its list.
			expect(reply.missing).to.deep.equal(["calls.supervise"]);
			expect(reply.reason).to.contain("not a member");
		});

		it("denies a role that does not carry the permission", async () => {
			// `agent` holds `queues.monitor` and deliberately not `calls.supervise`; the registry's
			// argument for the split is in `packages/auth/src/permissions.ts`.
			const { service } = serviceFor({ memberships: { [`${USER}@${ORG}`]: "agent" } });
			const reply = await service.check(
				request({ permissions: ["queues.monitor", "calls.supervise"] }),
			);

			expect(reply.allowed).to.equal(false);
			expect(reply.granted).to.deep.equal(["queues.monitor"]);
			expect(reply.missing).to.deep.equal(["calls.supervise"]);
		});
	});

	describe("an extension subject", () => {
		const extensionRequest = request({ subject: { type: "extension", id: "1001" } });

		it("resolves the number inside the request's own tenant scope", async () => {
			const { service, scopes } = serviceFor({
				extension: { id: EXTENSION_ID, enabled: true },
				link: { userId: USER },
				memberships: { [`${USER}@${ORG}`]: "manager" },
			});
			const reply = await service.check(extensionRequest);

			expect(reply.allowed).to.equal(true);
			// ONE scope for both selects: two would let the extension be deleted between them.
			expect(scopes).to.deep.equal([ORG]);
		});

		it("crosses into the auth database with the userId the link carried", async () => {
			const { service, lookups } = serviceFor({
				extension: { id: EXTENSION_ID, enabled: true },
				link: { userId: USER },
				memberships: { [`${USER}@${ORG}`]: "manager" },
			});
			await service.check(extensionRequest);

			// The second hop is a separate lookup against a separate handle, because
			// `extension_user.userId` has no foreign key to join on.
			expect(lookups).to.deep.equal([`${USER}@${ORG}`]);
		});

		it("refuses an unknown number", async () => {
			const { service } = serviceFor({ extension: undefined });
			const reply = await service.check(extensionRequest);

			expect(reply.allowed).to.equal(false);
			expect(reply.missing).to.deep.equal(["calls.supervise"]);
			expect(reply.reason).to.contain("no enabled extension 1001");
		});

		it("refuses a DISABLED extension the same way it refuses an unknown one", async () => {
			const { service } = serviceFor({
				extension: { id: EXTENSION_ID, enabled: false },
				link: { userId: USER },
				memberships: { [`${USER}@${ORG}`]: "owner" },
			});
			const reply = await service.check(extensionRequest);

			expect(reply.allowed).to.equal(false);
			expect(reply.reason).to.contain("no enabled extension 1001");
		});

		it("refuses another tenant's extension, because RLS answers the read with nothing", async () => {
			// Indistinguishable from a typo by the time it reaches here, which is exactly the fake's
			// `undefined` — and exactly the point: the caller is never told which it was.
			const { service } = serviceFor({ extension: undefined, link: { userId: USER } });
			const reply = await service.check(extensionRequest);

			expect(reply.allowed).to.equal(false);
			expect(reply.reason).to.contain("no enabled extension 1001");
		});

		it("refuses an extension nobody is PRIMARY on", async () => {
			// A shared line cannot produce the one nameable person the audit row needs.
			const { service } = serviceFor({
				extension: { id: EXTENSION_ID, enabled: true },
				link: undefined,
			});
			const reply = await service.check(extensionRequest);

			expect(reply.allowed).to.equal(false);
			expect(reply.reason).to.contain("primary user");
		});

		it("refuses a link pointing at a user with no membership, which is an ordinary state", async () => {
			// There is no foreign key to stop it: integrity across the two databases is a `user.deleted`
			// repair, not a constraint.
			const { service } = serviceFor({
				extension: { id: EXTENSION_ID, enabled: true },
				link: { userId: USER },
				memberships: {},
			});
			const reply = await service.check(extensionRequest);

			expect(reply.allowed).to.equal(false);
			expect(reply.reason).to.contain("not a member");
		});
	});

	describe("subject types with no resolver", () => {
		for (const type of ["api-key", "service"] as const) {
			it(`answers ${type} with a plain refusal rather than pretending or throwing`, async () => {
				const { service } = serviceFor({ memberships: { [`${USER}@${ORG}`]: "owner" } });
				const reply = await service.check(request({ subject: { type, id: "whatever" } }));

				expect(reply.allowed).to.equal(false);
				expect(reply.granted).to.have.length(0);
				expect(reply.missing).to.deep.equal(["calls.supervise"]);
				// A timeout would be indistinguishable from a denial; this says which it was.
				expect(reply.reason).to.contain("no resolver");
			});
		}
	});

	describe("the partition", () => {
		it("lets an unscoped grant satisfy its own-scoped variant", async () => {
			// The rule lives in `hasPermission`; a responder comparing strings would deny a manager who
			// holds `voicemail.listen` a check for `voicemail.listen.own`.
			const { service } = serviceFor({ memberships: { [`${USER}@${ORG}`]: "manager" } });
			const reply = await service.check(request({ permissions: ["voicemail.listen.own"] }));

			expect(reply.allowed).to.equal(true);
			expect(reply.granted).to.deep.equal(["voicemail.listen.own"]);
		});

		it("allows only when EVERY requested permission is granted", async () => {
			const { service } = serviceFor({ memberships: { [`${USER}@${ORG}`]: "manager" } });
			const reply = await service.check(
				request({ permissions: ["calls.supervise", "secrets.read"] }),
			);

			expect(reply.allowed).to.equal(false);
			expect(reply.granted).to.deep.equal(["calls.supervise"]);
			expect(reply.missing).to.deep.equal(["secrets.read"]);
		});

		it("partitions the request exactly — granted and missing together are what was asked", async () => {
			const asked = ["calls.originate", "calls.supervise", "settings.write.all"];
			const { service } = serviceFor({ memberships: { [`${USER}@${ORG}`]: "manager" } });
			const reply = await service.check(request({ permissions: asked }));

			expect([...reply.granted, ...reply.missing].sort()).to.deep.equal([...asked].sort());
		});

		it("treats a permission this release has never heard of as missing, not as a crash", async () => {
			// Version skew: the engine and the API ship separately, so a newer caller may ask about a
			// grant that does not exist here yet.
			const { service } = serviceFor({ memberships: { [`${USER}@${ORG}`]: "owner" } });
			const reply = await service.check(
				request({ permissions: ["calls.supervise", "calls.teleport"] }),
			);

			expect(reply.allowed).to.equal(false);
			expect(reply.granted).to.deep.equal(["calls.supervise"]);
			expect(reply.missing).to.deep.equal(["calls.teleport"]);
			expect(reply.reason).to.contain("permission registry");
		});
	});
});

describe("AuthzCheckRpcController", () => {
	it("answers a malformed request instead of letting it time out", async () => {
		const controller = new AuthzCheckRpcController({
			check: async () => {
				throw new Error("the service must not be reached");
			},
		} as unknown as AuthzService);

		const reply = await controller.check({
			orgId: "not-a-uuid",
			subject: { type: "extension", id: "1001" },
			permissions: ["calls.supervise"],
		});

		expect(reply.allowed).to.equal(false);
		// The permissions are read off the raw payload, so `missing` still describes what was asked
		// even though the request did not survive parsing.
		expect(reply.missing).to.deep.equal(["calls.supervise"]);
		expect(reply.reason).to.contain("orgId");
	});

	it("still answers when the payload carries no readable permissions at all", async () => {
		const controller = new AuthzCheckRpcController({
			check: async () => {
				throw new Error("the service must not be reached");
			},
		} as unknown as AuthzService);

		const reply = await controller.check("not an object");

		expect(reply.allowed).to.equal(false);
		expect(reply.missing).to.have.length(0);
	});

	it("catches a throwing service, because a timeout and a denial must not look alike", async () => {
		const controller = new AuthzCheckRpcController({
			check: async () => {
				throw new Error("the pool is exhausted");
			},
		} as unknown as AuthzService);

		const reply = await controller.check({
			orgId: ORG,
			subject: { type: "user", id: USER },
			permissions: ["calls.supervise"],
		});

		expect(reply.allowed).to.equal(false);
		expect(reply.missing).to.deep.equal(["calls.supervise"]);
		expect(reply.reason).to.contain("the pool is exhausted");
	});
});
