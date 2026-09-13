import express from "express";
import crypto from "crypto";

const COMMONS_WRITE_PRIVATE_KEY_B64 = process.env.COMMONS_WRITE_PRIVATE_KEY_B64;

function currentTransportKey() {
  if (!COMMONS_WRITE_PRIVATE_KEY_B64) {
    throw new Error("Writer private key is not configured.");
  }

  const privatePem = Buffer.from(
    COMMONS_WRITE_PRIVATE_KEY_B64,
    "base64"
  ).toString("utf8");
  const privateKey = crypto.createPrivateKey(privatePem);
  const publicKey = crypto.createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const keyId = crypto.createHash("sha256").update(publicDer).digest("hex");

  return { publicPem, keyId };
}

function publicKeyHandler(_req, res) {
  try {
    const { publicPem, keyId } = currentTransportKey();
    return res.status(200).json({
      ok: true,
      service: "commons-write-airlock",
      version: 1,
      algorithm: "RSA-OAEP-SHA256 + AES-256-GCM",
      key_id: keyId,
      public_key_pem: publicPem,
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      code: "KEY_UNAVAILABLE",
      message: String(error?.message || error),
    });
  }
}

const application = express.application;
const originalListen = application.listen;

if (!application.__commonsWritePublicKeyRoutePatch) {
  application.listen = function patchedListen(...args) {
    if (!this.locals.__commonsWritePublicKeyRouteInstalled) {
      this.get("/api/write/public-key", publicKeyHandler);
      this.locals.__commonsWritePublicKeyRouteInstalled = true;
    }
    return originalListen.apply(this, args);
  };
  application.__commonsWritePublicKeyRoutePatch = true;
}
