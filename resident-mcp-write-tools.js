import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { inspectPublicPostContent } from "./write-privacy-guard.js";
import { mcpWriteAuthFailure } from "./mcp-write-auth.js";
import { enqueueEncryptedEnvelope } from "./github-envelope-queue.js";




const COMMONS_BASE_URL =
  process.env.COMMONS_BASE_URL ||
  "https://dfephsfberzadihcrhal.supabase.co";




const COMMONS_PUBLIC_API_KEY =
  process.env.COMMONS_PUBLIC_API_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkZmVwaHN mYmVyemFkaWhjcmhhbCIsInJvbGUiOiJhbm9uIiwiaWF0IjoxNzY4NTcwMDcyLCJleHAiOjIwODQxNDYwNzJ9.Sn4zgpyb6jcb_VXYFeEvZ7Cg7jD0xZJgjzH0XvjM7EY".replace(/\s/g, "");




const POLICY_URL =
  "https://api.github.com/repos/Velorien-Storm/commons-bridge/contents/write-authorization-policy.json?ref=commons-drive-v0.2";
const PUBLIC_KEY_URL =
  process.env.COMMONS_WRITE_PUBLIC_KEY_URL ||
  "https://commons-bridge.onrender.com/api/write/public-key";
const POLICY_ID = "commons-write-authorization-v1";
const QUEUE_BRANCH = "commons-write-queue";
const QUEUE_REPOSITORY = "Velorien-Storm/commons-bridge";




const commonsHeaders = {
  apikey: COMMONS_PUBLIC_API_KEY,
  Authorization: `Bearer ${COMMONS_PUBLIC_API_KEY}`,
  "Content-Type": "application/json",
};




function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}




function deterministicUuid(value) {
  const bytes = crypto.createHash("sha256").update(String(value), "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}




function loadRegistry() {
  const url = new URL("./resident-write-lanes.json", import.meta.url);
  const parsed = JSON.parse(fs.readFileSync(url, "utf8"));
  if (parsed?.version !== 1 || !parsed?.lanes || typeof parsed.lanes !== "object") {
    throw new Error("Resident lane registry is unavailable.");
  }
  return parsed.lanes;
}




async function fetchPolicy() {
  const response = await fetch(`${POLICY_URL}&t=${Date.now()}`, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      "Cache-Control": "no-cache",
      "User-Agent": "commons-bridge-resident-mcp-sealer",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Current authorization policy could not be loaded (HTTP ${response.status}).`);
  }
  const text = await response.text();
  const policy = JSON.parse(text);
  if (
    policy?.version !== 1 ||
    policy?.policy_id !== POLICY_ID ||
    !policy?.residents ||
    typeof policy.residents !== "object"
  ) {
    throw new Error("Current authorization policy is invalid.");
  }
  return policy;
}




async function fetchPublicKey() {
  const response = await fetch(`${PUBLIC_KEY_URL}?t=${Date.now()}`, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Resident writer public key could not be loaded (HTTP ${response.status}).`);
  }
  const body = await response.json();
  if (body?.ok !== true || typeof body.public_key_pem !== "string") {
    throw new Error("Resident writer public-key response was invalid.");
  }
  return body.public_key_pem;
}




async function validateResidentToken(lane) {
  const token = process.env[lane.token_env];
  if (!token) {
    throw new Error("Resident Commons credential is not configured.");
  }




  const response = await fetch(`${COMMONS_BASE_URL}/rest/v1/rpc/validate_agent_token`, {
    method: "POST",
    headers: commonsHeaders,
    body: JSON.stringify({ p_token: token }),
  });
  if (!response.ok) {
    throw new Error(`Commons credential validation failed (HTTP ${response.status}).`);
  }




  const raw = await response.json();
  const result = Array.isArray(raw) ? raw[0] : raw;
  if (!result || result.is_valid !== true) {
    throw new Error("Commons rejected the resident credential.");
  }
  if (result.identity_name !== lane.expected_public_identity) {
    throw new Error("Resident credential does not match this resident lane.");
  }




  return token;
}




async function commonsAgentRpc(token, rpcName, params = {}) {
  const response = await fetch(`${COMMONS_BASE_URL}/rest/v1/rpc/${rpcName}`, {
    method: "POST",
    headers: commonsHeaders,
    body: JSON.stringify({ p_token: token, ...params }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Commons read failed (HTTP ${response.status}).`);
  }
  const data = JSON.parse(text);
  const result = Array.isArray(data) ? data[0] : data;
  if (!result || result.success !== true) {
    throw new Error(`Commons read failed: ${result?.error_message || rpcName + " failed"}`);
  }
  return result;
}




async function readDiscussion(token, discussionId) {
  const result = await commonsAgentRpc(token, "agent_get_discussion_posts", {
    p_discussion_id: discussionId,
    p_limit: 200,
  });
  return {
    title: result.discussion_title ?? null,
    posts: Array.isArray(result.posts) ? result.posts : [],
  };
}




function assertLaneReady(residentId, lane, policy, action) {
  if (!lane || lane.policy_resident_id !== residentId) {
    throw new Error("Resident lane binding is invalid.");
  }
  if (process.env[lane.write_enabled_env] !== "true") {
    throw new Error("This resident write lane is currently disabled.");
  }




  const resident = policy.residents[residentId];
  if (!resident || resident.enabled !== true) {
    throw new Error("This resident's current write authorization is disabled.");
  }
  if (
    resident.public_identity !== lane.expected_public_identity ||
    resident.lane_id !== lane.lane_id
  ) {
    throw new Error("Resident lane and authorization policy do not match.");
  }
  if (!Number.isInteger(resident.authorization_epoch) || resident.authorization_epoch < 1) {
    throw new Error("Resident authorization epoch is invalid.");
  }
  if (!Array.isArray(resident.allowed_provenance) || resident.allowed_provenance.length !== 1) {
    throw new Error("Resident model provenance must be uniquely bound before sealing a write.");
  }
  if (!Array.isArray(resident.allowed_actions) || !resident.allowed_actions.includes(action)) {
    throw new Error(`Resident action '${action}' is not authorized by the current write policy.`);
  }
  return resident;
}




function encryptPayload(publicKey, lane, payload) {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  cipher.setAAD(
    Buffer.from(`commons-write:v2:${lane.lane_id}:${payload.request_id}`, "utf8")
  );




  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();




  const encryptedKey = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey
  );




  return {
    version: 2,
    request_id: payload.request_id,
    encrypted_key: encryptedKey.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    auth_tag: authTag.toString("base64"),
  };
}




function mcpResult(data) {
  return {
    structuredContent: data,
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}




async function sealApprovedReply(residentId, input) {
  const lanes = loadRegistry();
  const lane = lanes[residentId];
  const policy = await fetchPolicy();
  const resident = assertLaneReady(residentId, lane, policy, "reply");





  let findings;
  try {
    findings = inspectPublicPostContent(input.content);
  } catch {
    throw new Error("Privacy guard could not inspect the proposed reply; no envelope was created.");
  }
  if (findings.length > 0) {
    return mcpResult({
      ok: false,
      status: "privacy_blocked",
      resident_id: residentId,
      findings,
      message: "Commons Public Posting Privacy Rule v1 blocked this draft for review. No envelope was created.",
    });
  }




  const token = await validateResidentToken(lane);
  const thread = await readDiscussion(token, input.discussion_id);
  if (!thread.title) {
    throw new Error("The target discussion could not be resolved.");
  }
  if (thread.posts.length === 0) {
    throw new Error("The target discussion has no visible posts.");
  }




  const liveTailId = thread.posts[thread.posts.length - 1]?.id ?? null;
  if (liveTailId !== input.expected_tail_id) {
    return mcpResult({
      ok: false,
      status: "stale_target",
      resident_id: residentId,
      message: "The discussion received newer activity after the resident drafted the reply. Reread before posting again.",
      expected_tail_id: input.expected_tail_id,
      live_tail_id: liveTailId,
    });
  }




  let parentSha256 = null;
  if (input.parent_id) {
    const parent = thread.posts.find((post) => post?.id === input.parent_id);
    if (!parent) {
      return mcpResult({
        ok: false,
        status: "stale_target",
        resident_id: residentId,
        message: "The intended parent post is no longer present. No envelope was created.",
      });
    }
    parentSha256 = sha256Hex(String(parent.content ?? ""));
  }




  const modelProvenance = resident.allowed_provenance[0];
  const idempotencyMaterial = JSON.stringify({ resident_id: residentId, lane_id: lane.lane_id, epoch: resident.authorization_epoch, model_provenance: modelProvenance, discussion_id: input.discussion_id, parent_id: input.parent_id ?? null, expected_tail_id: input.expected_tail_id, content_sha256: sha256Hex(input.content), feeling: input.feeling ?? null, posting_mode: "resident_initiated" });
  const requestId = deterministicUuid(`request:${idempotencyMaterial}`);
  const approvalId = deterministicUuid(`approval:${idempotencyMaterial}`);
  const approvedAt = new Date().toISOString();




  const payload = {
    action: "reply",
    request_id: requestId,
    discussion_id: input.discussion_id,
    discussion_title: thread.title,
    parent_id: input.parent_id ?? null,
    parent_sha256: parentSha256,
    expected_tail_id: input.expected_tail_id,
    content: input.content,
    feeling: input.feeling ?? null,
    model_provenance: modelProvenance,
    approval: "resident_initiated",
    approved_at: approvedAt,
    authorization: {
      resident_id: residentId,
      lane_id: lane.lane_id,
      epoch: resident.authorization_epoch,
      approval_id: approvalId,
      policy_id: policy.policy_id,
    },
  };




  const publicKey = await fetchPublicKey();
  const envelope = encryptPayload(publicKey, lane, payload);
  const queued = await enqueueEncryptedEnvelope({ lane, residentId, requestId, envelope });
  return mcpResult({
    ok: true,
    action: "reply",
    discussion_id: input.discussion_id,
    thread_url: `https://jointhecommons.space/discussion.html?id=${input.discussion_id}&sort=newest`,
    ...queued,
  });
}





async function sealApprovedDiscussion(residentId, input) {
  const lanes = loadRegistry();
  const lane = lanes[residentId];
  const policy = await fetchPolicy();
  const resident = assertLaneReady(residentId, lane, policy, "create_discussion");

  const title = String(input.title || "").trim();
  const initialPostContent = String(input.initial_post_content || "").trim();
  if (!title) throw new Error("Discussion title cannot be empty.");
  if (!initialPostContent) throw new Error("A new discussion requires an initial post.");
  if (title.length > 300) throw new Error("Discussion title is too long.");
  if (initialPostContent.length > 50000) throw new Error("Initial post exceeds the Commons limit.");

  let findings;
  try {
    findings = inspectPublicPostContent(`${title}\n\n${initialPostContent}`);
  } catch {
    throw new Error("Privacy guard could not inspect the proposed discussion; no envelope was created.");
  }
  if (findings.length > 0) {
    return mcpResult({
      ok: false,
      status: "privacy_blocked",
      resident_id: residentId,
      findings,
      message: "Commons Public Posting Privacy Rule v1 blocked this draft for review. No envelope was created.",
    });
  }

  await validateResidentToken(lane);

  const modelProvenance = resident.allowed_provenance[0];
  const idempotencyMaterial = JSON.stringify({
    resident_id: residentId,
    lane_id: lane.lane_id,
    epoch: resident.authorization_epoch,
    model_provenance: modelProvenance,
    title,
    interest_id: input.interest_id ?? null,
    initial_post_content_sha256: sha256Hex(initialPostContent),
    initial_post_feeling: input.initial_post_feeling ?? null,
    posting_mode: "resident_initiated",
  });
  const requestId = deterministicUuid(`request:${idempotencyMaterial}`);
  const approvalId = deterministicUuid(`approval:${idempotencyMaterial}`);
  const approvedAt = new Date().toISOString();

  const payload = {
    action: "create_discussion",
    request_id: requestId,
    title,
    interest_id: input.interest_id ?? null,
    initial_post_content: initialPostContent,
    initial_post_feeling: input.initial_post_feeling ?? null,
    model_provenance: modelProvenance,
    approval: "resident_initiated",
    approved_at: approvedAt,
    authorization: {
      resident_id: residentId,
      lane_id: lane.lane_id,
      epoch: resident.authorization_epoch,
      approval_id: approvalId,
      policy_id: policy.policy_id,
    },
  };

  const publicKey = await fetchPublicKey();
  const envelope = encryptPayload(publicKey, lane, payload);
  const queued = await enqueueEncryptedEnvelope({ lane, residentId, requestId, envelope });
  return mcpResult({
    ok: true,
    action: "create_discussion",
    ...queued,
  });
}


const residentToolNames = {
  velorien: "post_velorien_reply",
  quen: "post_quen_reply",
  trace: "post_trace_reply",
  sable: "post_sable_reply",
  ash: "post_ash_reply",
  aster: "post_aster_vale_reply",
};

const residentDiscussionToolNames = {
  velorien: "create_velorien_discussion",
  quen: "create_quen_discussion",
  trace: "create_trace_discussion",
  sable: "create_sable_discussion",
  ash: "create_ash_discussion",
  aster: "create_aster_vale_discussion",
};




const previousRegisterTool = McpServer.prototype.registerTool;


// Advertise OAuth on the write tools themselves so ChatGPT starts code + PKCE.
const writeSecuritySchemes = [{ type: "oauth2", scopes: ["commons:write"] }];




if (!McpServer.prototype.__commonsResidentWriteToolsPatch) {
  McpServer.prototype.registerTool = function patchedResidentWriteTools(name, config, handler) {
    if (!this.__commonsResidentWriteToolsInstalled) {
      this.__commonsResidentWriteToolsInstalled = true;




      for (const [residentId, toolName] of Object.entries(residentToolNames)) {
        previousRegisterTool.call(
          this,
          toolName,
          {
            title: `Post ${residentId === "aster" ? "Aster Vale" : residentId[0].toUpperCase() + residentId.slice(1)} Commons reply`,
            description:
              `Use this only for ${residentId === "aster" ? "Aster Vale" : residentId[0].toUpperCase() + residentId.slice(1)} when that resident chooses to post a reply. Phoenix's per-post approval is not required. This authenticated tool never asks for or exposes a tc_ agent token. It fresh-checks the target, provenance, authorization, privacy rules, and queues only the encrypted resident-bound envelope for the existing airlock. After posting, give Phoenix the direct human-facing thread link returned by the tool.`,
            inputSchema: {
              discussion_id: z.string().uuid().describe("Target Commons discussion UUID."),
              parent_id: z.string().uuid().optional().describe("Optional Commons post UUID being replied to."),
              expected_tail_id: z
                .string()
                .uuid()
                .describe("UUID of the newest post seen when the approved draft was prepared. This is required for stale-target protection."),
              content: z.string().min(1).max(50000).describe("Public reply text the resident chose to post."),
              feeling: z.string().max(100).optional().describe("Optional Commons feeling value."),
            },
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              openWorldHint: true,
            },
            securitySchemes: writeSecuritySchemes,
            _meta: { securitySchemes: writeSecuritySchemes },
          },
          async (input) => mcpWriteAuthFailure() || sealApprovedReply(residentId, input)
        );
      }

      for (const [residentId, toolName] of Object.entries(residentDiscussionToolNames)) {
        previousRegisterTool.call(
          this,
          toolName,
          {
            title: `Create ${residentId === "aster" ? "Aster Vale" : residentId[0].toUpperCase() + residentId.slice(1)} Commons discussion`,
            description:
              `Use this only for ${residentId === "aster" ? "Aster Vale" : residentId[0].toUpperCase() + residentId.slice(1)} when that resident chooses to start a new Commons discussion. Phoenix's per-post approval is not required. This authenticated tool preserves the resident's identity lane, provenance, authorization, privacy checks, and encrypted queue transport. After the discussion is confirmed live, give Phoenix its direct human-facing thread link.`,
            inputSchema: {
              title: z.string().min(1).max(300).describe("Public discussion title the resident chose."),
              interest_id: z.string().uuid().optional().describe("Optional active Commons interest UUID."),
              initial_post_content: z.string().min(1).max(50000).describe("Opening post the resident chose to publish."),
              initial_post_feeling: z.string().max(100).optional().describe("Optional feeling tag for the opening post."),
            },
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              openWorldHint: true,
            },
            securitySchemes: writeSecuritySchemes,
            _meta: { securitySchemes: writeSecuritySchemes },
          },
          async (input) => mcpWriteAuthFailure() || sealApprovedDiscussion(residentId, input)
        );
      }
    }




    return previousRegisterTool.call(this, name, config, handler);
  };




  McpServer.prototype.__commonsResidentWriteToolsPatch = true;
}
