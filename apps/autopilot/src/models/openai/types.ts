import { BaseModelParams } from "../types";

enum OpenAIModel {
  GPT_4O = "gpt-4o",
  GPT_4O_MINI = "gpt-4o-mini",
  GPT_3_5_TURBO = "gpt-3.5-turbo",
  GPT_4_TURBO = "gpt-4-turbo"
}

type OpenAIParams = BaseModelParams & {
  model: OpenAIModel;
  apiKey: string;
  maxTokens: number;
  temperature: number;
};

export { OpenAIModel, OpenAIParams };
