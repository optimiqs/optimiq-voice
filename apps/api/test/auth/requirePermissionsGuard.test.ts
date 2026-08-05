import { Reflector } from "@nestjs/core";
import { expect } from "chai";
import { APP_SESSION_REQUEST_KEY } from "../../src/auth/app-session";
import {
	MissingPermissionException,
	NoActiveOrganizationException,
	UnauthenticatedRequestException,
} from "../../src/auth/auth.errors";
import { PUBLIC_ROUTE_METADATA } from "../../src/auth/public-route.decorator";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import { RequirePermissionsGuard } from "../../src/auth/require-permissions.guard";
import type { AuthService, ResolvedAccess } from "../../src/auth/auth.service";
import type { ExecutionContext } from "@nestjs/common";
import type { AppSession, Permission } from "@optimiq-voice/auth";

/**
 * The deny-by-default contract of the global guard (identity-removal Step 3).
 *
 * The guard is registered as an `APP_GUARD`, so "no metadata" now means "authenticated" rather
 * than "open". `scripts/verify-auth-slice.ts` proves the same rules over real HTTP; this pins
 * them without a server.
 */
describe("@auth/requirePermissionsGuard", function () {
	const session = {
		session: {
			id: "session-1",
			userId: "user-1",
			token: "token",
			expiresAt: new Date(Date.now() + 60_000),
			activeOrganizationId: "019fd3c2-0203-76be-a6b3-b0f1914e39b6",
			impersonatedBy: null,
			ipAddress: null,
			userAgent: null,
		},
		user: {
			id: "user-1",
			email: "member@verify.optimiq.test",
			name: "Member",
			emailVerified: true,
			image: null,
			role: null,
			banned: null,
			twoFactorEnabled: null,
		},
	} as AppSession;

	function buildContext(options: {
		metadata?: Record<string, unknown>;
		session?: AppSession | null;
	}): { context: ExecutionContext; request: Record<string, unknown> } {
		const request: Record<string, unknown> = {
			[APP_SESSION_REQUEST_KEY]: options.session ?? null,
		};
		const handler = () => undefined;
		for (const [key, value] of Object.entries(options.metadata ?? {})) {
			Reflect.defineMetadata(key, value, handler);
		}
		const context = {
			getHandler: () => handler,
			getClass: () => class Controller {},
			switchToHttp: () => ({ getRequest: () => request }),
		} as unknown as ExecutionContext;
		return { context, request };
	}

	function buildGuard(access: ResolvedAccess): RequirePermissionsGuard {
		const authService = {
			resolveAccess: async () => access,
		} as unknown as AuthService;
		return new RequirePermissionsGuard(new Reflector(), authService);
	}

	const noAccess: ResolvedAccess = { organizationId: null, role: null, permissions: [] };

	it("lets a @PublicRoute() handler through without a session", async function () {
		const { context } = buildContext({
			metadata: { [PUBLIC_ROUTE_METADATA]: true },
			session: null,
		});
		expect(await buildGuard(noAccess).canActivate(context)).to.equal(true);
	});

	it("denies an undecorated route to an anonymous caller", async function () {
		const { context } = buildContext({ session: null });
		let thrown: unknown;
		try {
			await buildGuard(noAccess).canActivate(context);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(UnauthenticatedRequestException);
	});

	it("allows an undecorated route to an authenticated caller", async function () {
		const { context } = buildContext({ session });
		expect(await buildGuard(noAccess).canActivate(context)).to.equal(true);
	});

	it("requires an active organization once a permission is demanded", async function () {
		const { context } = buildContext({
			metadata: { [REQUIRE_PERMISSIONS_METADATA]: ["members.read"] as Permission[] },
			session,
		});
		let thrown: unknown;
		try {
			await buildGuard(noAccess).canActivate(context);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(NoActiveOrganizationException);
	});

	it("refuses a role whose template does not grant the permission", async function () {
		const { context } = buildContext({
			metadata: { [REQUIRE_PERMISSIONS_METADATA]: ["members.read"] as Permission[] },
			session,
		});
		let thrown: unknown;
		try {
			await buildGuard({
				organizationId: "org-1",
				role: "agent",
				permissions: ["settings.read"],
			}).canActivate(context);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).to.be.instanceOf(MissingPermissionException);
	});

	it("admits a role whose template grants the permission and stamps the resolved access", async function () {
		const { context, request } = buildContext({
			metadata: { [REQUIRE_PERMISSIONS_METADATA]: ["members.read"] as Permission[] },
			session,
		});
		const granted = await buildGuard({
			organizationId: "org-1",
			role: "manager",
			permissions: ["members.read", "extensions.write"],
		}).canActivate(context);
		expect(granted).to.equal(true);
		const stamped = request[APP_SESSION_REQUEST_KEY] as AppSession;
		expect(stamped.activeOrganizationRole).to.equal("manager");
		expect(stamped.permissions).to.deep.equal(["members.read", "extensions.write"]);
	});

	it("treats an unscoped grant as covering its scoped form", async function () {
		const { context } = buildContext({
			metadata: { [REQUIRE_PERMISSIONS_METADATA]: ["extensions.read.own"] as Permission[] },
			session,
		});
		const granted = await buildGuard({
			organizationId: "org-1",
			role: "manager",
			permissions: ["extensions.read"],
		}).canActivate(context);
		expect(granted).to.equal(true);
	});
});
