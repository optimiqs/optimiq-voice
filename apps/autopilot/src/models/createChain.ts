import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { RunnableSequence } from "@langchain/core/runnables";
import { KnowledgeBase } from "../knowledge";
import { createChatHistory } from "./chatHistory";
import { createPromptTemplate } from "./createPromptTemplate";

function createChain(
	model: BaseChatModel,
	knowledgeBase: KnowledgeBase,
	promptTemplate: ReturnType<typeof createPromptTemplate>,
	chatHistory: ReturnType<typeof createChatHistory>,
) {
	return RunnableSequence.from([
		{
			input: (input: { text: string }) => input.text,
			context: async (input: { text: string }) => knowledgeBase?.queryKnowledgeBase(input.text),
			history: async () => chatHistory.getMessages(),
		},
		promptTemplate,
		model,
	]);
}

export { createChain };
