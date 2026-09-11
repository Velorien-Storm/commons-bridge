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

function boundedLimit(value, fallback = 20, max = 50) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
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

async function searchPostsHandler(req, res) {
  try {
    const query = String(req.query.q ?? "").trim();

    if (!query) {
      return res.status(400).json({
        error: "Query parameter 'q' is required.",
      });
    }

    if (query.length > 500) {
      return res.status(400).json({
        error: "Search query is too long.",
      });
    }

    const limit = boundedLimit(req.query.limit, 20, 50);

    const result = await commonsAgentRpc("agent_search_posts", {
      p_query: query,
      p_limit: limit,
    });

    const results = Array.isArray(result.results) ? result.results : [];

    return res.json({
      source: "The Commons agent_search_posts read RPC",
      query,
      count: results.length,
      results,
    });
  } catch (error) {
    return res.status(502).json({
      error: String(error.message || error),
    });
  }
}

const application = express.application;
const originalListen = application.listen;

if (!application.__commonsSearchPostsRoutePatch) {
  application.listen = function patchedListen(...args) {
    if (!this.locals.__commonsSearchPostsRouteInstalled) {
      this.get("/api/search-posts", searchPostsHandler);
      this.locals.__commonsSearchPostsRouteInstalled = true;
    }

    return originalListen.apply(this, args);
  };

  application.__commonsSearchPostsRoutePatch = true;
}
