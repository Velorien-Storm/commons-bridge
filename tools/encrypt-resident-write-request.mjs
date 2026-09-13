import fs from "node:fs";
import crypto from "node:crypto";

const DEFAULT_PUBLIC_KEY_URL =
  process.env.COMMONS_WRITE_PUBLIC_KEY_URL ||
  "https://commons-bridge.onrender.com/api/write/public-key";
const DEFAULT_POLICY_URL =
  process.env.COMMONS_WRITE_POLICY_URL ||
  "https://api.github.com/repos/Velorien-Storm/commons-bridge/contents/write-authorization-policy.json?ref=commons-drive-v0.2";

const args = process.argv.slice(2);
let residentId;
let keySource = DEFAULT_PUBLIC_KEY_URL;
let payloadPath;

if (args.length === 2) {
  [residentId, payloadPath] = args;
} else if (args.length === 3) {
  [residentId, keySource, payloadPath] = args;
} else {
  console.error(
    "Usage: node tools/encrypt-resident-write-request.mjs <resident-id> [public-key.pem-or-url] <payload.json>"
  );
  process.exit(2);
}

function loadRegistry() {
  const url = new URL("../resident-write-lanes.json", import.meta.url);
  const parsed = JSON.parse(fs.readFileSync(url, "utf8"));
  if (parsed?.version !== 1 || !parsed?.lanes || typeof parsed.lanes !== "object") {
    throw new Error("Resident lane registry is missing or invalid.");
  }
  return parsed;
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

async function loadPolicy() {
  const separator = DEFAULT_POLICY_URL.includes("?") ? "&" : "?";
  const response = await fetch(`${DEFAULT_POLICY_URL}${separator}t=${Date.now()}`, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      "Cache-Control": "no-cache",
      "User-Agent": "commons-bridge-resident-sealer",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Authorization policy returned HTTP ${response.status}.`);
  }
  return response.json();
}

const registry = loadRegistry();
const lane = registry.lanes[residentId];
if (!lane) {
  throw new Error(`Unknown resident lane '${residentId}'.`);
}
if (
  typeof lane.lane_id !== "string" ||
  lane.policy_resident_id !== residentId ||
  typeof lane.route_slug !== "string"
) {
  throw new Error("Resident lane registry record is invalid.");
}

const policy = await loadPolicy();
const resident = policy?.residents?.[residentId];
if (
  policy?.version !== 1 ||
  typeof policy?.policy_id !== "string" ||
  !resident ||
  resident.lane_id !== lane.lane_id ||
  !Number.isInteger(resident.authorization_epoch)
) {
  throw new Error("Authorization policy did not contain a usable matching resident binding.");
}

if (
  typeof lane.expected_public_identity === "string" &&
  lane.expected_public_identity &&
  resident.public_identity !== lane.expected_public_identity
) {
  throw new Error("Resident lane registry and authorization policy disagree on public identity.");
}

const publicKey = await loadPublicKey(keySource);
const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));

if (typeof payload.request_id !== "string" || !payload.request_id) {
  throw new Error("payload.request_id is required");
}

if (!payload.authorization) {
  payload.authorization = {
    resident_id: residentId,
    lane_id: lane.lane_id,
    epoch: resident.authorization_epoch,
    approval_id: crypto.randomUUID(),
    policy_id: policy.policy_id,
  };
}

const aesKey = crypto.randomBytes(32);
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
cipher.setAAD(
  Buffer.from(
    `commons-write:v2:${lane.lane_id}:${payload.request_id}`,
    "utf8"
  )
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

process.stdout.write(
  JSON.stringify(
    {
      version: 2,
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
