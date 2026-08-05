import * as grpc from "@grpc/grpc-js";
import { HealthImplementation } from "grpc-health-check";
import {
  createAuthInterceptor,
  createServiceDefinition,
  getServerCredentials,
  GRPC_NOT_SERVING_STATUS,
  GRPC_SERVING_STATUS,
  statusMap
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { buildIdentityService, identityAllowList, upsertDefaultUser } from "..";
import { loadConfig } from "./config";
import { startHttpBridge } from "./httpBridge";

const logger = getLogger({ service: "identity", filePath: __filename });

function bindGrpcServer(
  server: grpc.Server,
  bindAddr: string,
  credentials: grpc.ServerCredentials
) {
  return new Promise<void>((resolve, reject) => {
    server.bindAsync(bindAddr, credentials, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeGrpcServer(server: grpc.Server) {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      server.forceShutdown();
      resolve();
    }, 5000);

    server.tryShutdown(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Standalone Identity gRPC service. Wraps `buildIdentityService` with the auth
 * interceptor, the identity allow-list, a health service, and the accept-invite
 * HTTP bridge — without any telephony subsystem. Configured entirely from a
 * file (see `./config`); no environment variables.
 */
async function main() {
  const { bindAddr, httpBridgePort, appUrl, defaultUser, identityConfig } =
    loadConfig();

  const { definition, handlers } = buildIdentityService(identityConfig);

  const authorization = createAuthInterceptor(
    identityConfig.publicKey,
    identityAllowList
  );
  const credentials = await getServerCredentials({});
  const healthImpl = new HealthImplementation(statusMap);

  const server = new grpc.Server({ interceptors: [authorization] });
  healthImpl.addToServer(server);
  server.addService(
    createServiceDefinition(definition),
    handlers as unknown as grpc.UntypedServiceImplementation
  );

  if (defaultUser) {
    await upsertDefaultUser(identityConfig, defaultUser);
  }

  await bindGrpcServer(server, bindAddr, credentials);
  healthImpl.setStatus("", GRPC_SERVING_STATUS);
  logger.info(`Identity service running at ${bindAddr}`);

  let httpBridge;
  try {
    httpBridge = await startHttpBridge(identityConfig, {
      port: httpBridgePort,
      appUrl
    });
  } catch (error) {
    healthImpl.setStatus("", GRPC_NOT_SERVING_STATUS);
    await closeGrpcServer(server);
    throw error;
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    if (!shutdownPromise) {
      healthImpl.setStatus("", GRPC_NOT_SERVING_STATUS);
      shutdownPromise = Promise.all([
        httpBridge.close(),
        closeGrpcServer(server)
      ]).then(() => undefined);
    }
    return shutdownPromise;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      shutdown().catch((error) => {
        logger.error("failed to stop Identity service", error);
        server.forceShutdown();
        process.exitCode = 1;
      });
    });
  }
}

main().catch((error) => {
  logger.error(error);
  process.exit(1);
});
