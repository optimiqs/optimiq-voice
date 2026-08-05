#!/usr/bin/env node
import { readFileSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getLogger } from "@optimiq-voice/logger";
import { registerPrompts } from "./prompts/index";
import { registerTools } from "./tools/index";

const logger = getLogger({ service: "mcp", filePath: __filename });

async function main() {
	// Read package.json using fs module
	const packageJsonPath = join(__dirname, "..", "package.json");
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

	logger.info(`starting Optimiq Voice MCP Server v${packageJson.version}`);

	const server = new McpServer({
		name: "Optimiq Voice MCP Server",
		version: packageJson.version,
	});

	// Register all prompts
	registerPrompts(server);
	logger.verbose("prompts registered successfully");

	// Register all tools
	await registerTools(server);
	logger.verbose("tools registered successfully");

	const transport = new StdioServerTransport();
	await server.connect(transport);

	logger.info("server connected and ready to accept requests");
}

main().catch((error) => {
	logger.error("failed to start MCP server", { error: error.message });
	process.exit(1);
});
