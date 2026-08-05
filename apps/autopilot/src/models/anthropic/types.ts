import { BaseModelParams } from "../types";

enum AnthropicModel {
  CLAUDE_SONNET_4_5 = "claude-sonnet-4-5",
  CLAUDE_HAIKU_4_5 = "claude-haiku-4-5",
  CLAUDE_OPUS_4_5 = "claude-opus-4-5"
}

type AnthropicParams = BaseModelParams & {
  model: AnthropicModel;
  apiKey: string;
  maxTokens: number;
  temperature: number;
};

export { AnthropicModel, AnthropicParams };
