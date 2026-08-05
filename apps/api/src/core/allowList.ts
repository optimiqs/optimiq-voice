import { identityAllowList } from "@optimiq-voice/identity";

// The Identity public methods come from a single source in @optimiq-voice/identity
// (shared with the standalone Identity service); the api adds its own
// non-identity public methods.
const allowList = [
  ...identityAllowList,
  "/optimiq_voice.voice.v1beta2.Voice/CreateSession"
];

export { allowList };
