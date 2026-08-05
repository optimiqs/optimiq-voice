import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ToolCall } from "@langchain/core/messages/tool";
import { CallDirection } from "@optimiq-voice/types";
import { KnowledgeBase } from "../knowledge";
import { Tool } from "../tools/types";

type LanguageModel = {
	invoke: (text: string, isReentry?: boolean) => Promise<InvocationResult>;
};

type BaseModelParams = {
	firstMessage?: string;
	goodbyeMessage?: string;
	transferOptions: { message: string };
	systemPrompt: string;
	knowledgeBase: KnowledgeBase;
	tools: Tool[];
	telephonyContext: TelephonyContext;
};

type LanguageModelParams = BaseModelParams & {
	model: BaseChatModel;
};

type InvocationResult = {
	type: "say" | "hangup" | "transfer";
	content?: string;
	toolCalls?: ToolCall[];
};

type TelephonyContext = {
	callDirection: CallDirection;
	ingressNumber: string;
	callerNumber: string;
	metadata?: Record<string, string>;
};

export { BaseModelParams, InvocationResult, LanguageModel, LanguageModelParams, TelephonyContext };
