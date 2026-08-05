import { ChatAnthropic } from "@langchain/anthropic";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { convertToolToOpenAITool } from "../../tools";
import { Voice } from "../../voice";
import { AbstractLanguageModel } from "../AbstractLanguageModel";
import { TelephonyContext } from "../types";
import { AnthropicParams } from "./types";

const LANGUAGE_MODEL_NAME = "llm.anthropic";

class Anthropic extends AbstractLanguageModel {
	constructor(params: AnthropicParams, voice: Voice, telephonyContext: TelephonyContext) {
		const model = new ChatAnthropic({
			...params,
		}).bindTools(params.tools.map(convertToolToOpenAITool)) as unknown as BaseChatModel;

		super(
			{
				...params,
				model,
			},
			voice,
			telephonyContext,
		);
	}
}

export { Anthropic, LANGUAGE_MODEL_NAME };
