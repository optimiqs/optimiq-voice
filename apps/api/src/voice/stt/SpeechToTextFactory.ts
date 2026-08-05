import { getLogger } from "@optimiq-voice/logger";
import { AbstractSpeechToText } from "./AbstractSpeechToText";
import { Deepgram, ENGINE_NAME as DEEPGRAM_ENGINE_NAME } from "./Deepgram";
import { Google, ENGINE_NAME as GOOGLE_ENGINE_NAME } from "./Google";
import { SttConfig } from "./types";

const logger = getLogger({ service: "api", filePath: __filename });

type EngineConstructor<T extends SttConfig = SttConfig> = new (
  options: T
) => AbstractSpeechToText<string>;

class SpeechToTextFactory {
  private static engines: Map<string, EngineConstructor> = new Map();

  static registerEngine<T extends SttConfig>(
    name: string,
    ctor: EngineConstructor<T>
  ) {
    logger.verbose("registering stt engine", { name });
    this.engines.set(name, ctor);
  }

  static getEngine<T extends SttConfig>(
    engineName: string,
    config: T
  ): AbstractSpeechToText<string> {
    const EngineConstructor = this.engines.get(engineName);
    if (!EngineConstructor) {
      throw new Error(`Engine ${engineName} not found`);
    }
    return new EngineConstructor(config);
  }
}

// Register engines
SpeechToTextFactory.registerEngine(GOOGLE_ENGINE_NAME, Google);
SpeechToTextFactory.registerEngine(DEEPGRAM_ENGINE_NAME, Deepgram);

export { SpeechToTextFactory };
