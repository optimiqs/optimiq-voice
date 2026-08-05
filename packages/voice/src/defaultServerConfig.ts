import { ServerConfig } from "./types";

/**
 * `authUrl` has no default on purpose: leaving it unset makes the server refuse to start rather
 * than silently accept unverified calls. The identity-era `identityAddress` defaulted to
 * `api.optimiq.health`, so a misconfigured deployment quietly talked to production.
 */
const defaultServerConfig: ServerConfig = {
	port: 50061,
	bind: "0.0.0.0",
	skipTokenVerification: false,
};

export { defaultServerConfig };
