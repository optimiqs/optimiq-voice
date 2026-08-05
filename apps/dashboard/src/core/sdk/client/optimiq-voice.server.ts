/**
 * Optimiq Voice Client (Server)
 *
 * @description This file exports a function to create a new instance of the
 * Optimiq Voice Client for server-side environments. It uses the Node-specific build
 * of the Optimiq Voice SDK and is configured via a predefined server config object.
 *
 * @note This wrapper allows centralized client configuration and caching,
 * which helps ensure consistent behavior and performance in server contexts.
 *
 * @TODO Remove this file when the Optimiq Voice Client is officially exposed
 * by the main optimiq-voice/sdk package in a platform-agnostic way.
 */

import { cache } from "react";
import * as SDK from "@optimiq-voice/sdk/dist/node/node.js";
import { Logger } from "~/core/shared/logger";
import { OPTIMIQ_VOICE_SERVER_CONFIG } from "../stores/optimiq-voice.config";

/**
 * Creates and returns a memoized (cached) instance of the Optimiq Voice Client
 * for server-side use, using a predefined server configuration.
 *
 * The `cache()` utility ensures that the same instance is reused across
 * multiple calls within the same request lifecycle (as used in server-rendered apps).
 *
 * @returns {Client} A configured instance of the Optimiq Voice SDK Client for Node.js.
 */
export const getClient = cache(() => {
	Logger.debug("[optimiq-voice.server] Creating Optimiq Voice Client instance");

	const optimiqVoiceClient = new SDK.Client(OPTIMIQ_VOICE_SERVER_CONFIG);
	return optimiqVoiceClient;
});

/**
 * Re-export the Client class for type usage or advanced instantiation.
 */
export { SDK };
