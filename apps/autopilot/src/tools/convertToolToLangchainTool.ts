import { JSONSchemaToZod } from "@dmitryrechkin/json-schema-to-zod";
import { z } from "zod";
import { Tool } from "./types";

type LangchainToolParams = {
	name: string;
	description: string;
	schema: z.ZodObject<z.ZodRawShape>;
};

function convertToolToLangchainTool(customTool: Tool): LangchainToolParams {
	return {
		name: customTool.name,
		description: customTool.description,
		schema: customTool.parameters?.properties
			? (JSONSchemaToZod.convert(customTool.parameters) as z.ZodObject<z.ZodRawShape>)
			: z.object({}),
	};
}

export { convertToolToLangchainTool };
