import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGroq } from "@langchain/groq";
import { convertToolToOpenAITool } from "../../tools";
import { Voice } from "../../voice";
import { AbstractLanguageModel } from "../AbstractLanguageModel";
import { TelephonyContext } from "../types";
import { GroqParams } from "./types";

const LANGUAGE_MODEL_NAME = "llm.groq";

class Groq extends AbstractLanguageModel {
	constructor(params: GroqParams, voice: Voice, telephonyContext: TelephonyContext) {
		const model = new ChatGroq({
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

export { Groq, LANGUAGE_MODEL_NAME };
