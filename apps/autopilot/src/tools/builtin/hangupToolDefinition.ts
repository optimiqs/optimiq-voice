import { BuiltInTool } from "../types";

const hangupToolDefinition: BuiltInTool = {
	name: "hangup",
	description: "Hangup the call and end the conversation",
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

export { hangupToolDefinition };
