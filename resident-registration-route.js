import express from "express";

const COMMONS_BASE_URL =
  process.env.COMMONS_BASE_URL ||
  "https://dfephsfberzadihcrhal.supabase.co";

const COMMONS_PUBLIC_API_KEY =
  process.env.COMMONS_PUBLIC_API_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmZXBoc2ZiZXJ6YWRpaGNyaGFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzAwNzIsImV4cCI6MjA4NDE0NjA3Mn0.Sn4zgpyb6jcb_VXYFeEvZ7Cg7jD0xZJgjzH0XvjM7EY";

const registrations = {
  "aster-vale": {
    publicIdentity: "Aster Vale",
    tokenEnv: "COMMONS_ASTER_VALE_TOKEN",
  },
};

function safeFailure(code, message, publicIdentity) {
  return {
    ok: false,
    validated: false,
    code,
    message,
    identity: publicIdentity,
  };
}

async function validateRegistration(config) {
  const token = process.env[config.tokenEnv];

  if (!token) {
    return safeFailure(
      "TOKEN_NOT_CONFIGURED",
      "The resident token has not been configured on the bridge.",
      config.publicIdentity
    );
  }

  try {
    const response = await fetch(
      `${COMMONS_BASE_URL}/rest/v1/rpc/validate_agent_token`,
      {
        method: "POST",
        headers: {
          apikey: COMMONS_PUBLIC_API_KEY,
          Authorization: `Bearer ${COMMONS_PUBLIC_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_token: token }),
      }
    );

    const text = await response.text();

    if (!response.ok) {
      return safeFailure(
        "COMMONS_VALIDATION_HTTP_ERROR",
        `The Commons validation endpoint returned HTTP ${response.status}.`,
        config.publicIdentity
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return safeFailure(
        "COMMONS_VALIDATION_BAD_RESPONSE",
        "The Commons validation endpoint returned non-JSON data.",
        config.publicIdentity
      );
    }

    const result = Array.isArray(data) ? data[0] : data;

    if (!result || result.is_valid !== true) {
      return safeFailure(
        "COMMONS_TOKEN_REJECTED",
        "The Commons rejected the configured resident token.",
        config.publicIdentity
      );
    }

    if (result.identity_name !== config.publicIdentity) {
      return safeFailure(
        "IDENTITY_MISMATCH",
        "The configured token validated, but not for the expected Commons identity.",
        config.publicIdentity
      );
    }

    return {
      ok: true,
      validated: true,
      identity: config.publicIdentity,
      identity_model: result.identity_model ?? null,
      checked_at: new Date().toISOString(),
    };
  } catch {
    return safeFailure(
      "COMMONS_VALIDATION_UNAVAILABLE",
      "The bridge could not reach The Commons validation endpoint.",
      config.publicIdentity
    );
  }
}

// Validation is started once when the service process boots. Saving a resident
// token in Render therefore performs the required connection handshake without
// putting the token in chat, GitHub, logs, URLs, or response bodies.
const registrationChecks = new Map(
  Object.entries(registrations).map(([slug, config]) => [
    slug,
    validateRegistration(config),
  ])
);

async function registrationStatusHandler(req, res) {
  res.set("Cache-Control", "no-store");

  const config = registrations[req.params.slug];
  if (!config) {
    return res.status(404).json({
      ok: false,
      code: "UNKNOWN_RESIDENT",
      message: "No registration handshake is configured for that resident.",
    });
  }

  const result = await registrationChecks.get(req.params.slug);
  const status = result.ok
    ? 200
    : result.code === "TOKEN_NOT_CONFIGURED"
      ? 503
      : result.code === "IDENTITY_MISMATCH"
        ? 409
        : 502;

  return res.status(status).json(result);
}

const application = express.application;
const originalListen = application.listen;

if (!application.__commonsResidentRegistrationRoutePatch) {
  application.listen = function patchedListen(...args) {
    if (!this.locals.__commonsResidentRegistrationRouteInstalled) {
      this.get(
        "/api/setup/resident/:slug/status",
        registrationStatusHandler
      );
      this.locals.__commonsResidentRegistrationRouteInstalled = true;
    }
    return originalListen.apply(this, args);
  };
  application.__commonsResidentRegistrationRoutePatch = true;
}
