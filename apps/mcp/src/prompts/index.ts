import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCallPrompt } from "./createCallPrompt";

/**
 * Registers all prompts with the MCP server
 * @param server The MCP server instance
 */
export function registerPrompts(server: McpServer) {
  // Register the createCallPrompt
  server.prompt(
    "create_call_prompt",
    "A predefined prompt for creating a call",
    createCallPrompt
  );
}
