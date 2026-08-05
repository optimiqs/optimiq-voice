import { v4 as uuidv4 } from "uuid";
import {
  DialRecordDirection,
  StreamGatherSource,
  StreamPayload
} from "@optimiq-voice/common";
import { VoiceResponse } from "@optimiq-voice/voice";
import { Voice } from "./types";

class VoiceImpl implements Voice {
  private readonly playbackRef: string;
  mediaSessionRef: string;
  sgatherStream: {
    stop: () => Promise<void>;
    onData: (
      cb: (payload: { speech: string; responseTime: number }) => void
    ) => void;
  };
  vadStream: {
    stop: () => Promise<void>;
    onData: (cb: (chunk: Uint8Array) => void) => void;
  };

  constructor(
    mediaSessionRef: string,
    private readonly voice: VoiceResponse
  ) {
    this.mediaSessionRef = mediaSessionRef;
    this.playbackRef = uuidv4();
  }

  async answer() {
    await this.voice.answer();
  }

  async hangup() {
    await this.voice.hangup();
  }

  async say(text: string) {
    await this.voice.say(text, { playbackRef: this.playbackRef });
  }

  async playDtmf(dtmf: string) {
    await this.voice.playDtmf(dtmf);
  }

  async sgather() {
    const stream = await this.voice.sgather({
      source: StreamGatherSource.SPEECH
    });

    this.sgatherStream = {
      stop: async () => {
        stream.close();
        stream.cleanup(() => {});
      },
      onData: (
        cb: (payload: { speech: string; responseTime: number }) => void
      ) => {
        stream.onPayload(
          (payload: { speech?: string; responseTime: number }) => {
            cb({
              speech: payload.speech!,
              responseTime: payload.responseTime
            });
          }
        );
      }
    };

    return this.sgatherStream;
  }

  async stream() {
    const stream = await this.voice.stream();

    this.vadStream = {
      stop: async () => {
        stream.close();
        stream.cleanup(() => {});
      },
      onData: (cb: (chunk: Uint8Array) => void) => {
        stream.onPayload((payload: StreamPayload) => {
          cb(payload.data!);
        });
      }
    };

    return this.vadStream;
  }

  async transfer(to: string, options: { record: boolean; timeout: number }) {
    const { record, timeout } = options;

    const effectiveOptions = {
      recordDirection: record ? DialRecordDirection.BOTH : undefined,
      timeout
    };

    await this.voice.dial(to, effectiveOptions);
  }

  async stopSpeech() {
    await this.voice.stopSay();
  }

  async stopStreams() {
    await this.vadStream.stop();
    await this.sgatherStream.stop();
  }
}

export { VoiceImpl };
