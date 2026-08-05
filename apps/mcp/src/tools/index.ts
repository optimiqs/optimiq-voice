import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	CreateCallBatchSchema,
	CreateCallSchema,
	ListApplicationsSchema,
	ListNumbersSchema,
} from "../schemas";
import { createClient } from "../utils/createClient";
import { createCreateCall } from "./createCreateCall";
import { createCreateCallBatch } from "./createCreateCallBatch";
import { createListApplications } from "./createListApplications";
import { createListNumbers } from "./createListNumbers";

/**
 * Registers all tools with the MCP server
 * @param server The MCP server instance
 * @param client The Optimiq Voice client
 */
export async function registerTools(server: McpServer) {
	const client = await createClient();

	server.tool(
		"list_numbers",
		"Returns a list of numbers from Optimiq Voice in a table format (using markdown)",
		ListNumbersSchema.shape as Record<string, unknown>,
		createListNumbers(client),
	);

	server.tool(
		"list_applications",
		"Lists applications from Optimiq Voice in a table format (using markdown)",
		ListApplicationsSchema.shape as Record<string, unknown>,
		createListApplications(client),
	);

	server.tool(
		"create_call",
		"Creates a call from Optimiq Voice",
		CreateCallSchema.shape as Record<string, unknown>,
		createCreateCall(client),
	);

	server.tool(
		"create_call_batch",
		"Creates a batch of calls from Optimiq Voice",
		CreateCallBatchSchema.shape as Record<string, unknown>,
		createCreateCallBatch(client),
	);
}
