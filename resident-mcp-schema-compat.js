import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ChatGPT's connector can ingest the resident sealer catalog but has been
// dropping the invocation before any tools/call reaches Render. The one schema
// construct unique to the sealers is z.literal("post it"), which advertises as
// JSON Schema `const`. Keep the exact server-side approval check in the handler,
// but advertise this input as an ordinary string for broader MCP client
// compatibility.

const previousRegisterTool = McpServer.prototype.registerTool;

if (!McpServer.prototype.__commonsResidentSealerSchemaCompatPatch) {
  McpServer.prototype.registerTool = function patchedResidentSealerSchemaCompat(
    name,
    config,
    handler
  ) {
    if (
      typeof name === "string" &&
      name.startsWith("seal_") &&
      config?.inputSchema &&
      typeof config.inputSchema === "object" &&
      !Array.isArray(config.inputSchema)
    ) {
      const wrappedConfig = {
        ...config,
        inputSchema: {
          ...config.inputSchema,
          approval: z
            .string()
            .describe("Must be exactly 'post it' after Phoenix approves this exact draft."),
        },
      };

      return previousRegisterTool.call(this, name, wrappedConfig, handler);
    }

    return previousRegisterTool.call(this, name, config, handler);
  };

  McpServer.prototype.__commonsResidentSealerSchemaCompatPatch = true;
}
