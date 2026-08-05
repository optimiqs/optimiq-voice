import { TestTokenConfiguration } from "../applications/types";
import { API_SIGNALING_SERVER } from "../envs";

const testTokenConfig = {
  username: "internal",
  domain: "internal",
  displayName: "Test Call Agent",
  targetAor: "sip:voice@default",
  signalingServer: API_SIGNALING_SERVER
} as TestTokenConfiguration;

export { testTokenConfig };
