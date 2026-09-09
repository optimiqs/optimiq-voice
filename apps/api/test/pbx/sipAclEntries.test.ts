import { Reflector } from "@nestjs/core";
import { expect } from "chai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { getSystemRoleTemplate } from "@optimiq-voice/auth";
import { makeTestModuleRuntime } from "@optimiq-voice/effect-runtime";
import { APP_SESSION_REQUEST_KEY } from "../../src/auth/app-session";
import { MissingPermissionException } from "../../src/auth/auth.errors";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import { RequirePermissionsGuard } from "../../src/auth/require-permissions.guard";
import { SipAclEntriesController } from "../../src/pbx/security/sip-acl.controller";
import { createSipAclEntryDto, updateSipAclEntryDto } from "../../src/pbx/security/sip-acl.dto";
import { SIP_ACL_ENTRY_RESOURCE } from "../../src/pbx/security/sip-acl.resource";
import { SipAclEntriesService } from "../../src/pbx/security/sip-acl.service";
import { PbxRepository } from "../../src/pbx/shared/pbx.repository";
import type { AuthService, ResolvedAccess } from "../../src/auth/auth.service";
import type { OrganizationSuspensionService } from "../../src/auth/organization-suspension.service";
import type { PbxRepositoryInterface } from "../../src/pbx/shared/pbx.repository";
import type { ExecutionContext } from "@nestjs/common";
import type { AppSession, Permission } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The `sip_acl_entry` CRUD surface — `/api/v1/sip-acl-entries`.
 *
 * The table existed before this wave and had one reader (the provisioning allowlist's raw SQL) and
 * no writer at all. Three things about a write surface for a security control can be wrong without
 * a database to prove it, and those are what this covers:
 *
 *  1. **The network is validated at the EDGE.** A `cidr` column refuses host bits set below the
 *     mask with a `22P02`, which this area has no domain failure for and would therefore render as
 *     a 503. "The service is unavailable" is the wrong thing to show somebody who typed
 *     `10.0.0.1/24`.
 *  2. **Authorization.** `security.write` and not `settings.write`, because opening a network to
 *     the SIP authenticator is not a preference.
 *  3. **The resource declaration.** `network` must not be searchable — it is a `cidr` and `ilike`
 *     over it is either a Postgres error or, cast to text, a matcher where `10.` finds
 *     `110.0.0.0/8`.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const USER = "019fd3c2-9999-76be-a6b3-b0f1914e39b6";
const TRUNK = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";

function sessionFor(): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: ORG,
			ipAddress: null,
			userAgent: "Mozilla/5.0 (test)",
		},
		user: { id: USER, email: "u@test", name: "U", emailVerified: true },
	} as AppSession;
}

/**
 * A guard over the REAL decorator metadata of a real handler, with the role's permissions resolved.
 *
 * The handler is passed rather than a stub so the assertion is about what the controller actually
 * declares — a test that redefined the metadata would pass with the decorator deleted.
 */
function guardFor(
	role: "admin" | "manager" | "agent",
	handler: (...args: never[]) => unknown,
): { guard: RequirePermissionsGuard; context: ExecutionContext } {
	const request: Record<string, unknown> = { [APP_SESSION_REQUEST_KEY]: sessionFor() };
	const context = {
		getHandler: () => handler,
		getClass: () => SipAclEntriesController,
		switchToHttp: () => ({ getRequest: () => request }),
	} as unknown as ExecutionContext;
	const access: ResolvedAccess = {
		organizationId: ORG,
		role: "member",
		permissions: [...getSystemRoleTemplate(role).permissions],
	};
	const authService = { resolveAccess: async () => access } as unknown as AuthService;
	return {
		guard: new RequirePermissionsGuard(new Reflector(), authService, notSuspended()),
		context,
	};
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
		return undefined;
	} catch (cause) {
		return cause;
	}
}

describe("sip ACL entry DTOs", () => {
	it("accepts a network in CIDR form", () => {
		const parsed = createSipAclEntryDto.parse({
			network: "203.0.113.0/24",
			scope: "registration",
		});
		expect(parsed.network).to.equal("203.0.113.0/24");
	});

	it("normalises a bare address to a single-host prefix", () => {
		// So "allow this one server" and its /32 are one row rather than two that collide on the
		// unique index only after Postgres has widened them.
		expect(createSipAclEntryDto.parse({ network: "203.0.113.9", scope: "trunk" }).network).to.equal(
			"203.0.113.9/32",
		);
		expect(createSipAclEntryDto.parse({ network: "2001:db8::1", scope: "trunk" }).network).to.equal(
			"2001:db8::1/128",
		);
	});

	it("refuses host bits below the mask, with a message that says what to write instead", () => {
		// The single most common thing an administrator gets wrong, because it is exactly what they
		// would type reading an address off a router.
		const result = createSipAclEntryDto.safeParse({
			network: "10.0.0.1/24",
			scope: "registration",
		});
		expect(result.success).to.equal(false);
		expect(result.error?.issues[0]?.message).to.contain("/32");
	});

	it("refuses a prefix wider than the family allows", () => {
		expect(
			createSipAclEntryDto.safeParse({ network: "10.0.0.0/33", scope: "registration" }).success,
		).to.equal(false);
		expect(
			createSipAclEntryDto.safeParse({ network: "2001:db8::/129", scope: "trunk" }).success,
		).to.equal(false);
	});

	it("refuses something that is not an address at all", () => {
		for (const network of ["not-a-network", "999.0.0.1", "", "10.0.0.0/abc"]) {
			expect(
				createSipAclEntryDto.safeParse({ network, scope: "registration" }).success,
				network,
			).to.equal(false);
		}
	});

	it("accepts the drastic rules, because refusing them would remove the only way to say them", () => {
		// `0.0.0.0/0` as a deny is how an operator expresses "allowlist only" at all.
		expect(
			createSipAclEntryDto.safeParse({ network: "0.0.0.0/0", scope: "trunk", action: "deny" })
				.success,
		).to.equal(true);
	});

	it("demands a scope rather than defaulting to the one that governs registration", () => {
		// The column defaults to `registration` for rows written by a migration. A form that forgot
		// the field must not silently create a rule about whether phones can register.
		expect(createSipAclEntryDto.safeParse({ network: "203.0.113.0/24" }).success).to.equal(false);
	});

	it("refuses an unknown key rather than dropping it", () => {
		const result = createSipAclEntryDto.safeParse({
			network: "203.0.113.0/24",
			scope: "registration",
			allow: true,
		});
		expect(result.success).to.equal(false);
	});

	it("lets PATCH send one field at a time", () => {
		expect(updateSipAclEntryDto.safeParse({ enabled: false }).success).to.equal(true);
		expect(updateSipAclEntryDto.safeParse({ network: "10.0.0.1/24" }).success).to.equal(false);
	});

	/**
	 * The per-trunk binding — `plans/sipd-invite-design.md` §8.2's open question, closed as a column
	 * on this table rather than a `trunk_acl` child table because one ACL evaluator is worth more
	 * than the shape.
	 */
	it("carries a trunk binding through create", () => {
		const parsed = createSipAclEntryDto.parse({
			network: "203.0.113.0/24",
			scope: "trunk",
			trunkId: TRUNK,
		});
		expect(parsed.trunkId).to.equal(TRUNK);
	});

	/**
	 * Absent means the entry applies to the whole organization, which is what every row meant before
	 * the column existed. Omitting it must therefore stay legal, or the migration would have been
	 * backward-incompatible at the API rather than at the database.
	 */
	it("leaves the binding out when nothing was said, which means the whole organization", () => {
		const parsed = createSipAclEntryDto.parse({ network: "203.0.113.0/24", scope: "trunk" });
		expect(parsed.trunkId).to.equal(undefined);
	});

	/**
	 * `null` CLEARS it and `undefined` leaves it alone. Without the first, an entry bound to the
	 * wrong trunk could only be un-bound by deleting the row and retyping the CIDR — and retyping a
	 * CIDR to fix a dropdown is how the wrong network gets allowed.
	 */
	it("tells 'clear the binding' apart from 'do not touch it' on PATCH", () => {
		expect(updateSipAclEntryDto.parse({ trunkId: null }).trunkId).to.equal(null);
		expect(Object.hasOwn(updateSipAclEntryDto.parse({ enabled: false }), "trunkId")).to.equal(
			false,
		);
	});

	it("refuses a binding that is not an id", () => {
		expect(
			createSipAclEntryDto.safeParse({
				network: "203.0.113.0/24",
				scope: "trunk",
				trunkId: "Telnyx",
			}).success,
		).to.equal(false);
	});
});

describe("the sip ACL resource declaration", () => {
	it("does not search over the cidr column", () => {
		const searchable = SIP_ACL_ENTRY_RESOURCE.searchColumns.map((column) => column.name);
		expect(searchable).to.not.include("network");
	});

	it("orders by priority and then a unique column, so paging cannot repeat a row", () => {
		expect(SIP_ACL_ENTRY_RESOURCE.orderBy.map((column) => column.name)).to.deep.equal([
			"priority",
			"id",
		]);
	});

	it("has no destinations and nothing points at it, so a delete can never orphan a call path", () => {
		expect(SIP_ACL_ENTRY_RESOURCE.destinations).to.deep.equal([]);
		expect(SIP_ACL_ENTRY_RESOURCE.destinationType).to.equal(null);
		expect(SIP_ACL_ENTRY_RESOURCE.scalarReferences).to.equal(undefined);
	});
});

describe("the sip ACL controller's guard", () => {
	const controller = SipAclEntriesController.prototype;

	it("guards reads with security.read and writes with security.write", () => {
		const reflector = new Reflector();
		const readPermissions = reflector.get<string[]>(REQUIRE_PERMISSIONS_METADATA, controller.list);
		const writePermissions = reflector.get<string[]>(
			REQUIRE_PERMISSIONS_METADATA,
			controller.create,
		);
		expect(readPermissions).to.deep.equal(["security.read"]);
		expect(writePermissions).to.deep.equal(["security.write"]);
		// Deleting a rule is the same act as disabling one, so it shares the write grant rather than
		// inventing a `security.delete` nobody could reason about differently.
		expect(reflector.get(REQUIRE_PERMISSIONS_METADATA, controller.remove)).to.deep.equal([
			"security.write",
		]);
	});

	it("lets an administrator write, and refuses a manager", async () => {
		// Deliberate: opening the SIP surface to a network is the same privilege class as issuing
		// credentials, and a manager runs the phone system rather than its perimeter.
		const admin = guardFor("admin", controller.create);
		expect(await admin.guard.canActivate(admin.context)).to.equal(true);

		const manager = guardFor("manager", controller.create);
		expect(await caught(async () => manager.guard.canActivate(manager.context))).to.be.instanceOf(
			MissingPermissionException,
		);
	});

	it("refuses an agent even the listing", async () => {
		const agent = guardFor("agent", controller.list);
		expect(await caught(async () => agent.guard.canActivate(agent.context))).to.be.instanceOf(
			MissingPermissionException,
		);
	});
});

/** A suspension service that says no organization is suspended. See `RequirePermissionsGuard`. */
function notSuspended(): OrganizationSuspensionService {
	return { isSuspended: async () => false } as unknown as OrganizationSuspensionService;
}

/**
 * The `trunk_id` binding, across two tenants.
 *
 * The DTO validates the id's SHAPE and the column's foreign key proves it names a trunk — but an FK
 * check runs as the system and therefore sees every organization's trunks, so neither of those stops
 * tenant A binding an entry to tenant B's trunk. That is not an inert mistake: the column is
 * `on delete cascade`, so B deleting the trunk silently deletes A's allowlist row.
 */
describe("sip ACL entry trunk bindings", () => {
	const ORG_A = ORG;
	const ORG_B = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
	const B_TRUNK = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";

	/** Trunks keyed by the tenant that owns them; the scope is what the fake filters on. */
	function databaseWithTrunks(owned: Readonly<Record<string, readonly string[]>>) {
		let scope = "";
		let wanted = "";
		const chain = (): Record<string, unknown> => {
			const self: Record<string, unknown> = {};
			self.from = () => self;
			self.where = () => self;
			self.limit = async () =>
				(owned[scope] ?? []).includes(wanted) ? [{ id: wanted }] : ([] as unknown[]);
			return self;
		};
		return {
			seek(id: string) {
				wanted = id;
			},
			client: {
				withTenantScope: async <T>(organizationId: string, work: (t: never) => Promise<T>) => {
					scope = organizationId;
					return await work({ select: () => chain() } as never);
				},
			} as unknown as PbxDatabaseClient,
		};
	}

	function serviceFor(database: PbxDatabaseClient): {
		readonly service: SipAclEntriesService;
		readonly created: unknown[][];
	} {
		const created: unknown[][] = [];
		const repository = {
			create: (...args: unknown[]) => {
				created.push(args);
				return Effect.succeed({ row: { id: "row" }, warnings: [] });
			},
			update: (...args: unknown[]) => {
				created.push(args);
				return Effect.succeed({ row: { id: "row" }, warnings: [] });
			},
		} as unknown as PbxRepositoryInterface;
		const layer = Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(repository)));
		const runtime = makeTestModuleRuntime(PbxRepository, layer);
		return { service: new SipAclEntriesService(runtime, database), created };
	}

	function sessionIn(organizationId: string): AppSession {
		const base = sessionFor();
		return {
			...base,
			session: { ...base.session, activeOrganizationId: organizationId },
		} as AppSession;
	}

	it("accepts a trunk the writer's own organization owns", async () => {
		const database = databaseWithTrunks({ [ORG_A]: [TRUNK], [ORG_B]: [B_TRUNK] });
		database.seek(TRUNK);
		const { service, created } = serviceFor(database.client);

		await service.create(sessionIn(ORG_A), { network: "203.0.113.0/24", trunkId: TRUNK });
		expect(created).to.have.lengthOf(1);
	});

	it("refuses a trunk that belongs to another tenant, and writes nothing", async () => {
		const database = databaseWithTrunks({ [ORG_A]: [TRUNK], [ORG_B]: [B_TRUNK] });
		database.seek(B_TRUNK);
		const { service, created } = serviceFor(database.client);

		const error = await caught(async () => {
			await service.create(sessionIn(ORG_A), { network: "203.0.113.0/24", trunkId: B_TRUNK });
		});
		// A 404 rather than a 403: the id came off a row the caller cannot see, so "no such trunk in
		// this organization" is both the honest answer and the one that leaks nothing.
		expect((error as { getStatus?: () => number }).getStatus?.()).to.equal(404);
		expect(created).to.have.lengthOf(0);
	});

	it("leaves an absent binding alone and lets a null one through", async () => {
		const database = databaseWithTrunks({ [ORG_A]: [TRUNK] });
		const { service, created } = serviceFor(database.client);

		await service.update(sessionIn(ORG_A), "entry", { priority: 10 });
		// `null` CLEARS the binding — there is no reference left to prove.
		await service.update(sessionIn(ORG_A), "entry", { trunkId: null });
		expect(created).to.have.lengthOf(2);
	});
});
