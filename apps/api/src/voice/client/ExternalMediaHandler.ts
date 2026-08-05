import { Bridge, Client } from "ari-client";
import { VoiceClientConfig } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { AriEvent } from "../types";
import { createExternalMediaConfig } from "../utils/createExternalMediaConfig";

const logger = getLogger({ service: "api", filePath: __filename });

class ExternalMediaHandler {
  private ari: Client;
  private bridge: Bridge;
  private config: VoiceClientConfig;

  constructor(params: { ari: Client; config: VoiceClientConfig }) {
    this.ari = params.ari;
    this.config = params.config;
  }

  async setupExternalMedia(port: number): Promise<void> {
    const bridge = this.ari.Bridge();
    const channel = this.ari.Channel();

    await bridge.create({ type: "mixing" });

    logger.verbose("creating external media config", {
      port,
      mediaSessionRef: this.config.mediaSessionRef,
      bridgeId: bridge.id
    });

    channel.externalMedia(createExternalMediaConfig(port));

    channel.once(AriEvent.STASIS_START, async (_, channel) => {
      bridge.addChannel({ channel: [this.config.mediaSessionRef, channel.id] });
      logger.verbose("added channel to bridge", {
        mediaSessionRef: this.config.mediaSessionRef,
        channelId: channel.id
      });
    });

    channel.once("ChannelLeftBridge", async () => {
      logger.verbose("channel left bridge", {
        mediaSessionRef: this.config.mediaSessionRef,
        bridgeId: bridge.id
      });

      try {
        await bridge.destroy();
      } catch (e) {
        // We can only try
      }
    });

    this.bridge = bridge;
  }

  getBridge(): Bridge {
    return this.bridge;
  }
}

export { ExternalMediaHandler };
