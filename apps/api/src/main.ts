import "reflect-metadata";
import { Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { assertTenantRlsPreflight } from "@optimiq-voice/db";
import { getLogger } from "@optimiq-voice/logger";
import { AppModule } from "./app.module";
import {
	createApiRootModule,
	isAuthSliceEnabled,
	registerAuthTransport,
} from "./auth/auth-bootstrap";
import { API_TENANT_RLS_PLAN, createApiTenantRlsIntrospector } from "./core/db/rls-preflight-plan";
import { DATABASE_URL, HTTP_BRIDGE_PORT } from "./envs";
import { isPbxAreaEnabled, registerPbxTransport } from "./pbx/pbx-bootstrap";
import { PbxModule } from "./pbx/pbx.module";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

async function bootstrap() {
	/**
	 * Identity-removal **Step 5 item 3** — assert the telephony database's tenant contract before
	 * anything can serve a request.
	 *
	 * The tenant role, its grants and the per-table policies are the only thing standing between
	 * two tenants once `db.forOrganization(...)` is in the read path, and a policy that silently
	 * failed to apply looks exactly like one that works until the day it does not. Booting is the
	 * last moment a misconfiguration can be turned into a refusal to start rather than a leak, so
	 * it runs here, before `NestFactory.create`.
	 */
	const preflight = await assertTenantRlsPreflight(
		API_TENANT_RLS_PLAN,
		createApiTenantRlsIntrospector(DATABASE_URL),
	);
	logger.info("tenant RLS preflight passed", {
		role: API_TENANT_RLS_PLAN.roleName,
		tables: preflight.tables.length,
	});

	/**
	 * The better-auth slice is additive and optional: an environment without `DATABASE_URL` /
	 * `AUTH_SECRET` / `AUTH_URL` still boots the gRPC identity path exactly as before.
	 */
	const authSliceEnabled = isAuthSliceEnabled();
	if (!authSliceEnabled) {
		logger.info("better-auth slice disabled (DATABASE_URL, AUTH_SECRET or AUTH_URL not set)");
	}

	/**
	 * The PBX area (P3) is additive and optional in exactly the same way, and for the same reason:
	 * an environment without `PBX_DATABASE_URL` boots everything that came before it untouched. It
	 * is mounted only alongside the auth slice, because every one of its routes is guarded by
	 * `@RequirePermissions` and the guard the auth slice registers is what enforces that — mounting
	 * the CRUD surface without it would publish eleven unauthenticated tenant-scoped resources.
	 */
	const pbxAreaEnabled = authSliceEnabled && isPbxAreaEnabled();
	if (isPbxAreaEnabled() && !authSliceEnabled) {
		logger.warn(
			"PBX_DATABASE_URL is set but the auth slice is not configured — the PBX area is NOT " +
				"mounted, because its permission guard comes from the auth slice.",
		);
	}

	const rootModule: Type<unknown> = authSliceEnabled
		? createApiRootModule([AppModule], pbxAreaEnabled ? [PbxModule] : [])
		: AppModule;

	const app = await NestFactory.create<NestFastifyApplication>(rootModule, new FastifyAdapter());
	app.enableShutdownHooks();

	// Raw Fastify wiring has to exist before `listen`, which is when Nest installs its own router
	// and not-found handler.
	if (authSliceEnabled) {
		await registerAuthTransport(app);
		logger.info("better-auth mounted on /api/auth/*");
	}
	if (pbxAreaEnabled) {
		await registerPbxTransport(app);
	}

	await app.listen(HTTP_BRIDGE_PORT, "0.0.0.0");
	logger.info(`HTTP API is running on port ${HTTP_BRIDGE_PORT}`);
}

bootstrap().catch((error) => {
	logger.error("failed to start API", error);
	process.exitCode = 1;
});
