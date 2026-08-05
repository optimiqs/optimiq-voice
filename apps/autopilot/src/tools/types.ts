import { z } from "zod";
import { toolSchema } from "@optimiq-voice/common";

type Tool = z.infer<typeof toolSchema>;

type BuiltInTool = Omit<Tool, "operation">;

type OpenAITool = {
	type: "function";
	function: Omit<Tool, "operation">;
};

export { OpenAITool, Tool, BuiltInTool };
