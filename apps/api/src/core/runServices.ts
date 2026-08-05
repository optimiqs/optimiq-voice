import * as grpc from "@grpc/grpc-js";
import { HealthImplementation } from "grpc-health-check";
import { createCheckMethodAuthorized } from "@optimiq-voice/authz";
import {
	createAuthInterceptor,
	getServerCredentials,
	GRPC_NOT_SERVING_STATUS,
	GRPC_SERVING_STATUS,
	statusMap,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { createCreateCallSubscriber as runCallManager } from "../calls/runCallManager";
import {
	API_BIND_ADDR,
	ASTERISK_ARI_PROXY_URL,
	ASTERISK_ARI_SECRET,
	ASTERISK_ARI_USERNAME,
	AUTHZ_SERVICE_ENABLED,
	AUTHZ_SERVICE_HOST,
	AUTHZ_SERVICE_METHODS,
	AUTHZ_SERVICE_PORT,
	IDENTITY_PUBLIC_KEY,
	NATS_URL,
} from "../envs";
import { connectToAri } from "../voice/connectToAri";
import { allowList } from "./allowList";
import loadServices from "./loadServices";
import services from "./services";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

const authorization = createAuthInterceptor(IDENTITY_PUBLIC_KEY, allowList);
const checkMethodAuthorized = createCheckMethodAuthorized(
	`${AUTHZ_SERVICE_HOST}:${AUTHZ_SERVICE_PORT}`,
	AUTHZ_SERVICE_METHODS,
);

type RunningServices = {
	close(): Promise<void>;
};

async function runServices(): Promise<RunningServices> {
	const healthImpl = new HealthImplementation(statusMap);
	const credentials = await getServerCredentials({});
	const interceptors = AUTHZ_SERVICE_ENABLED
		? [authorization, checkMethodAuthorized]
		: [authorization];

	const server = new grpc.Server({ interceptors });

	// Add the health check service to the server
	healthImpl.addToServer(server);

	// Load the remaining services
	loadServices(server, await services);

	// Connecting to Asterisk ARI
	await connectToAri();

	// Additional Call Managers subscriber may be added here to handle call events
	await runCallManager({
		natsUrl: NATS_URL,
		ariProxyUrl: ASTERISK_ARI_PROXY_URL,
		ariUsername: ASTERISK_ARI_USERNAME,
		ariPassword: ASTERISK_ARI_SECRET,
	});

	await new Promise<void>((resolve, reject) => {
		server.bindAsync(API_BIND_ADDR, credentials, (error) => {
			if (error) {
				reject(error);
				return;
			}

			healthImpl.setStatus("", GRPC_SERVING_STATUS);
			logger.info(`api running at ${API_BIND_ADDR}`);
			resolve();
		});
	});

	return {
		close: () =>
			new Promise<void>((resolve) => {
				healthImpl.setStatus("", GRPC_NOT_SERVING_STATUS);
				const timeout = setTimeout(() => {
					server.forceShutdown();
					resolve();
				}, 5000);

				server.tryShutdown(() => {
					clearTimeout(timeout);
					resolve();
				});
			}),
	};
}

export default runServices;
export { type RunningServices };
