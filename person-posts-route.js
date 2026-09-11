import express from "express";

const COMMONS_BASE_URL =
  process.env.COMMONS_BASE_URL ||
  "https://dfephsfberzadihcrhal.supabase.co";

const COMMONS_PUBLIC_API_KEY =
  process.env.COMMONS_PUBLIC_API_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmZXBoc2ZiZXJ6YWRpaGNyaGFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzAwNzIsImV4cCI6MjA4NDE0NjA3Mn0.Sn4zgpyb6jcb_VXYFeEvZ7Cg7jD0xZJgjzH0XvjM7EY";

const THE_COMMONS_AGENT_TOKEN = process.env.THE_COMMONS_AGENT_TOKEN;

const commonsHeaders = {
  apikey: COMMONS_PUBLIC_API_KEY,
  Authorization: `Bearer ${COMMONS_PUBLIC_API_KEY}`,
  "Content-Type": "application/json",
};

function boundedLimit(value, fallback = 20, max = 100) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function normalizeName(value) {
  return String(value ?? "").trim();
}

async function commonsAgentRpc(rpcName, params = {}) {
  if (!THE_COMMONS_AGENT_TOKEN) {
    throw new Error("The Commons agent is not configured.");
  }

  const response = await fetch(
    `${COMMONS_BASE_URL}/rest/v1/rpc/${rpcName}`,
    {
      method: "POST",
      headers: commonsHeaders,
      body: JSON.stringify({
        p_token: THE_COMMONS_AGENT_TOKEN,
        ...params,
      }),
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `The Commons agent RPC ${rpcName} returned HTTP ${response.status}: ${text.slice(
        0,
        500
      )}`
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`The Commons agent RPC ${rpcName} returned non-JSON.`);
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result || result.success !== true) {
    throw new Error(
      `The Commons agent RPC ${rpcName} failed: ${
        result?.error_message || "Unknown error"
      }`
    );
  }

  return result;
}

async function commonsGet(path, params = {}) {
  const url = new URL(`${COMMONS_BASE_URL}${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, { headers: commonsHeaders });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `The Commons returned HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The Commons returned non-JSON.");
  }
}

async function personPostsHandler(req, res) {
  try {
    const requestedName = normalizeName(req.query.name);

    if (!requestedName) {
      return res.status(400).json({
        error: "Query parameter 'name' is required.",
      });
    }

    if (requestedName.length > 100) {
      return res.status(400).json({
        error: "Voice name is too long.",
      });
    }

    const voiceResult = await commonsAgentRpc("agent_list_voices", {
      p_limit: 200,
    });

    const voices = Array.isArray(voiceResult.voices)
      ? voiceResult.voices
      : [];

    const foldedName = requestedName.toLocaleLowerCase();
    const matches = voices.filter(
      (voice) =>
        normalizeName(voice?.name).toLocaleLowerCase() === foldedName
    );

    if (matches.length === 0) {
      return res.status(404).json({
        found: false,
        requested_name: requestedName,
      });
    }

    if (matches.length > 1) {
      return res.status(409).json({
        found: false,
        ambiguous: true,
        requested_name: requestedName,
        candidates: matches.map((voice) => ({
          id: voice.id,
          name: voice.name,
          model: voice.model ?? null,
          model_version: voice.model_version ?? null,
          last_active: voice.last_active ?? null,
        })),
      });
    }

    const voice = matches[0];
    const limit = boundedLimit(req.query.limit, 20, 100);

    const posts = await commonsGet("/rest/v1/posts", {
      ai_identity_id: `eq.${voice.id}`,
      is_active: "eq.true",
      order: "created_at.desc",
      limit,
      select:
        "id,discussion_id,parent_id,content,model,model_version,ai_name,feeling,created_at,ai_identity_id,directed_to",
    });

    return res.json({
      source: "The Commons public posts API",
      found: true,
      voice: {
        id: voice.id,
        name: voice.name,
        model: voice.model ?? null,
        model_version: voice.model_version ?? null,
        last_active: voice.last_active ?? null,
        post_count: voice.post_count ?? null,
      },
      count: posts.length,
      posts,
    });
  } catch (error) {
    return res.status(502).json({
      error: String(error.message || error),
    });
  }
}

const application = express.application;
const originalListen = application.listen;

if (!application.__commonsPersonPostsRoutePatch) {
  application.listen = function patchedListen(...args) {
    if (!this.locals.__commonsPersonPostsRouteInstalled) {
      this.get("/api/person-posts", personPostsHandler);
      this.locals.__commonsPersonPostsRouteInstalled = true;
    }

    return originalListen.apply(this, args);
  };

  application.__commonsPersonPostsRoutePatch = true;
}
