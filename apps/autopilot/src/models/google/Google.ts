import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { convertToolToLangchainTool } from "../../tools/convertToolToLangchainTool";
import { Voice } from "../../voice";
import { AbstractLanguageModel } from "../AbstractLanguageModel";
import { TelephonyContext } from "../types";
import { GoogleParams } from "./types";

const LANGUAGE_MODEL_NAME = "llm.google";

class Google extends AbstractLanguageModel {
  constructor(
    params: GoogleParams,
    voice: Voice,
    telephonyContext: TelephonyContext
  ) {
    const model = new ChatGoogleGenerativeAI({
      ...params
    }).bindTools(
      params.tools.map(convertToolToLangchainTool)
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

export { Google, LANGUAGE_MODEL_NAME };
