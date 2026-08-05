import { Readable } from "stream";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import * as z from "zod";
import { GoogleVoice } from "@optimiq-voice/common";
import { AbstractTextToSpeech } from "./AbstractTextToSpeech";
import { GoogleTtsConfig, SynthOptions } from "./types";
import { createChunkedSynthesisStream } from "./utils/createChunkedSynthesisStream";
import { isSsml } from "./utils/isSsml";

const ENGINE_NAME = "tts.google";

class Google extends AbstractTextToSpeech<typeof ENGINE_NAME> {
  client: TextToSpeechClient;
  engineConfig: GoogleTtsConfig;
  readonly engineName = ENGINE_NAME;
  protected readonly OUTPUT_FORMAT = "sln16";
  protected readonly CACHING_FIELDS = ["voice"];
  protected readonly AUDIO_ENCODING = "LINEAR16" as const;
  protected readonly SAMPLE_RATE_HERTZ = 8000;

  constructor(config: GoogleTtsConfig) {
    super();
    this.client = new TextToSpeechClient(config);
    this.engineConfig = config;
  }

  synthesize(
    text: string,
    options: SynthOptions
  ): { ref: string; stream: Readable } {
    this.logSynthesisRequest(text, options);

    const ref = this.createMediaReference();
    const { voice } = this.engineConfig.config;
    const lang = `${voice.split("-")[0]}-${voice.split("-")[1]}`;

    const stream = createChunkedSynthesisStream(text, async (chunkText) => {
      const request = {
        input: isSsml(chunkText) ? { ssml: chunkText } : { text: chunkText },
        audioConfig: {
          audioEncoding: this.AUDIO_ENCODING,
          sampleRateHertz: this.SAMPLE_RATE_HERTZ
        },
        voice: {
          languageCode: lang,
          name: voice
        }
      };

      const [response] = await this.client.synthesizeSpeech(request);
      const audioContent = response.audioContent as Buffer;
      // Ignore the first 44 bytes of the response to avoid the WAV header
      return audioContent.subarray(44);
    });

    return { ref, stream };
  }

  static getConfigValidationSchema(): z.Schema {
    return z.object({
      voice: z
        .nativeEnum(GoogleVoice, { message: "Invalid Google voice" })
        .optional()
    });
  }

  static getCredentialsValidationSchema(): z.Schema {
    return z.object({
      client_email: z.string(),
      private_key: z.string()
    });
  }
}

export { ENGINE_NAME, Google };
