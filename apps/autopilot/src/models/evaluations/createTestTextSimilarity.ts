import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

export function createTestTextSimilarity(
  evalsLanguageModel: {
    provider: any;
    model: string;
    baseUrl?: string;
    apiKey?: string;
  },
  systemPrompt: string
) {
  if (!evalsLanguageModel.apiKey) {
    throw new Error("API key is required for text similarity evaluation.");
  }

  return async function testTextSimilarity(
    text1: string,
    text2: string
  ): Promise<boolean> {
    const llm = new ChatOpenAI({
      model: evalsLanguageModel.model,
      apiKey: evalsLanguageModel.apiKey,
      temperature: 0,
      maxTokens: 10
    });

    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(`Text 1: ${text1}\nText 2: ${text2}`)
    ];

    const response = await llm.invoke(messages);
    const reply = response.content?.toString().trim().toLowerCase();

    return reply === "true" || reply === "yes";
  };
}
