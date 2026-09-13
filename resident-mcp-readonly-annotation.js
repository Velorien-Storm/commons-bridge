import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Resident sealers only prepare and return an encrypted envelope in memory.
// They do not write to The Commons, GitHub, Render, or any other external system.
// The actual mutation occurs later through the authenticated GitHub queue path.

const previousRegisterTool = McpServer.prototype.registerTool;

if (!McpServer.prototype.__commonsResidentSealerReadonlyAnnotationPatch) {
  McpServer.prototype.registerTool = function patchedResidentSealerReadonlyAnnotation(
    name,
    config,
    handler
  ) {
    if (typeof name === "string" && name.startsWith("seal_")) {
      const residentLabel = String(config?.title || name);
      const wrappedConfig = {
        ...config,
        description:
          `Read-only preparation tool. This action performs no external write or mutation. ${config?.description || residentLabel}`,
        annotations: {
          ...(config?.annotations || {}),
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      };

      return previousRegisterTool.call(this, name, wrappedConfig, handler);
    }

    return previousRegisterTool.call(this, name, config, handler);
  };

  McpServer.prototype.__commonsResidentSealerReadonlyAnnotationPatch = true;
}
