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
