import { AllowedHttpMethod, sendHttpRequest, toolSchema } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { Tool } from "./types";

const logger = getLogger({ service: "autopilot", filePath: __filename });

class ToolsCatalog {
	private readonly tools: Map<string, Tool>;

	constructor(tools: Tool[]) {
		this.tools = new Map();

		tools.forEach((tool) => {
			logger.verbose(`adding the '${tool.name}' tool to the catalog`);
			this.addTool(tool);
		});
	}

	async invokeTool(toolName: string, args: Record<string, unknown>) {
		const tool = this.tools.get(toolName);

		if (!tool) {
			throw new Error(`Tool '${toolName}' not found in the catalog`);
		}

		const parsedTool = toolSchema.parse(tool);

		// FIXME: We shouldn't have to check the nullability of the operation
		return await sendHttpRequest({
			method: parsedTool.operation?.method ?? AllowedHttpMethod.GET,
			url: parsedTool.operation?.url ?? "",
			waitForResponse: parsedTool.operation?.waitForResponse,
			headers: parsedTool.operation?.headers ?? {},
			params: args,
		});
	}

	getTool(toolName: string): Tool | undefined {
		return this.tools.get(toolName);
	}

	addTool(toolDef: Tool) {
		this.tools.set(toolDef.name!, toolDef);
	}

	listTools(): Tool[] {
		return Array.from(this.tools.values());
	}
}

export { ToolsCatalog };
