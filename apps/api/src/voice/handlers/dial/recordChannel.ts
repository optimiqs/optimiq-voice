import { Client } from "ari-client";
import {
  DialRecordDirection,
  RecordFormat,
  STASIS_APP_NAME
} from "@optimiq-voice/common";

async function recordChannel(
  ari: Client,
  direction: DialRecordDirection.IN | DialRecordDirection.OUT,
  mediaSessionRef: string
) {
  const spy = direction.toLowerCase();

  const channel = await ari.channels.snoopChannel({
    app: STASIS_APP_NAME,
    channelId: mediaSessionRef,
    spy
  });

  return ari.channels.record({
    channelId: channel.id,
    format: RecordFormat.WAV,
    name: `${mediaSessionRef}_${spy}`
  });
}

export { recordChannel };
