import * as grpc from "@grpc/grpc-js";
import merge from "deepmerge";
import { HealthImplementation } from "grpc-health-check";
import { struct } from "pb-util";
import { getServerCredentials, GRPC_SERVING_STATUS, statusMap } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { serviceDefinition } from "../serviceDefinition";
import { AuthzHandler, ServerConfig } from "../types";
import { defaultServerConfig } from "./defaultServerConfig";

const logger = getLogger({ service: "authz", filePath: __filename });

class AuthzServer {
	config: ServerConfig;

	constructor(config: ServerConfig = defaultServerConfig) {
		this.config = merge(defaultServerConfig, config);
	}

	async listen(handler: AuthzHandler) {
		try {
			const healthImpl = new HealthImplementation(statusMap);
			const credentials = await getServerCredentials({});

			const server: grpc.Server = new grpc.Server();

			server.addService(serviceDefinition, {
				checkSessionAuthorized: async (
					call: grpc.ServerUnaryCall<any, any>,
					callback: grpc.sendUnaryData<any>,
				) => {
					logger.verbose("checkSessionAuthorized called", call.request);

					try {
						const authorized = await handler.checkSessionAuthorized(call.request);
						callback(null, { authorized });
					} catch (error) {
						logger.error("error in checkSessionAuthorized:", error);
						callback({
							code: grpc.status.INTERNAL,
							message: "Internal server error.",
						});
					}
				},
				checkMethodAuthorized: async (
					call: grpc.ServerUnaryCall<any, any>,
					callback: grpc.sendUnaryData<any>,
				) => {
					logger.verbose("checkMethodAuthorized called", call.request);

					try {
						const authorized = await handler.checkMethodAuthorized(call.request);
						callback(null, { authorized });
					} catch (error) {
						logger.error("error in checkMethodAuthorized:", error);
						callback({
							code: grpc.status.INTERNAL,
							message: "Internal server error.",
						});
					}
				},
				addBillingMeterEvent: async (
					call: grpc.ServerUnaryCall<any, any>,
					callback: grpc.sendUnaryData<any>,
				) => {
					logger.verbose("addBillingMeterEvent called", call.request);

					try {
						const request = {
							accessKeyId: call.request.accessKeyId,
							payload: struct.decode(call.request.payload),
						};
						await handler.addBillingMeterEvent(request);
						callback(null, {});
					} catch (error) {
						logger.error("Error in while adding billing meter event:", error);
						callback({
							code: grpc.status.INTERNAL,
							message: "Internal server error.",
						});
					}
				},
			});

			healthImpl.addToServer(server);

			const bindAddr = `${this.config.bind}:${this.config.port}`;

			server.bindAsync(bindAddr, credentials, async (err, port) => {
				if (err) {
					logger.error("Failed to bind server:", err);
					return;
				}
				healthImpl.setStatus("", GRPC_SERVING_STATUS);
				logger.info(`Authz server started at ${this.config.bind}:${port}`);
			});
		} catch (err) {
			logger.error("Error starting AuthzServer:", err);
		}
	}
}

export { AuthzServer };
