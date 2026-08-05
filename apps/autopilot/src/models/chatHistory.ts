import { InMemoryChatMessageHistory } from "@langchain/core/chat_history";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

export function createChatHistory() {
	const chatHistory = new InMemoryChatMessageHistory();

	return {
		getMessages: () => chatHistory.getMessages(),
		addUserMessage: (text: string) => chatHistory.addMessage(new HumanMessage(text)),
		addAIMessage: (text: string) => chatHistory.addMessage(new AIMessage(text)),
		clear: () => chatHistory.clear(),
	};
}
