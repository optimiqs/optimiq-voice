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
import { assertCdrPreflight, isCdrAreaEnabled } from "./cdr/cdr-bootstrap";
import { CdrModule } from "./cdr/cdr.module";
import { API_TENANT_RLS_PLAN, createApiTenantRlsIntrospector } from "./core/db/rls-preflight-plan";
import { httpLoggerOptions } from "./core/http/log-redaction";
import { DATABASE_URL, HTTP_BRIDGE_PORT } from "./envs";
import { registerLiveTransport } from "./live/live-bootstrap";
import { LiveModule } from "./live/live.module";
import { assertMailPreflight, loadMailEnv, selectMailTransport } from "./mail";
import { isPbxAreaEnabled, registerPbxTransport } from "./pbx/pbx-bootstrap";
import { PbxModule } from "./pbx/pbx.module";
import { ProvisioningModule } from "./provisioning/provisioning.module";

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
	 * Mail, asserted before anything can send one.
	 *
	 * The unconfigured state is legitimate — every message is rendered and written to this log, so
	 * a developer can complete a sign-up without running a relay — and it is exactly what a
	 * production deployment must never do: verification, password-reset and invitation messages are
	 * one-time links, and a log aggregator is not where they belong. So the fallback is refused in
	 * production and permitted everywhere else, at boot, on the same terms as the RLS and CDR
	 * preflights above: the last moment a misconfiguration can be a refusal to start.
	 */
	const mailEnv = loadMailEnv();
	assertMailPreflight(mailEnv);
	logger.info("mail preflight passed", {
		transport: selectMailTransport(mailEnv),
		host: mailEnv.host ?? null,
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

	/**
	 * The CDR area (P5) is additive and optional in exactly the same way, and gated the same way:
	 * every route it serves is either `@RequirePermissions`-guarded or a signed anonymous media
	 * route, and the guard that enforces the first comes from the auth slice. Mounting the reporting
	 * surface without it would publish an organization's entire call history unauthenticated.
	 *
	 * Its RLS preflight runs BEFORE `NestFactory.create`, alongside the auth database's, for the
	 * reason the CDR contract is worth asserting at all: `call_legs` is append-only by privilege,
	 * and a drifted grant is only detectable before traffic arrives.
	 */
	const cdrAreaEnabled = authSliceEnabled && isCdrAreaEnabled();
	if (isCdrAreaEnabled() && !authSliceEnabled) {
		logger.warn(
			"CDR_DATABASE_URL is set but the auth slice is not configured — the CDR area is NOT " +
				"mounted, because its permission guard comes from the auth slice.",
		);
	}
	if (cdrAreaEnabled) {
		await assertCdrPreflight();
	}

	/**
	 * The live channel rides on the PBX area, not beside it.
	 *
	 * Every topic it serves is a projection of state the PBX area's processes write, and it reads
	 * `PBX_ENV` for the broker URL rather than parsing the environment a second time — so mounting
	 * it without the PBX area would be a socket with nothing on the other end and an environment
	 * contract with two owners.
	 */
	/**
	 * Device provisioning rides on the PBX area for the same reasons, and is gated on exactly the
	 * same two conditions.
	 *
	 * It injects `PBX_DATABASE`, `PBX_EFFECT_RUNTIME` and `PBX_ENV` from `PbxModule` rather than
	 * building a second pool, so without `PBX_DATABASE_URL` there is nothing for it to mount on; and
	 * its CRUD half is a dozen `@RequirePermissions`-guarded endpoints, so without the auth slice
	 * mounting it would publish a tenant's device inventory — including the endpoint that rotates
	 * provisioning credentials — unauthenticated.
	 *
	 * Composed HERE rather than in `AppModule.imports`, deliberately: `AppModule` is the root on a
	 * deployment with no auth slice and no telephony database, and an unconditional import there
	 * would make such a deployment fail to boot on a `PBX_DATABASE_URL` it has no use for. This is
	 * the seam `PbxModule`, `LiveModule` and `CdrModule` are already composed through.
	 */
	const extraModules = [
		...(pbxAreaEnabled ? [PbxModule, ProvisioningModule, LiveModule] : []),
		...(cdrAreaEnabled ? [CdrModule] : []),
	];
	const rootModule: Type<unknown> = authSliceEnabled
		? createApiRootModule([AppModule], extraModules)
		: AppModule;

	/**
	 * `rawBody: true` exists for exactly one route: `POST /api/v1/carrier/webhooks/telnyx`.
	 *
	 * Telnyx signs `${timestamp}|${rawBody}` with Ed25519, and `JSON.parse` followed by
	 * `JSON.stringify` is not the identity function — key order, unicode escaping and number
	 * formatting all move — so a signature verified against the re-serialized body fails for
	 * valid deliveries. (Telnyx's own SDK samples make this mistake; their troubleshooting note
	 * contradicts them and is correct.) Keeping the buffer is the only way the verification can be
	 * real rather than decorative, and the cost is one extra reference to a body Fastify has
	 * already read.
	 */
	/**
	 * `logger` is pino, and it is configured rather than left at its default `false`.
	 *
	 * A silent HTTP layer is not a safe one, it is an unobservable one: with the logger off,
	 * Fastify has nowhere to report a request that died before a controller saw it. Turning it on
	 * means pino now serializes objects that requests hand it, which is why `httpLoggerOptions`
	 * exists — it carries the `redact` path set that keeps `authorization`, `cookie`, `x-api-key`
	 * and the SIP/PIN/token field names out of every line, and it reads the same `LOGS_LEVEL` the
	 * winston logger reads so one variable still governs logging in this process.
	 */
	const app = await NestFactory.create<NestFastifyApplication>(
		rootModule,
		new FastifyAdapter({ logger: httpLoggerOptions() }),
		{ rawBody: true },
	);
	app.enableShutdownHooks();

	// Raw Fastify wiring has to exist before `listen`, which is when Nest installs its own router
	// and not-found handler.
	if (authSliceEnabled) {
		await registerAuthTransport(app);
		logger.info("better-auth mounted on /api/auth/*");
	}
	if (pbxAreaEnabled) {
		await registerPbxTransport(app);
		await registerLiveTransport(app);
	}

	await app.listen(HTTP_BRIDGE_PORT, "0.0.0.0");
	logger.info(`HTTP API is running on port ${HTTP_BRIDGE_PORT}`);
}

bootstrap().catch((error) => {
	logger.error("failed to start API", error);
	process.exitCode = 1;
});
