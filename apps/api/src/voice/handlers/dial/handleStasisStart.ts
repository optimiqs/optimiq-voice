import { Bridge, Channel, Client } from "ari-client";
import { DialRecordDirection, DialRequest } from "@optimiq-voice/common";
import { recordChannel } from "./recordChannel";

function handleStasisStart(params: {
  ari: Client;
  request: DialRequest;
  bridge: Bridge;
  dialed: Channel;
}) {
  const { ari, request, dialed, bridge } = params;
  const { recordDirection } = request;

  return async (_: undefined, channel: Channel) => {
    try {
      await bridge.addChannel({ channel: dialed.id });

      await ari.channels.ringStop({ channelId: channel.id });

      if (
        [DialRecordDirection.IN, DialRecordDirection.BOTH].includes(
          recordDirection
        )
      ) {
        recordChannel(ari, DialRecordDirection.IN, channel.id);
      }

      if (
        [DialRecordDirection.OUT, DialRecordDirection.BOTH].includes(
          recordDirection
        )
      ) {
        recordChannel(ari, DialRecordDirection.OUT, dialed.id);
      }
    } catch (e) {
      // It is possible that the originating side was already closed
      await dialed.hangup();
    }
  };
}

export { handleStasisStart };
