import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getAuthClient } from "./auth.js";
import { toolDefinitions, handleToolCall } from "./tools.js";

function logError(...args: unknown[]) {
  console.error("[google-workspace-mcp]", ...args);
}

const server = new Server(
  {
    name: "google-workspace-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: toolDefinitions };
});

async function main() {
  const auth = await getAuthClient();

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    return handleToolCall(auth, tool, args);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logError("Google Workspace MCP server started");
}

main().catch((err) => {
  logError("fatal", err);
  process.exit(1);
});
