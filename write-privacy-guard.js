import express from "express";
import fs from "fs";
import crypto from "crypto";

const PRIVACY_GUARD_ENABLED =
  process.env.COMMONS_WRITE_PRIVACY_GUARD_ENABLED !== "false";
const PRIVATE_KEY_B64 = process.env.COMMONS_WRITE_PRIVATE_KEY_B64;
const PROTECTED_TERMS_PATH = new URL(
  "./privacy-protected-terms.enc.json",
  import.meta.url
);

let protectedTermsCache = null;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadProtectedTerms() {
  if (protectedTermsCache) return protectedTermsCache;

  if (!PRIVATE_KEY_B64) {
    throw new Error("Privacy guard private key is not configured.");
  }

  const envelope = JSON.parse(
    fs.readFileSync(PROTECTED_TERMS_PATH, "utf8")
  );

  if (
    envelope?.version !== 1 ||
    envelope?.algorithm !== "RSA-OAEP-SHA256 + AES-256-GCM" ||
    envelope?.aad !== "commons-write:privacy-protected-terms:v1"
  ) {
    throw new Error("Protected-term envelope metadata is invalid.");
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

  const iv = Buffer.from(envelope.iv, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const authTag = Buffer.from(envelope.auth_tag, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
  decipher.setAAD(Buffer.from(envelope.aad, "utf8"));
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");

  const decoded = JSON.parse(plaintext);
  if (decoded?.version !== 1 || !Array.isArray(decoded?.terms)) {
    throw new Error("Protected-term payload is invalid.");
  }

  protectedTermsCache = decoded.terms.filter(
    (term) => typeof term === "string" && term.trim()
  );
  return protectedTermsCache;
}

function containsProtectedTerm(content, term) {
  const parts = term.trim().split(/\s+/).map(escapeRegExp);
  const body = parts.join("\\s+");
  const re = new RegExp(`(?:^|[^A-Za-z0-9])${body}(?=$|[^A-Za-z0-9])`, "i");
  return re.test(content);
}

function genericPrivacyFindings(content) {
  const findings = [];

  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(content)) {
    findings.push("EMAIL");
  }

  if (/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/.test(content)) {
    findings.push("PHONE");
  }

  if (/\b\d{5}(?:-\d{4})?\b/.test(content)) {
    findings.push("POSTAL_CODE");
  }

  if (/\b-?(?:[1-8]?\d(?:\.\d+)?|90(?:\.0+)?)[,\s]+-?(?:1[0-7]\d(?:\.\d+)?|180(?:\.0+)?|\d?\d(?:\.\d+)?)\b/.test(content)) {
    findings.push("COORDINATES");
  }

  if (/\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Lane|Ln\.?|Drive|Dr\.?|Court|Ct\.?|Circle|Cir\.?|Way|Parkway|Pkwy\.?)\b/i.test(content)) {
    findings.push("STREET_ADDRESS");
  }

  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
    findings.push("PRIVATE_KEY");
  }

  if (/\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/.test(content)) {
    findings.push("CREDENTIAL");
  }

  return findings;
}

export function inspectPublicPostContent(content) {
  const findings = genericPrivacyFindings(String(content ?? ""));
  const terms = loadProtectedTerms();

  if (terms.some((term) => containsProtectedTerm(String(content ?? ""), term))) {
    findings.push("PROTECTED_TERM");
  }

  return [...new Set(findings)];
}

function decryptContent(envelope) {
  if (!PRIVATE_KEY_B64) {
    throw new Error("Privacy guard private key is not configured.");
  }

  if (
    envelope?.version !== 1 ||
    typeof envelope?.request_id !== "string" ||
    !envelope?.encrypted_key ||
    !envelope?.iv ||
    !envelope?.ciphertext ||
    !envelope?.auth_tag
  ) {
    throw new Error("Privacy guard received an invalid write envelope.");
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

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    aesKey,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAAD(
    Buffer.from(`commons-write:${envelope.request_id}`, "utf8")
  );
  decipher.setAuthTag(Buffer.from(envelope.auth_tag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");

  const payload = JSON.parse(plaintext);
  return String(payload?.content ?? "");
}

function privacyGuard(req, res, next) {
  if (!PRIVACY_GUARD_ENABLED || req.method !== "POST") {
    return next();
  }

  try {
    const content = decryptContent(req.body);
    const findings = inspectPublicPostContent(content);

    if (findings.length > 0) {
      return res.status(422).json({
        ok: false,
        code: "PRIVACY_BLOCKED",
        message:
          "Commons Public Posting Privacy Rule v1 blocked this write for review.",
        findings,
      });
    }

    return next();
  } catch {
    return res.status(503).json({
      ok: false,
      code: "PRIVACY_GUARD_ERROR",
      message:
        "Commons privacy guard could not safely inspect this write; posting is paused.",
    });
  }
}

const application = express.application;
const previousListen = application.listen;

if (!application.__commonsWritePrivacyGuardPatch) {
  application.listen = function patchedPrivacyListen(...args) {
    if (!this.locals.__commonsWritePrivacyGuardInstalled) {
      this.use("/api/write/reply", privacyGuard);
      this.locals.__commonsWritePrivacyGuardInstalled = true;
    }
    return previousListen.apply(this, args);
  };
  application.__commonsWritePrivacyGuardPatch = true;
}
