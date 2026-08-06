import { Transport } from "@nestjs/microservices";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logger";
import { isPbxSliceConfigured, loadPbxEnv } from "./shared/pbx-env";
import type { INestApplication } from "@nestjs/common";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

export { isPbxSliceConfigured as isPbxAreaEnabled };

/**
 * Attaches the NATS microservice that answers `rpc.routing.v1.resolve`.
 *
 * Must run after `NestFactory.create` (the container has to be able to build `RoutingService`) and
 * before `listen`. Without `NATS_URL` it is a logged no-op: the REST surface is complete on its
 * own, and an API that refused to serve configuration changes because a broker was unreachable
 * would make the control plane depend on the data plane's backbone.
 *
 * `startAllMicroservices` is deliberately awaited rather than fired off: a subscription that
 * failed to establish must surface at boot, not as calls that quietly go nowhere.
 */
export async function registerPbxTransport(app: INestApplication): Promise<boolean> {
	if (!isPbxSliceConfigured()) {
		return false;
	}
	const env = loadPbxEnv();
	await registerPbxMultipart(app, env.PBX_MEDIA_MAX_UPLOAD_BYTES);
	if (env.NATS_URL === undefined) {
		logger.warn(
			`NATS_URL is not set — ${RPC_SUBJECTS.routingResolve} is not served. ` +
				"The engine will have to compile routing itself or run without this API.",
		);
		return false;
	}

	app.connectMicroservice(
		{
			transport: Transport.NATS,
			options: {
				servers: [env.NATS_URL],
				name: "optimiq-api-routing-rpc",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			},
		},
		{ inheritAppConfig: true },
	);
	await app.startAllMicroservices();
	logger.info(`serving ${RPC_SUBJECTS.routingResolve} over NATS`, { servers: env.NATS_URL });
	return true;
}

/**
 * Registers `@fastify/multipart`, which the media library's upload routes need.
 *
 * ## Why it is here, in the area's bootstrap, rather than in `main.ts`
 *
 * A Fastify plugin cannot be registered from a Nest module: modules are built after the HTTP
 * adapter exists and after `NestFactory.create` has already begun accepting route registrations, so
 * the plugin has to be attached to the adapter's instance the way `registerAuthTransport` attaches
 * the auth routes. Putting it in `main.ts` would mean every verify script that boots the area on an
 * ephemeral port — `verify-pbx.ts`, `verify-voicemail.ts`, `verify-media.ts`, `verify-live.ts`,
 * `apps/web`'s smokes — would each have to remember to do it, and the one that forgot would see
 * uploads fail with a 415 that looks like a client bug.
 *
 * They all already call `registerPbxTransport`, so this is the seam that is impossible to miss. It
 * runs BEFORE the `NATS_URL` check on purpose: a deployment without a broker still has a complete
 * REST surface, and "you cannot upload a prompt because you have no message broker" would be
 * nonsense.
 *
 * ## The limits, and which one actually stops a large upload
 *
 * `fileSize` is the enforcement: the plugin stops the underlying stream once the cap is passed,
 * which is what keeps a multi-gigabyte POST from becoming multi-gigabyte resident memory.
 * `media-upload.ts` then checks `part.file.truncated`, because the plugin's default behaviour on
 * hitting the limit is to TRUNCATE rather than throw — a caller that only read the buffer would
 * store the first N bytes as though they were the file.
 *
 * `files: 1` and `fields: 8` bound the other two ways a multipart body can be expensive without
 * being large. `parts` is left at the plugin's default because `files + fields` already bound it.
 *
 * ## Idempotent, because the verify scripts boot more than one app per process
 *
 * Registering the same plugin twice on one Fastify instance throws `FST_ERR_PLUGIN_VERSION_MISMATCH`
 * or a decorator collision depending on the version. The scripts create a fresh app each time, so
 * this should never happen — and it costs one property read to make sure a future harness that
 * reuses an adapter fails with a log line instead of at boot.
 */
export async function registerPbxMultipart(
	app: INestApplication,
	maxUploadBytes: number,
): Promise<void> {
	// `HttpServer.getInstance()` is untyped by design (`ServerInstance = any`); the structural
	// `FastifyPluginHost` below is the only part of Fastify this function touches — the same
	// reasoning `auth-bootstrap.ts` applies to `AuthHttpServer`.
	const server: FastifyPluginHost = app.getHttpAdapter().getInstance();
	if (typeof server.register !== "function") {
		logger.warn("the HTTP adapter is not Fastify — media uploads are not available");
		return;
	}
	if (server.hasContentTypeParser?.("multipart/form-data") === true) {
		return;
	}

	const multipart = (await import("@fastify/multipart")).default;
	await server.register(multipart, {
		limits: { fileSize: maxUploadBytes, files: 1, fields: 8 },
		/**
		 * TRUNCATE at the limit rather than throw, and let `media-upload.ts` raise.
		 *
		 * The plugin's default (`true`) throws its own `RequestFileTooLargeError` out of the part
		 * iterator. That error is not a Nest `HttpException`, so what reaches the client is whatever
		 * the framework makes of a stray throw — measured, a `413` with none of the area's body:
		 * no `code`, no sentence, nothing `apps/web`'s error reader can switch on.
		 *
		 * With `false` the stream stops and sets `part.file.truncated`, which `readUploadedAudio`
		 * already checks (it has to: a caller that only read the buffer would store the first N
		 * bytes as though they were the file). The refusal then comes from
		 * `MediaUploadTooLargeException`, which carries `MEDIA_UPLOAD_TOO_LARGE`, the cap, and a
		 * sentence naming the environment variable that sets it.
		 */
		throwFileSizeLimit: false,
	});
	logger.info("media uploads enabled", { maxUploadBytes });
}

/** The two methods of the Fastify instance this module uses. See {@link registerPbxMultipart}. */
interface FastifyPluginHost {
	register?: (plugin: unknown, options?: unknown) => Promise<unknown>;
	hasContentTypeParser?: (contentType: string) => boolean;
}
