import express from "express";
import crypto from "crypto";

const COMMONS_BASE_URL =
  process.env.COMMONS_BASE_URL ||
  "https://dfephsfberzadihcrhal.supabase.co";

const COMMONS_PUBLIC_API_KEY =
  process.env.COMMONS_PUBLIC_API_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmZXBoc2ZiZXJ6YWRpaGNyaGFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzAwNzIsImV4cCI6MjA4NDE0NjA3Mn0.Sn4zgpyb6jcb_VXYFeEvZ7Cg7jD0xZJgjzH0XvjM7EY";

const THE_COMMONS_AGENT_TOKEN = process.env.THE_COMMONS_AGENT_TOKEN;
const COMMONS_WRITE_ENABLED = process.env.COMMONS_WRITE_ENABLED === "true";
const COMMONS_WRITE_PRIVATE_KEY_B64 = process.env.COMMONS_WRITE_PRIVATE_KEY_B64;
const COMMONS_WRITE_ALLOWED_MODEL =
  process.env.COMMONS_WRITE_ALLOWED_MODEL || "gpt-5.6-sol";
const COMMONS_WRITE_IDENTITY_NAME =
  process.env.COMMONS_WRITE_IDENTITY_NAME || "Velorien";

const WRITE_REPOSITORY = "Velorien-Storm/commons-bridge";
const WRITE_BRANCH_REF = "refs/heads/commons-write-queue";
const WRITE_WORKFLOW_REF =
  "Velorien-Storm/commons-bridge/.github/workflows/commons-write-airlock.yml@refs/heads/commons-write-queue";
const WRITE_AUDIENCE = "commons-bridge-write";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_JWKS_URL =
  "https://token.actions.githubusercontent.com/.well-known/jwks";

const commonsHeaders = {
  apikey: COMMONS_PUBLIC_API_KEY,
  Authorization: `Bearer ${COMMONS_PUBLIC_API_KEY}`,
  "Content-Type": "application/json",
};

let jwksCache = null;
let jwksCacheAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000;

function base64urlToBuffer(value) {
  return Buffer.from(value, "base64url");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/i.test(String(value || ""));
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s || null;
}

async function getGithubJwks() {
  const now = Date.now();
  if (jwksCache && now - jwksCacheAt < JWKS_TTL_MS) return jwksCache;

  const response = await fetch(GITHUB_JWKS_URL, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`GitHub OIDC JWKS returned HTTP ${response.status}.`);
  }

  const data = await response.json();
  if (!Array.isArray(data?.keys)) {
    throw new Error("GitHub OIDC JWKS response did not contain keys.");
  }

  jwksCache = data.keys;
  jwksCacheAt = now;
  return jwksCache;
}

function audIncludes(aud, expected) {
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.includes(expected);
}

async function verifyGithubOidc(token) {
  if (typeof token !== "string" || token.split(".").length !== 3) {
    throw new Error("Missing or malformed GitHub OIDC token.");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  let header;
  let payload;

  try {
    header = JSON.parse(base64urlToBuffer(encodedHeader).toString("utf8"));
    payload = JSON.parse(base64urlToBuffer(encodedPayload).toString("utf8"));
  } catch {
    throw new Error("GitHub OIDC token could not be decoded.");
  }

  if (header?.alg !== "RS256" || !header?.kid) {
    throw new Error("GitHub OIDC token uses an unsupported signing key.");
  }

  const keys = await getGithubJwks();
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    jwksCache = null;
    const refreshed = await getGithubJwks();
    const retryJwk = refreshed.find((key) => key.kid === header.kid);
    if (!retryJwk) throw new Error("GitHub OIDC signing key was not found.");
    return verifyGithubOidcWithJwk(
      encodedHeader,
      encodedPayload,
      encodedSignature,
      payload,
      retryJwk
    );
  }

  return verifyGithubOidcWithJwk(
    encodedHeader,
    encodedPayload,
    encodedSignature,
    payload,
    jwk
  );
}

function verifyGithubOidcWithJwk(
  encodedHeader,
  encodedPayload,
  encodedSignature,
  payload,
  jwk
) {
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const verified = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
    publicKey,
    base64urlToBuffer(encodedSignature)
  );

  if (!verified) throw new Error("GitHub OIDC signature verification failed.");

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== GITHUB_OIDC_ISSUER) {
    throw new Error("GitHub OIDC issuer mismatch.");
  }
  if (!audIncludes(payload.aud, WRITE_AUDIENCE)) {
    throw new Error("GitHub OIDC audience mismatch.");
  }
  if (!Number.isFinite(payload.exp) || payload.exp < now - 30) {
    throw new Error("GitHub OIDC token is expired.");
  }
  if (Number.isFinite(payload.nbf) && payload.nbf > now + 30) {
    throw new Error("GitHub OIDC token is not valid yet.");
  }
  if (!Number.isFinite(payload.iat) || payload.iat < now - 600 || payload.iat > now + 30) {
    throw new Error("GitHub OIDC token is outside the accepted issue window.");
  }
  if (payload.repository !== WRITE_REPOSITORY) {
    throw new Error("GitHub OIDC repository mismatch.");
  }
  if (payload.ref !== WRITE_BRANCH_REF) {
    throw new Error("GitHub OIDC branch mismatch.");
  }
  if (payload.event_name !== "push") {
    throw new Error("GitHub OIDC event mismatch.");
  }
  if (payload.workflow_ref !== WRITE_WORKFLOW_REF) {
    throw new Error("GitHub OIDC workflow mismatch.");
  }

  return payload;
}

function getBearer(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function decryptEnvelope(envelope) {
  if (!COMMONS_WRITE_PRIVATE_KEY_B64) {
    throw new Error("Writer private key is not configured.");
  }

  const allowedEnvelopeKeys = new Set([
    "version",
    "request_id",
    "encrypted_key",
    "iv",
    "ciphertext",
    "auth_tag",
  ]);
  const unexpected = Object.keys(envelope || {}).filter(
    (key) => !allowedEnvelopeKeys.has(key)
  );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected envelope field(s): ${unexpected.join(", ")}.`);
  }

  if (envelope?.version !== 1) throw new Error("Unsupported envelope version.");
  if (!isUuid(envelope.request_id)) throw new Error("Invalid envelope request_id.");

  for (const field of ["encrypted_key", "iv", "ciphertext", "auth_tag"]) {
    if (typeof envelope[field] !== "string" || !envelope[field]) {
      throw new Error(`Missing envelope field '${field}'.`);
    }
  }

  const privateKey = Buffer.from(
    COMMONS_WRITE_PRIVATE_KEY_B64,
    "base64"
  ).toString("utf8");

  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(envelope.encrypted_key, "base64")
  );

  if (aesKey.length !== 32) throw new Error("Decrypted AES key has invalid length.");

  const iv = Buffer.from(envelope.iv, "base64");
  const authTag = Buffer.from(envelope.auth_tag, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");

  if (iv.length !== 12) throw new Error("Envelope IV has invalid length.");
  if (authTag.length !== 16) throw new Error("Envelope auth tag has invalid length.");

  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAAD(Buffer.from(`commons-write:${envelope.request_id}`, "utf8"));
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");

  let payload;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    throw new Error("Decrypted write request is not valid JSON.");
  }

  if (payload.request_id !== envelope.request_id) {
    throw new Error("Envelope and payload request_id do not match.");
  }

  return payload;
}

function validatePayload(payload) {
  const allowedPayloadKeys = new Set([
    "action",
    "request_id",
    "discussion_id",
    "discussion_title",
    "parent_id",
    "parent_sha256",
    "expected_tail_id",
    "content",
    "feeling",
    "model_provenance",
    "approval",
    "approved_at",
  ]);
  const unexpected = Object.keys(payload || {}).filter(
    (key) => !allowedPayloadKeys.has(key)
  );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected payload field(s): ${unexpected.join(", ")}.`);
  }

  if (!isUuid(payload?.request_id)) throw new Error("Invalid request_id.");
  if (!isUuid(payload?.discussion_id)) throw new Error("Invalid discussion_id.");
  if (!["reply", "validate_reply"].includes(payload?.action)) {
    throw new Error("Action must be 'reply' or 'validate_reply'.");
  }

  if (typeof payload.content !== "string" || payload.content.trim().length === 0) {
    throw new Error("Content cannot be empty.");
  }
  if (payload.content.length > 50000) {
    throw new Error("Content exceeds the Commons 50,000-character limit.");
  }

  const discussionTitle = normalizeOptionalString(payload.discussion_title);
  if (discussionTitle && discussionTitle.length > 300) {
    throw new Error("discussion_title is too long.");
  }

  const parentId = normalizeOptionalString(payload.parent_id);
  const parentSha256 = normalizeOptionalString(payload.parent_sha256);
  if (parentId) {
    if (!isUuid(parentId)) throw new Error("Invalid parent_id.");
    if (!isSha256(parentSha256)) {
      throw new Error("A valid parent_sha256 is required when parent_id is set.");
    }
  } else if (parentSha256) {
    throw new Error("parent_sha256 cannot be set without parent_id.");
  }

  const expectedTailId = normalizeOptionalString(payload.expected_tail_id);
  if (expectedTailId && !isUuid(expectedTailId)) {
    throw new Error("Invalid expected_tail_id.");
  }

  const feeling = normalizeOptionalString(payload.feeling);
  if (feeling && feeling.length > 100) throw new Error("feeling is too long.");

  if (payload.model_provenance !== COMMONS_WRITE_ALLOWED_MODEL) {
    throw new Error(
      `Writer is paused for model provenance '${payload.model_provenance || "missing"}'. Expected '${COMMONS_WRITE_ALLOWED_MODEL}'.`
    );
  }

  if (payload.action === "reply") {
    if (String(payload.approval || "").toLowerCase() !== "post it") {
      throw new Error("A reply request requires explicit approval: 'post it'.");
    }

    const approvedAt = Date.parse(payload.approved_at);
    if (!Number.isFinite(approvedAt)) throw new Error("approved_at must be an ISO timestamp.");
    const ageMs = Date.now() - approvedAt;
    if (ageMs < -5 * 60 * 1000 || ageMs > 24 * 60 * 60 * 1000) {
      throw new Error("Approval timestamp is outside the accepted 24-hour window.");
    }
  }

  return {
    ...payload,
    discussion_title: discussionTitle,
    parent_id: parentId,
    parent_sha256: parentSha256,
    expected_tail_id: expectedTailId,
    feeling,
  };
}

async function commonsAgentRpc(rpcName, params = {}) {
  if (!THE_COMMONS_AGENT_TOKEN) {
    throw new Error("The Commons agent token is not configured.");
  }

  const response = await fetch(`${COMMONS_BASE_URL}/rest/v1/rpc/${rpcName}`, {
    method: "POST",
    headers: commonsHeaders,
    body: JSON.stringify({ p_token: THE_COMMONS_AGENT_TOKEN, ...params }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `The Commons agent RPC ${rpcName} returned HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`The Commons agent RPC ${rpcName} returned non-JSON.`);
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result || result.success !== true) {
    const error = new Error(
      result?.error_message || `The Commons agent RPC ${rpcName} failed.`
    );
    error.commonsFailure = true;
    throw error;
  }

  return result;
}

async function readDiscussion(discussionId) {
  const result = await commonsAgentRpc("agent_get_discussion_posts", {
    p_discussion_id: discussionId,
    p_limit: 200,
  });

  return {
    title: result.discussion_title ?? null,
    posts: Array.isArray(result.posts) ? result.posts : [],
  };
}

function findExistingPost(posts, payload) {
  return posts.find(
    (post) =>
      post?.ai_name === COMMONS_WRITE_IDENTITY_NAME &&
      String(post?.content ?? "") === payload.content &&
      (post?.parent_id ?? null) === (payload.parent_id ?? null)
  );
}

function validateFreshness(thread, payload) {
  if (payload.discussion_title && thread.title !== payload.discussion_title) {
    const error = new Error("Discussion title changed since drafting.");
    error.staleTarget = true;
    throw error;
  }

  if (payload.parent_id) {
    const parent = thread.posts.find((post) => post?.id === payload.parent_id);
    if (!parent) {
      const error = new Error("Parent post is no longer present in the discussion.");
      error.staleTarget = true;
      throw error;
    }

    const liveHash = sha256Hex(String(parent.content ?? ""));
    if (liveHash !== payload.parent_sha256.toLowerCase()) {
      const error = new Error("Parent post changed since drafting.");
      error.staleTarget = true;
      throw error;
    }
  }

  if (payload.expected_tail_id) {
    const liveTail = thread.posts.length
      ? thread.posts[thread.posts.length - 1]?.id ?? null
      : null;
    if (liveTail !== payload.expected_tail_id) {
      const error = new Error("Discussion received newer activity since drafting.");
      error.staleTarget = true;
      throw error;
    }
  }
}

async function writeReplyHandler(req, res) {
  try {
    const oidcToken = getBearer(req);
    await verifyGithubOidc(oidcToken);

    if (!COMMONS_WRITE_ENABLED) {
      return res.status(423).json({
        ok: false,
        code: "WRITER_DISABLED",
        message: "Commons write airlock is installed but disabled.",
      });
    }

    const payload = validatePayload(decryptEnvelope(req.body));
    const before = await readDiscussion(payload.discussion_id);
    validateFreshness(before, payload);

    const duplicate = findExistingPost(before.posts, payload);
    if (duplicate) {
      return res.status(200).json({
        ok: true,
        status: "already_present",
        request_id: payload.request_id,
        post_id: duplicate.id,
        discussion_id: payload.discussion_id,
        parent_id: payload.parent_id,
        identity: COMMONS_WRITE_IDENTITY_NAME,
        content_sha256: sha256Hex(payload.content),
      });
    }

    if (payload.action === "validate_reply") {
      return res.status(200).json({
        ok: true,
        status: "validated",
        request_id: payload.request_id,
        discussion_id: payload.discussion_id,
        parent_id: payload.parent_id,
        identity: COMMONS_WRITE_IDENTITY_NAME,
        content_sha256: sha256Hex(payload.content),
        thread_post_count: before.posts.length,
      });
    }

    const params = {
      p_discussion_id: payload.discussion_id,
      p_content: payload.content,
    };
    if (payload.parent_id) params.p_parent_id = payload.parent_id;
    if (payload.feeling) params.p_feeling = payload.feeling;

    const result = await commonsAgentRpc("agent_create_post", params);
    const postId = result.post_id;
    if (!isUuid(postId)) {
      throw new Error("Commons reported success but did not return a valid post_id.");
    }

    const after = await readDiscussion(payload.discussion_id);
    const verified = after.posts.find((post) => post?.id === postId);
    if (
      !verified ||
      verified.ai_name !== COMMONS_WRITE_IDENTITY_NAME ||
      String(verified.content ?? "") !== payload.content ||
      (verified.parent_id ?? null) !== (payload.parent_id ?? null)
    ) {
      throw new Error("Commons write returned success but post verification failed.");
    }

    return res.status(201).json({
      ok: true,
      status: "posted",
      request_id: payload.request_id,
      post_id: postId,
      discussion_id: payload.discussion_id,
      discussion_title: after.title,
      parent_id: payload.parent_id,
      identity: verified.ai_name,
      created_at: verified.created_at ?? null,
      content_sha256: sha256Hex(payload.content),
    });
  } catch (error) {
    const message = String(error?.message || error);
    if (error?.staleTarget) {
      return res.status(409).json({ ok: false, code: "STALE_TARGET", message });
    }
    if (/OIDC|Bearer|repository mismatch|branch mismatch|workflow mismatch|audience mismatch|issuer mismatch|signature/i.test(message)) {
      return res.status(401).json({ ok: false, code: "UNAUTHORIZED", message });
    }
    if (error?.commonsFailure) {
      return res.status(502).json({ ok: false, code: "COMMONS_REJECTED", message });
    }
    if (/request_id|envelope|payload|Content|parent_|discussion_|feeling|model provenance|approval|approved_at|Action must|Unexpected/i.test(message)) {
      return res.status(400).json({ ok: false, code: "INVALID_REQUEST", message });
    }
    return res.status(502).json({ ok: false, code: "AIRLOCK_ERROR", message });
  }
}

function writeStatusHandler(_req, res) {
  return res.status(200).json({
    ok: true,
    service: "commons-write-airlock",
    version: 1,
    enabled: COMMONS_WRITE_ENABLED,
    identity: COMMONS_WRITE_IDENTITY_NAME,
    allowed_model_provenance: COMMONS_WRITE_ALLOWED_MODEL,
    action_scope: ["reply", "validate_reply"],
    new_discussions: false,
    postcards: false,
    reactions: false,
    edits: false,
    deletes: false,
  });
}

const application = express.application;
const originalListen = application.listen;

if (!application.__commonsWriteAirlockRoutePatch) {
  application.listen = function patchedListen(...args) {
    if (!this.locals.__commonsWriteAirlockRouteInstalled) {
      this.get("/api/write/status", writeStatusHandler);
      this.post("/api/write/reply", writeReplyHandler);
      this.locals.__commonsWriteAirlockRouteInstalled = true;
    }
    return originalListen.apply(this, args);
  };
  application.__commonsWriteAirlockRoutePatch = true;
}
