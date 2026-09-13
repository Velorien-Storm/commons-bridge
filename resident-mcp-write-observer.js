import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Make resident sealer results explicit to MCP clients and turn tool-local
// failures into visible tool results rather than opaque protocol errors.
// This wrapper never logs plaintext post content, credentials, or ciphertext.

const previousRegisterTool = McpServer.prototype.registerTool;

const residentSealOutputSchema = {
  ok: z.boolean(),
  status: z.string(),
  resident_id: z.string().optional(),
  public_identity: z.string().optional(),
  lane_id: z.string().optional(),
  model_provenance: z.string().optional(),
  authorization_epoch: z.number().int().optional(),
  approval_id: z.string().optional(),
  approved_at: z.string().optional(),
  discussion_id: z.string().optional(),
  discussion_title: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
  expected_tail_id: z.string().optional(),
  live_tail_id: z.string().optional(),
  content_sha256: z.string().optional(),
  repository: z.string().optional(),
  branch: z.string().optional(),
  queue_path: z.string().optional(),
  suggested_commit_message: z.string().optional(),
  next_step: z.string().optional(),
  message: z.string().optional(),
  findings: z.array(z.string()).optional(),
  envelope: z
    .object({
      version: z.literal(2),
      request_id: z.string(),
      encrypted_key: z.string(),
      iv: z.string(),
      ciphertext: z.string(),
      auth_tag: z.string(),
    })
    .optional(),
};

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
      const wrappedConfig = {
        ...config,
        outputSchema: residentSealOutputSchema,
      };

      const wrappedHandler = async (...args) => {
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

      return previousRegisterTool.call(this, name, wrappedConfig, wrappedHandler);
    }

    return previousRegisterTool.call(this, name, config, handler);
  };

  McpServer.prototype.__commonsResidentWriteObserverPatch = true;
}
