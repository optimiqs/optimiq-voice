import { BaseModelParams } from "../types";

enum OllamaModel {
  LLAMA_3_GROQ_TOOL_USE = "llama3-groq-tool-use"
}

type OllamaParams = BaseModelParams & {
  model: OllamaModel;
  baseUrl?: string;
  maxTokens: number;
  temperature: number;
};

export { OllamaModel, OllamaParams };
