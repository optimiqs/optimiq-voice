import "reflect-metadata";
import { Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { getLogger } from "@optimiq-voice/logging";
import { AppModule } from "./app.module";
import {
	createApiRootModule,
	isAuthSliceEnabled,
	registerAuthTransport,
} from "./auth/auth-bootstrap";
import { assertCdrPreflight, isCdrAreaEnabled } from "./cdr/cdr-bootstrap";
import { CdrModule } from "./cdr/cdr.module";
import { httpLoggerOptions } from "./core/http/log-redaction";
import { HTTP_BRIDGE_PORT } from "./envs";
import { registerLiveTransport } from "./live/live-bootstrap";
import { LiveModule } from "./live/live.module";
import { assertMailPreflight, loadMailEnv, selectMailTransport } from "./mail";
import { isPbxAreaEnabled, registerPbxTransport } from "./pbx/pbx-bootstrap";
import { PbxModule } from "./pbx/pbx.module";
import { ProvisioningModule } from "./provisioning/provisioning.module";
import { assertStoragePreflight, loadStorageEnv } from "./storage";

const logger = getLogger("api.bootstrap");

async function bootstrap() {
	/**
	 * There is no tenant-RLS preflight for the base database any more, and its absence is the
	 * point rather than an omission.
	 *
	 * It asserted `api_tenant_tls`'s grants and the `<table>_tenant_isolation` policy on five
	 * tables — `applications`, `secrets`, `tts_services`, `stt_services`, `intelligence_services`
	 * — every one of which belonged to the deleted gRPC platform and has now been dropped (see
	 * `src/core/db/schema.ts` and `drizzle/20260806164427_drop_legacy_api_tables`). A preflight
	 * over an empty table list is not a weaker check, it is a meaningless one: the introspection
	 * query would have to ask PostgreSQL about no tables at all.
	 *
	 * The databases that actually hold tenant rows still assert theirs. `packages/pbx-db` and
	 * `packages/cdr-db` own their roles, grants and policies, and `assertCdrPreflight()` below
	 * runs before `NestFactory.create` for exactly the reason this one used to.
	 */

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
	logger.info(
		{
			transport: selectMailTransport(mailEnv),
			host: mailEnv.host ?? null,
		},
		"mail preflight passed",
	);

	/**
	 * The object store, asserted before anything can write an object into the wrong place.
	 *
	 * `STORAGE_DRIVER=local` is the default and passes unconditionally: one box with a volume is a
	 * legitimate deployment and the shipped `compose.yaml` has no object-store service to point at.
	 * What is refused is a PRODUCTION process that selected `s3` and did not finish configuring it —
	 * it would fall back to the container filesystem and lose every recording on the next deploy,
	 * which is the same class of silent failure the mail preflight above exists to stop. Parsing here
	 * also means a malformed `S3_*` value is a boot failure rather than a 500 on somebody's first
	 * recorded call; the area modules parse the same variables again and cannot disagree, because
	 * nothing here mutates the environment.
	 */
	const storageEnv = loadStorageEnv();
	assertStoragePreflight(storageEnv);
	logger.info(
		{
			driver: storageEnv.driver,
			bucket: storageEnv.bucket ?? null,
			endpoint: storageEnv.endpoint ?? null,
		},
		"storage preflight passed",
	);

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
	logger.error({ err: error }, "failed to start API");
	process.exitCode = 1;
});
