import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { convertToolToOpenAITool } from "../../tools";
import { Voice } from "../../voice";
import { AbstractLanguageModel } from "../AbstractLanguageModel";
import { TelephonyContext } from "../types";
import { OpenAIParams } from "./types";

const LANGUAGE_MODEL_NAME = "llm.openai";

class OpenAI extends AbstractLanguageModel {
  constructor(
    params: OpenAIParams,
    voice: Voice,
    telephonyContext: TelephonyContext
  ) {
    const model = new ChatOpenAI({
      ...params
    }).bindTools(
      params.tools.map(convertToolToOpenAITool)
    ) as unknown as BaseChatModel;

    super(
      {
        ...params,
        model
      },
      voice,
      telephonyContext
    );
  }
}

export { LANGUAGE_MODEL_NAME, OpenAI };
