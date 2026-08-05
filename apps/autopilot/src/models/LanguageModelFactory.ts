import { LanguageModelProvider } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { Voice } from "../voice";
import { AbstractLanguageModel } from "./AbstractLanguageModel";
import {
  Anthropic,
  LANGUAGE_MODEL_NAME as ANTHROPIC_LLM_NAME,
  AnthropicParams
} from "./anthropic";
import {
  Google,
  LANGUAGE_MODEL_NAME as GOOGLE_LLM_NAME,
  GoogleParams
} from "./google";
import { Groq, LANGUAGE_MODEL_NAME as GROQ_LLM_NAME, GroqParams } from "./groq";
import {
  Ollama,
  LANGUAGE_MODEL_NAME as OLLAMA_LLM_NAME,
  OllamaParams
} from "./ollama";
import {
  OpenAI,
  LANGUAGE_MODEL_NAME as OPENAI_LLM_NAME,
  OpenAIParams
} from "./openai";
import { BaseModelParams, TelephonyContext } from "./types";
const logger = getLogger({ service: "autopilot", filePath: __filename });

type LanguageModelConstructor<T extends BaseModelParams = BaseModelParams> =
  new (
    options: T,
    voice: Voice,
    telephonyContext: TelephonyContext
  ) => AbstractLanguageModel;

type LanguageModelConfigMap = {
  [LanguageModelProvider.OPENAI]: OpenAIParams;
  [LanguageModelProvider.GROQ]: GroqParams;
  [LanguageModelProvider.OLLAMA]: OllamaParams;
  [LanguageModelProvider.GOOGLE]: GoogleParams;
  [LanguageModelProvider.ANTHROPIC]: AnthropicParams;
};

class LanguageModelFactory {
  private static readonly languageModels: Map<
    string,
    LanguageModelConstructor
  > = new Map();

  static registerLanguageModel<T extends BaseModelParams>(
    name: string,
    ctor: LanguageModelConstructor<T>
  ) {
    logger.verbose("registering llm provider", { name });
    this.languageModels.set(name, ctor);
  }

  static getLanguageModel<T extends keyof LanguageModelConfigMap>(
    languageModel: T,
    config: LanguageModelConfigMap[T],
    voice: Voice,
    telephonyContext: TelephonyContext
  ): AbstractLanguageModel {
    const LanguageModelConstructor = this.languageModels.get(
      `llm.${languageModel}`
    );
    if (!LanguageModelConstructor) {
      throw new Error(`Language model ${languageModel} not found`);
    }
    return new LanguageModelConstructor(config, voice, telephonyContext);
  }
}

// Register language models
LanguageModelFactory.registerLanguageModel(OPENAI_LLM_NAME, OpenAI);
LanguageModelFactory.registerLanguageModel(GROQ_LLM_NAME, Groq);
LanguageModelFactory.registerLanguageModel(OLLAMA_LLM_NAME, Ollama);
LanguageModelFactory.registerLanguageModel(GOOGLE_LLM_NAME, Google);
LanguageModelFactory.registerLanguageModel(ANTHROPIC_LLM_NAME, Anthropic);

export { LanguageModelFactory };
