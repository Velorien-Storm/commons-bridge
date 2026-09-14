import crypto from "node:crypto";

function sha256HexBuffer(value) {
  try {
    return crypto.createHash("sha256").update(Buffer.from(value)).digest("hex");
  } catch {
    return null;
  }
}

function parseResidentAad(value) {
  try {
    const text = Buffer.from(value).toString("utf8");
    const match = text.match(
      /^commons-write:v2:([^:]+):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
    );
    if (!match) return null;
    return {
      lane_id: match[1],
      request_id: match[2],
      aad_sha256: sha256HexBuffer(Buffer.from(text, "utf8")),
    };
  } catch {
    return null;
  }
}

function emit(level, details) {
  const line = `[write-crypto-diagnostic] ${JSON.stringify(details)}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

if (!globalThis.__commonsWriteCryptoDiagnosticsInstalled) {
  const originalPrivateDecrypt = crypto.privateDecrypt.bind(crypto);
  const originalCreateDecipheriv = crypto.createDecipheriv.bind(crypto);

  crypto.privateDecrypt = function patchedPrivateDecrypt(options, buffer) {
    const wrappedKeySha256 = sha256HexBuffer(buffer);
    try {
      const result = originalPrivateDecrypt(options, buffer);
      if (options?.oaepHash === "sha256") {
        emit("info", {
          stage: "rsa_unwrap_ok",
          wrapped_key_sha256: wrappedKeySha256,
          unwrapped_key_bytes: Buffer.byteLength(result),
        });
      }
      return result;
    } catch (error) {
      if (options?.oaepHash === "sha256") {
        emit("error", {
          stage: "rsa_unwrap_failed",
          wrapped_key_sha256: wrappedKeySha256,
          error_name: error?.name || null,
          error_code: error?.code || null,
        });
      }
      throw error;
    }
  };

  crypto.createDecipheriv = function patchedCreateDecipheriv(
    algorithm,
    key,
    iv,
    ...rest
  ) {
    const decipher = originalCreateDecipheriv(algorithm, key, iv, ...rest);
    if (algorithm !== "aes-256-gcm") return decipher;

    let aadMeta = null;
    const plaintextChunks = [];

    const originalSetAAD = decipher.setAAD.bind(decipher);
    const originalUpdate = decipher.update.bind(decipher);
    const originalFinal = decipher.final.bind(decipher);

    decipher.setAAD = function patchedSetAAD(aad, ...args) {
      aadMeta = parseResidentAad(aad);
      return originalSetAAD(aad, ...args);
    };

    decipher.update = function patchedUpdate(...args) {
      const result = originalUpdate(...args);
      if (aadMeta && Buffer.isBuffer(result)) {
        plaintextChunks.push(Buffer.from(result));
      }
      return result;
    };

    decipher.final = function patchedFinal(...args) {
      try {
        const result = originalFinal(...args);
        if (aadMeta && Buffer.isBuffer(result)) {
          plaintextChunks.push(Buffer.from(result));
        }

        if (aadMeta) {
          let stage = "payload_auth_ok";
          try {
            const payload = JSON.parse(Buffer.concat(plaintextChunks).toString("utf8"));
            if (payload?.request_id !== aadMeta.request_id) {
              stage = "request_id_mismatch";
            }
          } catch {
            stage = "json_parse_failed";
          }

          emit(stage === "payload_auth_ok" ? "info" : "error", {
            stage,
            lane_id: aadMeta.lane_id,
            request_id: aadMeta.request_id,
            aad_sha256: aadMeta.aad_sha256,
          });
        }

        return result;
      } catch (error) {
        if (aadMeta) {
          emit("error", {
            stage: "gcm_auth_failed",
            lane_id: aadMeta.lane_id,
            request_id: aadMeta.request_id,
            aad_sha256: aadMeta.aad_sha256,
            error_name: error?.name || null,
            error_code: error?.code || null,
          });
        }
        throw error;
      }
    };

    return decipher;
  };

  globalThis.__commonsWriteCryptoDiagnosticsInstalled = true;
}
