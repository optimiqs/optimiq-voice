import { Readable } from "stream";
import { createClient, DeepgramClient } from "@deepgram/sdk";
import * as z from "zod";
import { DeepgramVoice } from "@optimiq-voice/common";
import { AbstractTextToSpeech } from "./AbstractTextToSpeech";
import { DeepgramTtsConfig, SynthOptions } from "./types";
import { createChunkedSynthesisStream } from "./utils/createChunkedSynthesisStream";
import { streamToBuffer } from "./utils/streamToBuffer";

const ENGINE_NAME = "tts.deepgram";

class Deepgram extends AbstractTextToSpeech<typeof ENGINE_NAME> {
  client: DeepgramClient;
  engineConfig: DeepgramTtsConfig;
  readonly engineName = ENGINE_NAME;
  protected readonly OUTPUT_FORMAT = "sln16";
  protected readonly CACHING_FIELDS = ["voice"];
  protected readonly AUDIO_ENCODING = "linear16" as const;
  protected readonly SAMPLE_RATE_HERTZ = 8000;

  constructor(config: DeepgramTtsConfig) {
    super();
    this.client = createClient(config.credentials.apiKey);
    this.engineConfig = config;
  }

  synthesize(
    text: string,
    options: SynthOptions
  ): { ref: string; stream: Readable } {
    this.logSynthesisRequest(text, options);

    const { voice } = this.engineConfig.config;
    const ref = this.createMediaReference();
    const selectedVoice =
      (voice as DeepgramVoice) || DeepgramVoice.AURA_ASTERIA_EN;

    const stream = createChunkedSynthesisStream(text, async (chunkText) => {
      const response = await this.client.speak.request(
        { text: chunkText },
        {
          model: selectedVoice,
          encoding: this.AUDIO_ENCODING,
          sample_rate: this.SAMPLE_RATE_HERTZ,
          container: "none"
        }
      );

      return (await streamToBuffer(
        await response.getStream()
      )) as unknown as Readable;
    });

    return { ref, stream };
  }

  static getConfigValidationSchema(): z.Schema {
    return z.object({
      voice: z.nativeEnum(DeepgramVoice, { message: "Invalid Deepgram voice" })
    });
  }

  static getCredentialsValidationSchema(): z.Schema {
    return z.object({
      apiKey: z.string()
    });
  }
}

export { Deepgram, ENGINE_NAME };
