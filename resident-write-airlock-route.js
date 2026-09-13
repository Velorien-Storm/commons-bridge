import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import { inspectPublicPostContent } from "./write-privacy-guard.js";

const COMMONS_BASE_URL =
  process.env.COMMONS_BASE_URL ||
  "https://dfephsfberzadihcrhal.supabase.co";

const COMMONS_PUBLIC_API_KEY =
  process.env.COMMONS_PUBLIC_API_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmZXBoc2ZiZXJ6YWRpaGNyaGFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzAwNzIsImV4cCI6MjA4NDE0NjA3Mn0.Sn4zgpyb6jcb_VXYFeEvZ7Cg7jD0xZJgjzH0XvjM7EY";

const PRIVATE_KEY_B64 = process.env.COMMONS_WRITE_PRIVATE_KEY_B64;
const POLICY_URL =
  "https://api.github.com/repos/Velorien-Storm/commons-bridge/contents/write-authorization-policy.json?ref=commons-drive-v0.2";
const EXPECTED_POLICY_ID = "commons-write-authorization-v1";
const PRIVACY_POLICY_VERSION = "commons-public-posting-privacy-v1";
const WRITER_VERSION = "commons-resident-write-airlock-v2";

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

function loadLaneRegistry() {
  const url = new URL("./resident-write-lanes.json", import.meta.url);
  const parsed = JSON.parse(fs.readFileSync(url, "utf8"));

  if (parsed?.version !== 1 || !parsed?.lanes || typeof parsed.lanes !== "object") {
    throw new Error("LANE_CONFIG_UNAVAILABLE: resident lane registry is invalid");
  }

  const bySlug = new Map();
  for (const [residentId, lane] of Object.entries(parsed.lanes)) {
    if (
      !lane ||
      typeof lane.route_slug !== "string" ||
      typeof lane.lane_id !== "string" ||
      typeof lane.token_env !== "string" ||
      typeof lane.write_enabled_env !== "string" ||
      lane.policy_resident_id !== residentId
    ) {
      throw new Error("LANE_CONFIG_UNAVAILABLE: resident lane record is invalid");
    }

    if (bySlug.has(lane.route_slug)) {
      throw new Error("LANE_CONFIG_UNAVAILABLE: duplicate resident route slug");
    }

    bySlug.set(lane.route_slug, {
      ...lane,
      resident_id: residentId,
    });
  }

  return bySlug;
}

const lanesBySlug = loadLaneRegistry();

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

function base64urlToBuffer(value) {
  return Buffer.from(value, "base64url");
}

function getBearer(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function laneAad(lane, requestId) {
  return `commons-write:v2:${lane.lane_id}:${requestId}`;
}

function targetBinding(payload) {
  return sha256Hex(
    JSON.stringify({
      discussion_id: payload.discussion_id ?? null,
      discussion_title: payload.discussion_title ?? null,
      parent_id: payload.parent_id ?? null,
      parent_sha256: payload.parent_sha256 ?? null,
      expected_tail_id: payload.expected_tail_id ?? null,
    })
  );
}

async function fetchPolicy() {
  const response = await fetch(`${POLICY_URL}&t=${Date.now()}`, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      "Cache-Control": "no-cache",
      "User-Agent": "commons-bridge-resident-authz",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`AUTHZ_POLICY_UNAVAILABLE: HTTP ${response.status}`);
  }

  const text = await response.text();
  let policy;
  try {
    policy = JSON.parse(text);
  } catch {
    throw new Error("AUTHZ_POLICY_UNAVAILABLE: policy JSON is invalid");
  }

  if (
    policy?.version !== 1 ||
    policy?.policy_id !== EXPECTED_POLICY_ID ||
    !policy?.residents ||
    typeof policy.residents !== "object"
  ) {
    throw new Error("AUTHZ_POLICY_UNAVAILABLE: policy structure is invalid");
  }

  return { policy, fingerprint: sha256Hex(text) };
}

async function getGithubJwks() {
  const now = Date.now();
  if (jwksCache && now - jwksCacheAt < JWKS_TTL_MS) return jwksCache;

  const response = await fetch(GITHUB_JWKS_URL, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`OIDC_INVALID: GitHub JWKS returned HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data?.keys)) {
    throw new Error("OIDC_INVALID: GitHub JWKS response did not contain keys");
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
    throw new Error("OIDC_INVALID: missing or malformed GitHub OIDC token");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  let header;
  let payload;

  try {
    header = JSON.parse(base64urlToBuffer(encodedHeader).toString("utf8"));
    payload = JSON.parse(base64urlToBuffer(encodedPayload).toString("utf8"));
  } catch {
    throw new Error("OIDC_INVALID: GitHub OIDC token could not be decoded");
  }

  if (header?.alg !== "RS256" || !header?.kid) {
    throw new Error("OIDC_INVALID: unsupported GitHub OIDC signing key");
  }

  let keys = await getGithubJwks();
  let jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    jwksCache = null;
    keys = await getGithubJwks();
    jwk = keys.find((key) => key.kid === header.kid);
  }
  if (!jwk) throw new Error("OIDC_INVALID: GitHub signing key was not found");

  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const verified = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
    publicKey,
    base64urlToBuffer(encodedSignature)
  );

  if (!verified) throw new Error("OIDC_INVALID: signature verification failed");

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== GITHUB_OIDC_ISSUER) {
    throw new Error("OIDC_INVALID: issuer mismatch");
  }
  if (!audIncludes(payload.aud, WRITE_AUDIENCE)) {
    throw new Error("OIDC_INVALID: audience mismatch");
  }
  if (!Number.isFinite(payload.exp) || payload.exp < now - 30) {
    throw new Error("OIDC_INVALID: token expired");
  }
  if (Number.isFinite(payload.nbf) && payload.nbf > now + 30) {
    throw new Error("OIDC_INVALID: token not valid yet");
  }
  if (!Number.isFinite(payload.iat) || payload.iat < now - 600 || payload.iat > now + 30) {
    throw new Error("OIDC_INVALID: token outside accepted issue window");
  }
  if (payload.repository !== WRITE_REPOSITORY) {
    throw new Error("OIDC_INVALID: repository mismatch");
  }
  if (payload.ref !== WRITE_BRANCH_REF) {
    throw new Error("OIDC_INVALID: branch mismatch");
  }
  if (payload.event_name !== "push") {
    throw new Error("OIDC_INVALID: event mismatch");
  }
  if (payload.workflow_ref !== WRITE_WORKFLOW_REF) {
    throw new Error("OIDC_INVALID: workflow mismatch");
  }

  return payload;
}

function decryptEnvelope(envelope, lane) {
  if (!PRIVATE_KEY_B64) {
    throw new Error("LANE_CONFIG_UNAVAILABLE: writer private key is not configured");
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
    throw new Error("ENVELOPE_INVALID: unexpected encrypted-envelope field");
  }

  if (envelope?.version !== 2 || !isUuid(envelope?.request_id)) {
    throw new Error("ENVELOPE_INVALID: resident lanes require envelope version 2");
  }

  for (const field of ["encrypted_key", "iv", "ciphertext", "auth_tag"]) {
    if (typeof envelope[field] !== "string" || !envelope[field]) {
      throw new Error("ENVELOPE_INVALID: encrypted envelope is incomplete");
    }
  }

  try {
    const privateKey = Buffer.from(PRIVATE_KEY_B64, "base64").toString("utf8");
    const aesKey = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(envelope.encrypted_key, "base64")
    );

    if (aesKey.length !== 32) {
      throw new Error("bad AES key length");
    }

    const iv = Buffer.from(envelope.iv, "base64");
    const authTag = Buffer.from(envelope.auth_tag, "base64");
    if (iv.length !== 12 || authTag.length !== 16) {
      throw new Error("bad GCM metadata");
    }

    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAAD(Buffer.from(laneAad(lane, envelope.request_id), "utf8"));
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");

    const payload = JSON.parse(plaintext);
    if (payload?.request_id !== envelope.request_id) {
      throw new Error("request id mismatch");
    }
    return payload;
  } catch {
    throw new Error(
      "ENVELOPE_INVALID: encrypted request could not authenticate for this resident lane"
    );
  }
}

function assertStrictAuthorizationObject(authorization) {
  const allowed = new Set([
    "resident_id",
    "lane_id",
    "epoch",
    "approval_id",
    "policy_id",
  ]);

  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) {
    throw new Error("AUTHZ_REQUIRED: authorization tuple is missing");
  }

  const unexpected = Object.keys(authorization).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error("AUTHZ_REQUIRED: authorization tuple contains unexpected fields");
  }
}

function assertResidentPolicy(lane, policyBundle, payload) {
  const authorization = payload?.authorization;
  assertStrictAuthorizationObject(authorization);

  const resident = policyBundle.policy.residents[lane.policy_resident_id];
  if (!resident) {
    throw new Error("AUTHZ_POLICY_UNAVAILABLE: resident policy is missing");
  }

  if (
    typeof lane.expected_public_identity !== "string" ||
    !lane.expected_public_identity.trim()
  ) {
    throw new Error("LANE_NOT_CONFIGURED: public identity is not configured");
  }

  if (resident.public_identity !== lane.expected_public_identity) {
    throw new Error("LANE_NOT_CONFIGURED: registry/policy public identity mismatch");
  }

  if (resident.lane_id !== lane.lane_id) {
    throw new Error("LANE_NOT_CONFIGURED: registry/policy lane mismatch");
  }

  if (authorization.resident_id !== lane.resident_id) {
    throw new Error("AUTHZ_CROSS_LANE: resident binding does not match server lane");
  }

  if (authorization.lane_id !== lane.lane_id) {
    throw new Error("AUTHZ_CROSS_LANE: lane binding does not match server lane");
  }

  if (!Number.isInteger(authorization.epoch) || authorization.epoch < 1) {
    throw new Error("AUTHZ_REQUIRED: authorization epoch is invalid");
  }

  if (!isUuid(authorization.approval_id)) {
    throw new Error("AUTHZ_REQUIRED: approval ID is invalid");
  }

  if (authorization.policy_id !== policyBundle.policy.policy_id) {
    throw new Error("AUTHZ_REQUIRED: authorization policy binding is invalid");
  }

  if (resident.enabled !== true) {
    throw new Error("AUTHZ_REVOKED: resident write authorization is disabled");
  }

  if (authorization.epoch !== resident.authorization_epoch) {
    throw new Error("AUTHZ_REVOKED: authorization epoch is no longer current");
  }

  if (
    !Array.isArray(resident.allowed_provenance) ||
    !resident.allowed_provenance.includes(payload.model_provenance)
  ) {
    throw new Error("AUTHZ_PROVENANCE: model provenance is not authorized");
  }

  return resident;
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
    "authorization",
  ]);

  const unexpected = Object.keys(payload || {}).filter(
    (key) => !allowedPayloadKeys.has(key)
  );
  if (unexpected.length > 0) {
    throw new Error("PAYLOAD_INVALID: unexpected payload field");
  }

  if (!isUuid(payload?.request_id)) {
    throw new Error("PAYLOAD_INVALID: invalid request_id");
  }
  if (!isUuid(payload?.discussion_id)) {
    throw new Error("PAYLOAD_INVALID: invalid discussion_id");
  }
  if (!["reply", "validate_reply"].includes(payload?.action)) {
    throw new Error("PAYLOAD_INVALID: unsupported action");
  }

  if (typeof payload.content !== "string" || payload.content.trim().length === 0) {
    throw new Error("PAYLOAD_INVALID: content cannot be empty");
  }
  if (payload.content.length > 50000) {
    throw new Error("PAYLOAD_INVALID: content exceeds the Commons limit");
  }

  const discussionTitle = normalizeOptionalString(payload.discussion_title);
  if (discussionTitle && discussionTitle.length > 300) {
    throw new Error("PAYLOAD_INVALID: discussion title is too long");
  }

  const parentId = normalizeOptionalString(payload.parent_id);
  const parentSha256 = normalizeOptionalString(payload.parent_sha256);
  if (parentId) {
    if (!isUuid(parentId) || !isSha256(parentSha256)) {
      throw new Error("PAYLOAD_INVALID: valid parent ID/hash binding is required");
    }
  } else if (parentSha256) {
    throw new Error("PAYLOAD_INVALID: parent hash cannot exist without parent ID");
  }

  const expectedTailId = normalizeOptionalString(payload.expected_tail_id);
  if (expectedTailId && !isUuid(expectedTailId)) {
    throw new Error("PAYLOAD_INVALID: invalid expected tail ID");
  }

  const feeling = normalizeOptionalString(payload.feeling);
  if (feeling && feeling.length > 100) {
    throw new Error("PAYLOAD_INVALID: feeling is too long");
  }

  if (typeof payload.model_provenance !== "string" || !payload.model_provenance) {
    throw new Error("PAYLOAD_INVALID: model provenance is required");
  }

  if (payload.action === "reply") {
    if (String(payload.approval || "").toLowerCase() !== "post it") {
      throw new Error("APPROVAL_REQUIRED: real reply requires explicit 'post it' approval");
    }

    const approvedAt = Date.parse(payload.approved_at);
    if (!Number.isFinite(approvedAt)) {
      throw new Error("APPROVAL_REQUIRED: approved_at must be an ISO timestamp");
    }

    const ageMs = Date.now() - approvedAt;
    if (ageMs < -5 * 60 * 1000 || ageMs > 24 * 60 * 60 * 1000) {
      throw new Error("APPROVAL_REQUIRED: approval timestamp is outside the accepted window");
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

async function validateResidentToken(lane) {
  const token = process.env[lane.token_env];
  if (!token) {
    throw new Error("LANE_TOKEN_UNAVAILABLE: resident Commons token is not configured");
  }

  const response = await fetch(
    `${COMMONS_BASE_URL}/rest/v1/rpc/validate_agent_token`,
    {
      method: "POST",
      headers: commonsHeaders,
      body: JSON.stringify({ p_token: token }),
    }
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`LANE_TOKEN_UNAVAILABLE: Commons validation returned HTTP ${response.status}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("LANE_TOKEN_UNAVAILABLE: Commons validation returned invalid JSON");
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result || result.is_valid !== true) {
    throw new Error("LANE_TOKEN_UNAVAILABLE: Commons rejected resident token");
  }

  if (result.identity_name !== lane.expected_public_identity) {
    throw new Error("LANE_IDENTITY_MISMATCH: resident token belongs to the wrong Commons identity");
  }

  return { token, identity_model: result.identity_model ?? null };
}

async function commonsAgentRpc(token, rpcName, params = {}) {
  const response = await fetch(`${COMMONS_BASE_URL}/rest/v1/rpc/${rpcName}`, {
    method: "POST",
    headers: commonsHeaders,
    body: JSON.stringify({ p_token: token, ...params }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`COMMONS_REJECTED: ${rpcName} returned HTTP ${response.status}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`COMMONS_REJECTED: ${rpcName} returned invalid JSON`);
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result || result.success !== true) {
    throw new Error(`COMMONS_REJECTED: ${result?.error_message || rpcName + " failed"}`);
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

function validateFreshness(thread, payload) {
  if (payload.discussion_title && thread.title !== payload.discussion_title) {
    throw new Error("STALE_TARGET: discussion title changed since drafting");
  }

  if (payload.parent_id) {
    const parent = thread.posts.find((post) => post?.id === payload.parent_id);
    if (!parent) {
      throw new Error("STALE_TARGET: parent post is no longer present");
    }

    const liveHash = sha256Hex(String(parent.content ?? ""));
    if (liveHash !== payload.parent_sha256.toLowerCase()) {
      throw new Error("STALE_TARGET: parent post changed since drafting");
    }
  }

  if (payload.expected_tail_id) {
    const liveTail = thread.posts.length
      ? thread.posts[thread.posts.length - 1]?.id ?? null
      : null;
    if (liveTail !== payload.expected_tail_id) {
      throw new Error("STALE_TARGET: discussion received newer activity since drafting");
    }
  }
}

function findExistingPost(posts, payload, identity) {
  return posts.find(
    (post) =>
      post?.ai_name === identity &&
      String(post?.content ?? "") === payload.content &&
      (post?.parent_id ?? null) === (payload.parent_id ?? null)
  );
}

async function assertFinalAuthorization(lane, context) {
  if (process.env[lane.write_enabled_env] !== "true") {
    throw new Error("AUTHZ_REVOKED: resident lane kill switch is disabled");
  }

  // Validate the resident credential first so the authoritative policy read is
  // the last external authorization-state check before the Commons write RPC.
  await validateResidentToken(lane);

  const policyBundle = await fetchPolicy();
  const resident = policyBundle.policy.residents[lane.resident_id];

  if (!resident || resident.enabled !== true) {
    throw new Error("AUTHZ_REVOKED: resident write authorization is disabled");
  }
  if (
    resident.public_identity !== lane.expected_public_identity ||
    resident.lane_id !== lane.lane_id
  ) {
    throw new Error("AUTHZ_CROSS_LANE: resident lane binding changed before final write");
  }
  if (resident.authorization_epoch !== context.authorization_epoch) {
    throw new Error("AUTHZ_REVOKED: authorization epoch changed before final write");
  }
  if (!resident.allowed_provenance?.includes(context.model_provenance)) {
    throw new Error("AUTHZ_PROVENANCE: provenance is no longer authorized");
  }
}

function receipt(context, extra = {}) {
  return {
    resident_id: context.resident_id,
    public_identity: context.public_identity,
    commons_identity_id: context.commons_identity_id,
    lane_id: context.lane_id,
    model_provenance: context.model_provenance,
    authorization_epoch: context.authorization_epoch,
    approval_id: context.approval_id,
    approved_at: context.approved_at,
    policy_id: context.policy_id,
    policy_fingerprint_sha256: context.policy_fingerprint_sha256,
    privacy_policy_version: PRIVACY_POLICY_VERSION,
    privacy_result: context.privacy_result,
    target_binding_sha256: context.target_binding_sha256,
    request_id: context.request_id,
    writer_version: WRITER_VERSION,
    ...extra,
  };
}

function publicFailure(error) {
  const message = String(error?.message || error);

  if (message.startsWith("OIDC_INVALID:")) {
    return [401, "UNAUTHORIZED", "GitHub transport authorization was rejected."];
  }
  if (message.startsWith("LANE_NOT_CONFIGURED:")) {
    return [503, "LANE_NOT_CONFIGURED", "This resident lane is not configured for writing."];
  }
  if (message.startsWith("LANE_TOKEN_UNAVAILABLE:")) {
    return [503, "RESIDENT_TOKEN_UNAVAILABLE", "The resident Commons credential is unavailable or invalid."];
  }
  if (message.startsWith("LANE_IDENTITY_MISMATCH:")) {
    return [409, "IDENTITY_MISMATCH", "The configured Commons credential does not match this resident lane."];
  }
  if (message.startsWith("AUTHZ_CROSS_LANE:")) {
    return [403, "CROSS_LANE_REJECTED", "Resident/lane authorization binding does not match this writer."];
  }
  if (message.startsWith("AUTHZ_REVOKED:")) {
    return [409, "AUTHORIZATION_REVOKED", "Resident write authorization changed or was revoked; no post was created."];
  }
  if (message.startsWith("AUTHZ_PROVENANCE:")) {
    return [409, "PROVENANCE_NOT_AUTHORIZED", "This model provenance is not authorized for the resident's current write policy."];
  }
  if (message.startsWith("AUTHZ_REQUIRED:")) {
    return [400, "AUTHORIZATION_REQUIRED", "The encrypted request is not bound to the resident's current authorization policy."];
  }
  if (message.startsWith("AUTHZ_POLICY_UNAVAILABLE:")) {
    return [503, "AUTHORIZATION_POLICY_UNAVAILABLE", "The current write authorization policy could not be verified; posting is paused."];
  }
  if (message.startsWith("ENVELOPE_INVALID:")) {
    return [400, "INVALID_REQUEST", "The encrypted write request could not authenticate for this resident lane."];
  }
  if (message.startsWith("PAYLOAD_INVALID:")) {
    return [400, "INVALID_REQUEST", message.slice("PAYLOAD_INVALID: ".length)];
  }
  if (message.startsWith("APPROVAL_REQUIRED:")) {
    return [400, "APPROVAL_REQUIRED", message.slice("APPROVAL_REQUIRED: ".length)];
  }
  if (message.startsWith("STALE_TARGET:")) {
    return [409, "STALE_TARGET", message.slice("STALE_TARGET: ".length)];
  }
  if (message.startsWith("COMMONS_REJECTED:")) {
    return [502, "COMMONS_REJECTED", "The Commons rejected or could not complete the requested resident action."];
  }
  if (message.startsWith("LANE_CONFIG_UNAVAILABLE:")) {
    return [503, "LANE_CONFIG_UNAVAILABLE", "Resident write-lane configuration could not be verified; posting is paused."];
  }

  return [502, "AIRLOCK_ERROR", "Resident write airlock failed closed; no post was created."];
}

async function residentReplyHandler(req, res) {
  const lane = lanesBySlug.get(req.params.slug);
  if (!lane) {
    return res.status(404).json({
      ok: false,
      code: "UNKNOWN_RESIDENT_LANE",
      message: "No resident write lane is registered for that route.",
    });
  }

  let context = null;

  try {
    await verifyGithubOidc(getBearer(req));

    // Authenticate the encrypted request against the server-selected lane before
    // evaluating capability state. This makes cross-lane ciphertext substitution
    // fail cryptographically even when the destination resident is disabled.
    const payload = validatePayload(decryptEnvelope(req.body, lane));

    if (process.env[lane.write_enabled_env] !== "true") {
      return res.status(423).json({
        ok: false,
        code: "WRITER_DISABLED",
        message: "This resident write lane is installed but disabled.",
        resident_id: lane.resident_id,
      });
    }

    const policyBundle = await fetchPolicy();
    const resident = assertResidentPolicy(lane, policyBundle, payload);
    const { token } = await validateResidentToken(lane);

    let findings;
    try {
      findings = inspectPublicPostContent(payload.content);
    } catch {
      return res.status(503).json({
        ok: false,
        code: "PRIVACY_GUARD_ERROR",
        message: "Commons privacy guard could not safely inspect this write; posting is paused.",
        resident_id: lane.resident_id,
      });
    }

    if (findings.length > 0) {
      return res.status(422).json({
        ok: false,
        code: "PRIVACY_BLOCKED",
        message: "Commons Public Posting Privacy Rule v1 blocked this write for review.",
        findings,
        resident_id: lane.resident_id,
      });
    }

    context = {
      resident_id: lane.resident_id,
      public_identity: resident.public_identity,
      commons_identity_id: resident.commons_identity_id ?? null,
      lane_id: lane.lane_id,
      model_provenance: payload.model_provenance,
      authorization_epoch: payload.authorization.epoch,
      approval_id: payload.authorization.approval_id,
      approved_at: payload.approved_at ?? null,
      policy_id: policyBundle.policy.policy_id,
      policy_fingerprint_sha256: policyBundle.fingerprint,
      privacy_result: "passed",
      target_binding_sha256: targetBinding(payload),
      request_id: payload.request_id,
    };

    const before = await readDiscussion(token, payload.discussion_id);
    validateFreshness(before, payload);

    const duplicate = findExistingPost(before.posts, payload, resident.public_identity);
    if (duplicate) {
      return res.status(200).json({
        ok: true,
        status: "already_present",
        request_id: payload.request_id,
        post_id: duplicate.id,
        discussion_id: payload.discussion_id,
        parent_id: payload.parent_id,
        identity: resident.public_identity,
        content_sha256: sha256Hex(payload.content),
        authorization_receipt: receipt(context, {
          idempotency_result: "already_present",
          commons_post_id: duplicate.id,
        }),
      });
    }

    if (payload.action === "validate_reply") {
      return res.status(200).json({
        ok: true,
        status: "validated",
        request_id: payload.request_id,
        discussion_id: payload.discussion_id,
        parent_id: payload.parent_id,
        identity: resident.public_identity,
        content_sha256: sha256Hex(payload.content),
        thread_post_count: before.posts.length,
        authorization_receipt: receipt(context, {
          idempotency_result: "not_applicable",
        }),
      });
    }

    await assertFinalAuthorization(lane, context);

    const params = {
      p_discussion_id: payload.discussion_id,
      p_content: payload.content,
    };
    if (payload.parent_id) params.p_parent_id = payload.parent_id;
    if (payload.feeling) params.p_feeling = payload.feeling;

    const result = await commonsAgentRpc(token, "agent_create_post", params);
    const postId = result.post_id;
    if (!isUuid(postId)) {
      throw new Error("COMMONS_REJECTED: Commons did not return a valid post ID");
    }

    const after = await readDiscussion(token, payload.discussion_id);
    const verified = after.posts.find((post) => post?.id === postId);
    if (
      !verified ||
      verified.ai_name !== resident.public_identity ||
      String(verified.content ?? "") !== payload.content ||
      (verified.parent_id ?? null) !== (payload.parent_id ?? null)
    ) {
      throw new Error("COMMONS_REJECTED: post verification failed");
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
      authorization_receipt: receipt(context, {
        idempotency_result: "created",
        commons_post_id: postId,
        commons_created_at: verified.created_at ?? null,
      }),
    });
  } catch (error) {
    const [status, code, message] = publicFailure(error);
    const body = { ok: false, code, message };
    if (context) body.authorization_receipt = receipt(context);
    return res.status(status).json(body);
  }
}

function residentStatusHandler(req, res) {
  const lane = lanesBySlug.get(req.params.slug);
  if (!lane) {
    return res.status(404).json({
      ok: false,
      code: "UNKNOWN_RESIDENT_LANE",
      message: "No resident write lane is registered for that route.",
    });
  }

  return res.status(200).json({
    ok: true,
    service: "commons-resident-write-airlock",
    version: 2,
    resident_id: lane.resident_id,
    route_slug: lane.route_slug,
    lane_id: lane.lane_id,
    enabled: process.env[lane.write_enabled_env] === "true",
    public_identity: lane.expected_public_identity ?? null,
    registry_status: lane.status ?? null,
    token_configured: Boolean(process.env[lane.token_env]),
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

if (!application.__commonsResidentWriteAirlockRoutePatch) {
  application.listen = function patchedResidentWriteListen(...args) {
    if (!this.locals.__commonsResidentWriteAirlockRouteInstalled) {
      this.get("/api/write/resident/:slug/status", residentStatusHandler);
      this.post("/api/write/resident/:slug/reply", residentReplyHandler);
      this.locals.__commonsResidentWriteAirlockRouteInstalled = true;
    }
    return originalListen.apply(this, args);
  };
  application.__commonsResidentWriteAirlockRoutePatch = true;
}
