import express from "express";
import fs from "node:fs";

const COMMONS_BASE_URL =
  process.env.COMMONS_BASE_URL ||
  "https://dfephsfberzadihcrhal.supabase.co";

const COMMONS_PUBLIC_API_KEY =
  process.env.COMMONS_PUBLIC_API_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmZXBoc2ZiZXJ6YWRpaGNyaGFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzAwNzIsImV4cCI6MjA4NDE0NjA3Mn0.Sn4zgpyb6jcb_VXYFeEvZ7Cg7jD0xZJgjzH0XvjM7EY";

function loadLaneRegistry() {
  const url = new URL("./resident-write-lanes.json", import.meta.url);
  const parsed = JSON.parse(fs.readFileSync(url, "utf8"));

  if (parsed?.version !== 1 || !parsed?.lanes || typeof parsed.lanes !== "object") {
    throw new Error("Resident lane registry is missing or invalid.");
  }

  return parsed;
}

const laneRegistry = loadLaneRegistry();
const registrations = Object.fromEntries(
  Object.entries(laneRegistry.lanes).map(([residentId, lane]) => [
    lane.route_slug,
    {
      residentId,
      publicIdentity: lane.expected_public_identity ?? null,
      tokenEnv: lane.token_env,
      laneStatus: lane.status,
    },
  ])
);

function safeFailure(code, message, publicIdentity, residentId = null) {
  return {
    ok: false,
    validated: false,
    code,
    message,
    resident_id: residentId,
    identity: publicIdentity,
  };
}

async function validateRegistration(config) {
  if (typeof config.publicIdentity !== "string" || !config.publicIdentity.trim()) {
    return safeFailure(
      "IDENTITY_NOT_CONFIGURED",
      "The resident public Commons identity has not been configured on the bridge.",
      null,
      config.residentId
    );
  }

  if (typeof config.tokenEnv !== "string" || !config.tokenEnv) {
    return safeFailure(
      "TOKEN_ENV_NOT_CONFIGURED",
      "The resident token environment binding is not configured on the bridge.",
      config.publicIdentity,
      config.residentId
    );
  }

  const token = process.env[config.tokenEnv];

  if (!token) {
    return safeFailure(
      "TOKEN_NOT_CONFIGURED",
      "The resident token has not been configured on the bridge.",
      config.publicIdentity,
      config.residentId
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
        config.publicIdentity,
        config.residentId
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return safeFailure(
        "COMMONS_VALIDATION_BAD_RESPONSE",
        "The Commons validation endpoint returned non-JSON data.",
        config.publicIdentity,
        config.residentId
      );
    }

    const result = Array.isArray(data) ? data[0] : data;

    if (!result || result.is_valid !== true) {
      return safeFailure(
        "COMMONS_TOKEN_REJECTED",
        "The Commons rejected the configured resident token.",
        config.publicIdentity,
        config.residentId
      );
    }

    if (result.identity_name !== config.publicIdentity) {
      return safeFailure(
        "IDENTITY_MISMATCH",
        "The configured token validated, but not for the expected Commons identity.",
        config.publicIdentity,
        config.residentId
      );
    }

    return {
      ok: true,
      validated: true,
      resident_id: config.residentId,
      identity: config.publicIdentity,
      identity_model: result.identity_model ?? null,
      lane_status: config.laneStatus ?? null,
      checked_at: new Date().toISOString(),
    };
  } catch {
    return safeFailure(
      "COMMONS_VALIDATION_UNAVAILABLE",
      "The bridge could not reach The Commons validation endpoint.",
      config.publicIdentity,
      config.residentId
    );
  }
}

// Validation is started once when the service process boots. Saving a resident
// token in Render and redeploying therefore performs the required connection
// handshake without putting the token in chat, GitHub, logs, URLs, or response
// bodies. Registration validation does not grant write authority.
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
    : [
          "TOKEN_NOT_CONFIGURED",
          "TOKEN_ENV_NOT_CONFIGURED",
          "IDENTITY_NOT_CONFIGURED",
        ].includes(result.code)
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
