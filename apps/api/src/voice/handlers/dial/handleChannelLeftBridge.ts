import { Bridge, Channel } from "ari-client";

function handleChannelLeftBridge(params: { bridge: Bridge; dialed: Channel }) {
  const { dialed, bridge } = params;

  return async () => {
    try {
      dialed.hangup();
    } catch (e) {
      /** We can only try */
    }

    try {
      await bridge.destroy();
    } catch (e) {
      /* Ignore because the bridge might not exist anymore */
    }
  };
}

export { handleChannelLeftBridge };
