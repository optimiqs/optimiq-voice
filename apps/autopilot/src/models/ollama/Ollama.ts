import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOllama } from "@langchain/ollama";
import { convertToolToOpenAITool } from "../../tools";
import { Voice } from "../../voice";
import { AbstractLanguageModel } from "../AbstractLanguageModel";
import { TelephonyContext } from "../types";
import { OllamaParams } from "./types";

const LANGUAGE_MODEL_NAME = "llm.ollama";

class Ollama extends AbstractLanguageModel {
	constructor(params: OllamaParams, voice: Voice, telephonyContext: TelephonyContext) {
		const model = new ChatOllama({
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

export { LANGUAGE_MODEL_NAME, Ollama };
