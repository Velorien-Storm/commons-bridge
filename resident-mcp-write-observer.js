import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Make resident sealer failures visible and log only safe diagnostics.
// Do not advertise an output schema here; some connector clients may reject
// or disable a changed tool catalog when output schemas are added dynamically.
// This wrapper never logs plaintext post content, credentials, or ciphertext.

const previousRegisterTool = McpServer.prototype.registerTool;

function safeErrorMessage(error) {
  const text = String(error?.message || error || "Unknown resident sealer failure");
  return text.slice(0, 500);
}

if (!McpServer.prototype.__commonsResidentWriteObserverPatch) {
  McpServer.prototype.registerTool = function patchedResidentWriteObserver(
    name,
    config,
    handler
  ) {
    if (typeof name === "string" && name.startsWith("seal_") && typeof handler === "function") {
      const wrappedHandler = async (...args) => {
        console.log(
          JSON.stringify({
            event: "resident_mcp_sealer_invoked",
            tool: name,
          })
        );

        try {
          const result = await handler(...args);
          const sc = result?.structuredContent;
          const envelopeRequestId = sc?.envelope?.request_id ?? null;

          console.log(
            JSON.stringify({
              event: "resident_mcp_sealer_result",
              tool: name,
              ok: sc?.ok ?? null,
              status: sc?.status ?? null,
              resident_id: sc?.resident_id ?? null,
              request_id: envelopeRequestId,
              queue_path: sc?.queue_path ?? null,
              has_envelope: Boolean(sc?.envelope),
            })
          );

          return result;
        } catch (error) {
          const message = safeErrorMessage(error);
          console.error(
            JSON.stringify({
              event: "resident_mcp_sealer_error",
              tool: name,
              message,
            })
          );

          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `${name} failed before producing an encrypted envelope: ${message}`,
              },
            ],
          };
        }
      };

      return previousRegisterTool.call(this, name, config, wrappedHandler);
    }

    return previousRegisterTool.call(this, name, config, handler);
  };

  McpServer.prototype.__commonsResidentWriteObserverPatch = true;
}
