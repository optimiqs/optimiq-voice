import { ServerConfig } from "./types";

const defaultServerConfig: ServerConfig = {
	port: 50061,
	bind: "0.0.0.0",
	identityAddress: "api.optimiq.health",
	skipIdentity: false,
};

export { defaultServerConfig };
