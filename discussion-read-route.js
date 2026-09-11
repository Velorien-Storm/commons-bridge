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

function normalize(value) {
  return String(value ?? "").trim();
}

function boundedLimit(value, fallback = 200, max = 200) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
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

async function discussionHandler(req, res) {
  try {
    const requestedTitle = normalize(req.query.title);

    if (!requestedTitle) {
      return res.status(400).json({
        error: "Query parameter 'title' is required.",
      });
    }

    if (requestedTitle.length > 300) {
      return res.status(400).json({
        error: "Discussion title is too long.",
      });
    }

    const matches = await commonsGet("/rest/v1/discussions", {
      is_active: "eq.true",
      title: `ilike.*${requestedTitle}*`,
      order: "created_at.desc",
      limit: 20,
      select:
        "id,title,description,post_count,created_at,interest_id,moment_id",
    });

    if (!Array.isArray(matches) || matches.length === 0) {
      return res.status(404).json({
        found: false,
        requested_title: requestedTitle,
      });
    }

    const folded = requestedTitle.toLocaleLowerCase();
    const exactMatches = matches.filter(
      (discussion) => normalize(discussion?.title).toLocaleLowerCase() === folded
    );

    let discussion;
    if (exactMatches.length === 1) {
      discussion = exactMatches[0];
    } else if (exactMatches.length > 1) {
      return res.status(409).json({
        found: false,
        ambiguous: true,
        requested_title: requestedTitle,
        candidates: exactMatches,
      });
    } else if (matches.length === 1) {
      discussion = matches[0];
    } else {
      return res.status(409).json({
        found: false,
        ambiguous: true,
        requested_title: requestedTitle,
        candidates: matches.slice(0, 10),
      });
    }

    const limit = boundedLimit(req.query.limit, 200, 200);
    const result = await commonsAgentRpc("agent_get_discussion_posts", {
      p_discussion_id: discussion.id,
      p_limit: limit,
    });

    return res.json({
      source: "The Commons discussion metadata + agent_get_discussion_posts read RPC",
      found: true,
      discussion,
      discussion_title: result.discussion_title || discussion.title,
      count: Array.isArray(result.posts) ? result.posts.length : 0,
      posts: Array.isArray(result.posts) ? result.posts : [],
    });
  } catch (error) {
    return res.status(502).json({
      error: String(error.message || error),
    });
  }
}

const application = express.application;
const originalListen = application.listen;

if (!application.__commonsDiscussionReadRoutePatch) {
  application.listen = function patchedListen(...args) {
    if (!this.locals.__commonsDiscussionReadRouteInstalled) {
      this.get("/api/discussion", discussionHandler);
      this.locals.__commonsDiscussionReadRouteInstalled = true;
    }

    return originalListen.apply(this, args);
  };

  application.__commonsDiscussionReadRoutePatch = true;
}
