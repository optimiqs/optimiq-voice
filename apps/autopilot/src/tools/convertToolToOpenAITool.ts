import { OpenAITool, Tool } from "./types";

function convertToolToOpenAITool(tool: Tool): OpenAITool {
	return {
		type: "function",
		function: {
			...tool,
		},
	};
}

export { convertToolToOpenAITool };
