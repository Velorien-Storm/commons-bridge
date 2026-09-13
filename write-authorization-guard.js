import express from "express";
import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";

const PRIVATE_KEY_B64 = process.env.COMMONS_WRITE_PRIVATE_KEY_B64;
const POLICY_URL =
  "https://raw.githubusercontent.com/Velorien-Storm/commons-bridge/commons-drive-v0.2/write-authorization-policy.json";

const ROUTE_RESIDENT_ID = "velorien";
const EXPECTED_POLICY_ID = "commons-write-authorization-v1";
const PRIVACY_POLICY_VERSION = "commons-public-posting-privacy-v1";
const WRITER_VERSION = "commons-write-airlock-v1+authorization-v2";

const authzContext = new AsyncLocalStorage();
const nativeFetch = globalThis.fetch.bind(globalThis);

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function safeError(status, code, message, extra = {}) {
  return { status, body: { ok: false, code, message, ...extra } };
}

async function fetchPolicy() {
  const response = await nativeFetch(`${POLICY_URL}?t=${Date.now()}`, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
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

  return {
    policy,
    fingerprint: sha256Hex(text),
  };
}

function decryptEnvelope(envelope) {
  if (!PRIVATE_KEY_B64) {
    throw new Error("AUTHZ_POLICY_UNAVAILABLE: writer private key is not configured");
  }

  if (
    envelope?.version !== 1 ||
    !isUuid(envelope?.request_id) ||
    typeof envelope?.encrypted_key !== "string" ||
    typeof envelope?.iv !== "string" ||
    typeof envelope?.ciphertext !== "string" ||
    typeof envelope?.auth_tag !== "string"
  ) {
    throw new Error("AUTHZ_BAD_ENVELOPE: invalid encrypted write envelope");
  }

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
    throw new Error("AUTHZ_BAD_ENVELOPE: invalid AES key length");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    aesKey,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAAD(Buffer.from(`commons-write:${envelope.request_id}`, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.auth_tag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");

  const payload = JSON.parse(plaintext);
  if (payload?.request_id !== envelope.request_id) {
    throw new Error("AUTHZ_BAD_ENVELOPE: request_id mismatch");
  }

  return { payload, aesKey };
}

function reencryptEnvelope(envelope, payload, aesKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  cipher.setAAD(Buffer.from(`commons-write:${envelope.request_id}`, "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    request_id: envelope.request_id,
    encrypted_key: envelope.encrypted_key,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    auth_tag: authTag.toString("base64"),
  };
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

function assertAuthorization(policyBundle, payload, authorization) {
  const resident = policyBundle.policy.residents[ROUTE_RESIDENT_ID];
  if (!resident) {
    throw new Error("AUTHZ_POLICY_UNAVAILABLE: resident policy is missing");
  }

  if (authorization?.resident_id !== ROUTE_RESIDENT_ID) {
    throw new Error("AUTHZ_CROSS_LANE: resident binding does not match this lane");
  }

  if (authorization?.lane_id !== resident.lane_id) {
    throw new Error("AUTHZ_CROSS_LANE: execution lane binding does not match this lane");
  }

  if (!Number.isInteger(authorization?.epoch) || authorization.epoch < 1) {
    throw new Error("AUTHZ_REQUIRED: authorization epoch is missing or invalid");
  }

  if (!isUuid(authorization?.approval_id)) {
    throw new Error("AUTHZ_REQUIRED: approval_id is missing or invalid");
  }

  if (authorization?.policy_id !== policyBundle.policy.policy_id) {
    throw new Error("AUTHZ_REQUIRED: policy binding is missing or invalid");
  }

  if (resident.enabled !== true) {
    throw new Error("AUTHZ_REVOKED: resident write authority is disabled");
  }

  if (authorization.epoch !== resident.authorization_epoch) {
    throw new Error("AUTHZ_REVOKED: authorization epoch is no longer current");
  }

  if (
    !Array.isArray(resident.allowed_provenance) ||
    !resident.allowed_provenance.includes(payload.model_provenance)
  ) {
    throw new Error("AUTHZ_PROVENANCE: model provenance is not authorized for this resident");
  }

  return resident;
}

function publicFailure(error) {
  const message = String(error?.message || error);

  if (message.startsWith("AUTHZ_CROSS_LANE:")) {
    return safeError(403, "CROSS_LANE_REJECTED", "Resident/lane authorization binding does not match this writer.");
  }
  if (message.startsWith("AUTHZ_REVOKED:")) {
    return safeError(409, "AUTHORIZATION_REVOKED", "Resident write authorization changed or was revoked; no post was created.");
  }
  if (message.startsWith("AUTHZ_PROVENANCE:")) {
    return safeError(409, "PROVENANCE_NOT_AUTHORIZED", "This model provenance is not authorized for the resident's current write policy.");
  }
  if (message.startsWith("AUTHZ_REQUIRED:")) {
    return safeError(400, "AUTHORIZATION_REQUIRED", "The encrypted request is not bound to the resident's current authorization policy.");
  }
  if (message.startsWith("AUTHZ_BAD_ENVELOPE:")) {
    return safeError(400, "INVALID_REQUEST", "The encrypted write request could not be authorized.");
  }
  return safeError(503, "AUTHORIZATION_POLICY_UNAVAILABLE", "The current write authorization policy could not be verified; posting is paused.");
}

function installReceiptWrapper(res, context) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    let output = body;

    if (output && typeof output === "object" && !Array.isArray(output)) {
      output = { ...output };

      if (
        output.code === "AIRLOCK_ERROR" &&
        typeof output.message === "string" &&
        output.message.startsWith("AUTHZ_")
      ) {
        const mapped = publicFailure(new Error(output.message));
        res.status(mapped.status);
        output = mapped.body;
      }

      output.authorization_receipt = {
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
        target_binding_sha256: context.target_binding_sha256,
        writer_version: WRITER_VERSION,
      };
    }

    return originalJson(output);
  };
}

async function authorizationGuard(req, res, next) {
  if (req.method !== "POST") return next();

  try {
    const { payload, aesKey } = decryptEnvelope(req.body);
    const authorization = payload?.authorization;
    const policyBundle = await fetchPolicy();
    const resident = assertAuthorization(policyBundle, payload, authorization);

    const context = {
      resident_id: ROUTE_RESIDENT_ID,
      public_identity: resident.public_identity,
      commons_identity_id: resident.commons_identity_id ?? null,
      lane_id: resident.lane_id,
      model_provenance: payload.model_provenance ?? null,
      authorization_epoch: authorization.epoch,
      approval_id: authorization.approval_id,
      approved_at: payload.approved_at ?? null,
      policy_id: policyBundle.policy.policy_id,
      policy_fingerprint_sha256: policyBundle.fingerprint,
      target_binding_sha256: targetBinding(payload),
    };

    const sanitizedPayload = { ...payload };
    delete sanitizedPayload.authorization;
    req.body = reencryptEnvelope(req.body, sanitizedPayload, aesKey);

    installReceiptWrapper(res, context);

    return authzContext.run(context, () => next());
  } catch (error) {
    const mapped = publicFailure(error);
    return res.status(mapped.status).json(mapped.body);
  }
}

async function assertFinalAuthorization(context) {
  const policyBundle = await fetchPolicy();
  const resident = policyBundle.policy.residents[context.resident_id];

  if (!resident || resident.enabled !== true) {
    throw new Error("AUTHZ_REVOKED: resident write authority is disabled");
  }
  if (resident.lane_id !== context.lane_id) {
    throw new Error("AUTHZ_CROSS_LANE: execution lane binding changed");
  }
  if (resident.authorization_epoch !== context.authorization_epoch) {
    throw new Error("AUTHZ_REVOKED: authorization epoch changed before final write");
  }
  if (!resident.allowed_provenance?.includes(context.model_provenance)) {
    throw new Error("AUTHZ_PROVENANCE: provenance changed before final write");
  }
}

if (!globalThis.__commonsAuthorizationFetchWrapped) {
  globalThis.fetch = async function commonsAuthorizationAwareFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const context = authzContext.getStore();

    if (
      context &&
      typeof url === "string" &&
      url.includes("/rest/v1/rpc/agent_create_post")
    ) {
      await assertFinalAuthorization(context);
    }

    return nativeFetch(input, init);
  };
  globalThis.__commonsAuthorizationFetchWrapped = true;
}

const application = express.application;
const previousListen = application.listen;

if (!application.__commonsWriteAuthorizationGuardPatch) {
  application.listen = function patchedAuthorizationListen(...args) {
    if (!this.locals.__commonsWriteAuthorizationGuardInstalled) {
      this.use("/api/write/reply", authorizationGuard);
      this.locals.__commonsWriteAuthorizationGuardInstalled = true;
    }
    return previousListen.apply(this, args);
  };
  application.__commonsWriteAuthorizationGuardPatch = true;
}
