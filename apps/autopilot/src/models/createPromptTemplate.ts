import {
	ChatPromptTemplate,
	HumanMessagePromptTemplate,
	MessagesPlaceholder,
	SystemMessagePromptTemplate,
} from "@langchain/core/prompts";
import { createSystemPrompt } from "./createSystemPrompt";
import { TelephonyContext } from "./types";

export function createPromptTemplate(params: {
	firstMessage?: string;
	systemPrompt: string;
	telephonyContext: TelephonyContext;
}) {
	const { firstMessage, systemPrompt, telephonyContext } = params;

	return ChatPromptTemplate.fromMessages([
		SystemMessagePromptTemplate.fromTemplate(
			createSystemPrompt({
				firstMessage,
				systemPrompt,
				telephonyContext,
			}),
		),
		new MessagesPlaceholder("history"),
		HumanMessagePromptTemplate.fromTemplate("{input}"),
	]);
}
