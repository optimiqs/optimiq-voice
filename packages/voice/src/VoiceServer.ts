import * as grpc from "@grpc/grpc-js";
import merge from "deepmerge";
import { HealthImplementation } from "grpc-health-check";
import { getServerCredentials, GRPC_SERVING_STATUS, statusMap } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { createCallTokenVerifier } from "./callTokenVerifier";
import { createJwksAuthInterceptor } from "./createJwksAuthInterceptor";
import { createSession } from "./createSession";
import { defaultServerConfig } from "./defaultServerConfig";
import { serviceDefinition } from "./serviceDefinition";
import { ServerConfig, VoiceHandler } from "./types";

const logger = getLogger({ service: "voice", filePath: __filename });

const HEALTH_CHECK_PATH = "/grpc.health.v1.Health/Check";

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

			if (this.config.skipTokenVerification) {
				// Development only. `apps/autopilot` sets it exclusively when NODE_ENV=development and
				// no AUTH_URL is configured; every other combination fails closed below.
				logger.warn("voice server is accepting UNAUTHENTICATED calls (token verification off)");
				server = new grpc.Server();
			} else {
				/**
				 * Identity-removal Step 4, item 2. This used to be
				 * `await getPublicKey(this.config.identityAddress)` — a gRPC call to the identity
				 * service whose RS256 PEM was handed to `createAuthInterceptor`. Tokens are now
				 * verified against the JWKS better-auth publishes, so there is no start-up dependency
				 * on any other service: the first call fetches the keys, and `createRemoteJWKSet`
				 * caches them and refetches on rotation.
				 */
				const verify = createCallTokenVerifier({ authUrl: this.config.authUrl ?? "" });

				server = new grpc.Server({
					interceptors: [createJwksAuthInterceptor(verify, [HEALTH_CHECK_PATH])],
				});
			}

			server.addService(serviceDefinition, {
				createSession: createSession(handler),
			});

			// Add the health check service to the server
			healthImpl.addToServer(server);

			const bindAddr = `${this.config.bind}:${this.config.port}`;

			server.bindAsync(bindAddr, credentials, async () => {
				healthImpl.setStatus("", GRPC_SERVING_STATUS);
				logger.info(`started voice server @ ${this.config.bind}, port=${this.config.port}`);
			});
		} catch (err) {
			logger.error("failed to start voice server", err);
			process.exit(1);
		}
	}
}
