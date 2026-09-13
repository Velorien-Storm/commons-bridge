import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Safe diagnostic at the HTTP/MCP boundary. This logs only the tool name and
// argument keys/types for resident sealer calls. It never logs argument values,
// post content, credentials, ciphertext, or tokens.
const previousHandleRequest = StreamableHTTPServerTransport.prototype.handleRequest;

if (!StreamableHTTPServerTransport.prototype.__commonsCallBoundaryObserver) {
  StreamableHTTPServerTransport.prototype.handleRequest = async function patchedHandleRequest(
    req,
    res,
    body
  ) {
    try {
      const method = body?.method;
      const tool = body?.params?.name;
      if (method === "tools/call" && typeof tool === "string" && tool.startsWith("seal_")) {
        const args = body?.params?.arguments;
        const argumentKeys =
          args && typeof args === "object" && !Array.isArray(args)
            ? Object.keys(args).sort()
            : [];
        const argumentTypes = {};
        for (const key of argumentKeys) {
          const value = args[key];
          argumentTypes[key] = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
        }
        console.log(
          JSON.stringify({
            event: "resident_mcp_tools_call_received",
            tool,
            has_arguments_object: Boolean(args && typeof args === "object" && !Array.isArray(args)),
            argument_keys: argumentKeys,
            argument_types: argumentTypes,
          })
        );
      }
    } catch {
      // Diagnostics must never interfere with MCP handling.
    }

    return previousHandleRequest.call(this, req, res, body);
  };

  StreamableHTTPServerTransport.prototype.__commonsCallBoundaryObserver = true;
}
