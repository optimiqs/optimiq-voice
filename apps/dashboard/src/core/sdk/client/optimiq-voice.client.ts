/**
 * Optimiq Voice Client (Browser)
 *
 * @description This file exports a function to create a new instance of the
 * Optimiq Voice WebClient, configured specifically for browser environments.
 *
 * @note This wrapper exists to isolate browser-specific client creation logic.
 * Once the Optimiq Voice SDK exposes proper browser support directly, this file can be safely removed.
 *
 * @TODO Remove this file when the Optimiq Voice Client is fully supported from the main SDK entry point.
 */

import * as SDK from "@optimiq-voice/sdk/dist/web/index.esm.js";
import { Logger } from "~/core/shared/logger";
import { OPTIMIQ_VOICE_CLIENT_CONFIG } from "../stores/optimiq-voice.config";

/**
 * Creates a new instance of the Optimiq Voice WebClient using predefined configuration.
 *
 * @returns {Client} An instance of the Optimiq Voice WebClient, ready for use in browser-based applications.
 */
export const getClient = () => {
  Logger.debug(
    "[optimiq-voice.client] Creating Optimiq Voice WebClient instance"
  );

  const optimiqVoiceClient = new SDK.WebClient(OPTIMIQ_VOICE_CLIENT_CONFIG);
  return optimiqVoiceClient;
};

/**
 * Export the WebClient type or constructor for external type annotations or manual instantiation if needed.
 */
export { SDK };
