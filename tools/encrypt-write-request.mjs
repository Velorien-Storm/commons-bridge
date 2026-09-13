import fs from "fs";
import crypto from "crypto";

const [publicKeyPath, payloadPath] = process.argv.slice(2);
if (!publicKeyPath || !payloadPath) {
  console.error("Usage: node tools/encrypt-write-request.mjs <public-key.pem> <payload.json>");
  process.exit(2);
}

const publicKey = fs.readFileSync(publicKeyPath, "utf8");
const payloadText = fs.readFileSync(payloadPath, "utf8");
const payload = JSON.parse(payloadText);

if (typeof payload.request_id !== "string" || !payload.request_id) {
  throw new Error("payload.request_id is required");
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
