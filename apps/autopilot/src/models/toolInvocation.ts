import { getLogger } from "@optimiq-voice/logger";
import { ToolsCatalog } from "../tools";
import { createChatHistory } from "./chatHistory";

const logger = getLogger({ service: "autopilot", filePath: __filename });

async function toolInvocation(params: {
	toolName: string;
	chatHistory: ReturnType<typeof createChatHistory>;
	toolsCatalog: ToolsCatalog;
	isFirstTool: boolean;
	args: Record<string, unknown>;
}): Promise<string> {
	const { isFirstTool, args, toolName, chatHistory, toolsCatalog } = params;

	try {
		if (isFirstTool) {
			const tool = toolsCatalog.getTool(toolName);
			const message = tool?.requestStartMessage ?? "";
			if (message) {
				await chatHistory.addAIMessage(message);
			}
		}

		const toolResult = await toolsCatalog.invokeTool(toolName, args);

		logger.verbose(`tool result (${toolName}):`, { result: toolResult.result });

		await chatHistory.addAIMessage(`tool result (${toolName}): ${toolResult.result}`);

		return toolResult.result;
	} catch (error) {
		logger.error(`tool error: ${error.message}`);

		await chatHistory.addAIMessage(`tool error: ${error.message}`);

		return "";
	}
}

export { toolInvocation };
