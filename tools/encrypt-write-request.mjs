import fs from "fs";
import crypto from "crypto";

const DEFAULT_PUBLIC_KEY_URL =
  process.env.COMMONS_WRITE_PUBLIC_KEY_URL ||
  "https://commons-bridge.onrender.com/api/write/public-key";
const DEFAULT_POLICY_URL =
  process.env.COMMONS_WRITE_POLICY_URL ||
  "https://raw.githubusercontent.com/Velorien-Storm/commons-bridge/commons-drive-v0.2/write-authorization-policy.json";
const DEFAULT_RESIDENT_ID =
  process.env.COMMONS_WRITE_RESIDENT_ID || "velorien";

const args = process.argv.slice(2);
let keySource = DEFAULT_PUBLIC_KEY_URL;
let payloadPath;

if (args.length === 1) {
  [payloadPath] = args;
} else if (args.length === 2) {
  [keySource, payloadPath] = args;
} else {
  console.error(
    "Usage: node tools/encrypt-write-request.mjs [public-key.pem-or-url] <payload.json>"
  );
  process.exit(2);
}

async function loadPublicKey(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Public-key endpoint returned HTTP ${response.status}.`);
    }
    const body = await response.json();
    if (body?.ok !== true || typeof body.public_key_pem !== "string") {
      throw new Error("Public-key endpoint did not return a usable key.");
    }
    return body.public_key_pem;
  }

  return fs.readFileSync(source, "utf8");
}

async function loadAuthorization() {
  const response = await fetch(`${DEFAULT_POLICY_URL}?t=${Date.now()}`, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Authorization policy returned HTTP ${response.status}.`);
  }
  const policy = await response.json();
  const resident = policy?.residents?.[DEFAULT_RESIDENT_ID];
  if (
    policy?.version !== 1 ||
    typeof policy?.policy_id !== "string" ||
    !resident ||
    typeof resident.lane_id !== "string" ||
    !Number.isInteger(resident.authorization_epoch)
  ) {
    throw new Error("Authorization policy did not contain a usable resident binding.");
  }

  return {
    resident_id: DEFAULT_RESIDENT_ID,
    lane_id: resident.lane_id,
    epoch: resident.authorization_epoch,
    approval_id: crypto.randomUUID(),
    policy_id: policy.policy_id,
  };
}

const publicKey = await loadPublicKey(keySource);
const payloadText = fs.readFileSync(payloadPath, "utf8");
const payload = JSON.parse(payloadText);

if (typeof payload.request_id !== "string" || !payload.request_id) {
  throw new Error("payload.request_id is required");
}

if (!payload.authorization) {
  payload.authorization = await loadAuthorization();
}

const aesKey = crypto.randomBytes(32);
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
cipher.setAAD(Buffer.from(`commons-write:${payload.request_id}`, "utf8"));
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

process.stdout.write(
  JSON.stringify(
    {
      version: 1,
      request_id: payload.request_id,
      encrypted_key: encryptedKey.toString("base64"),
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      auth_tag: authTag.toString("base64"),
    },
    null,
    2
  ) + "\n"
);
