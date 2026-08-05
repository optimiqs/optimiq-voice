import * as grpc from "@grpc/grpc-js";
import merge from "deepmerge";
import { HealthImplementation } from "grpc-health-check";
import {
  createAuthInterceptor,
  getPublicKey,
  getServerCredentials,
  GRPC_SERVING_STATUS,
  statusMap
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { createSession } from "./createSession";
import { defaultServerConfig } from "./defaultServerConfig";
import { serviceDefinition } from "./serviceDefinition";
import { ServerConfig, VoiceHandler } from "./types";

const logger = getLogger({ service: "voice", filePath: __filename });

export default class VoiceServer {
  config: ServerConfig;
  constructor(config: ServerConfig = defaultServerConfig) {
    this.config = merge(defaultServerConfig, config);
  }

  async listen(handler: VoiceHandler) {
    try {
      const healthImpl = new HealthImplementation(statusMap);
      const credentials = await getServerCredentials({});

      let server: grpc.Server;

      if (this.config.skipIdentity) {
        server = new grpc.Server();
      } else {
        // Get the public key from the identity service
        const response = await getPublicKey(this.config.identityAddress);

        const authorization = createAuthInterceptor(response.publicKey, [
          "/grpc.health.v1.Health/Check"
        ]);

        server = new grpc.Server({
          interceptors: [authorization]
        });
      }

      server.addService(serviceDefinition, {
        createSession: createSession(handler)
      });

      // Add the health check service to the server
      healthImpl.addToServer(server);

      const bindAddr = `${this.config.bind}:${this.config.port}`;

      server.bindAsync(bindAddr, credentials, async () => {
        healthImpl.setStatus("", GRPC_SERVING_STATUS);
        logger.info(
          `started voice server @ ${this.config.bind}, port=${this.config.port}`
        );
      });
    } catch (err) {
      if (err.code === grpc.status.UNAVAILABLE) {
        logger.error("failed to connect to identity service");
      } else {
        logger.error("failed to start voice server", err);
      }
      process.exit(1);
    }
  }
}
