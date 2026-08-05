import { AssistantConfig } from "../../assistants";
import { InvocationResult } from "../types";

/**
 * Maps language model invocation result to the text that should be compared
 * in eval (hangup/transfer use config messages).
 */
export function extractAiResponse(
  response: InvocationResult,
  assistantConfig: AssistantConfig
): string {
  if (response.toolCalls && response.toolCalls.length > 0) {
    const topTool = response.toolCalls[0];
    if (topTool.name === "hangup") {
      return assistantConfig.conversationSettings?.goodbyeMessage ?? "";
    }
    if (topTool.name === "transfer") {
      return (
        assistantConfig.conversationSettings?.transferOptions?.message ?? ""
      );
    }
  }
  return response.content ?? "";
}
