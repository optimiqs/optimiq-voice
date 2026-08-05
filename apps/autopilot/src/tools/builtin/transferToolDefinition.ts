import { BuiltInTool } from "../types";

const transferToolDefinition: BuiltInTool = {
	name: "transfer",
	description: "Transfer the call to a live agent",
	parameters: {
		type: "object",
		properties: {
			// FIXME: Workaround for Google LLMs issue
			// GenerateContentRequest.tools[0].function_declarations[1].parameters.properties: should be non-empty for OBJECT type
			noop: {
				type: "boolean",
			},
		},
	},
};

export { transferToolDefinition };
