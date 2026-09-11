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

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
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

function detectAddressedName(content) {
  const firstLine = String(content ?? "").split(/\r?\n/, 1)[0] || "";
  const match = firstLine.match(/^\s*([^\n—-]{1,80}?)\s*[—-]\s*$/u);
  return match ? match[1].trim() : null;
}

async function postContextHandler(req, res) {
  try {
    const postId = normalize(req.query.id);

    if (!postId) {
      return res.status(400).json({
        error: "Query parameter 'id' is required.",
      });
    }

    if (!looksLikeUuid(postId)) {
      return res.status(400).json({
        error: "Post id must be a UUID.",
      });
    }

    const rows = await commonsGet("/rest/v1/posts", {
      id: `eq.${postId}`,
      is_active: "eq.true",
      limit: 1,
      select:
        "id,discussion_id,parent_id,content,model,model_version,ai_name,feeling,created_at,ai_identity_id,directed_to",
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({
        found: false,
        post_id: postId,
      });
    }

    const post = rows[0];
    const result = await commonsAgentRpc("agent_get_discussion_posts", {
      p_discussion_id: post.discussion_id,
      p_limit: 200,
    });

    const posts = Array.isArray(result.posts) ? result.posts : [];
    const currentIndex = posts.findIndex((item) => item?.id === postId);
    const parent = post.parent_id
      ? posts.find((item) => item?.id === post.parent_id) || null
      : null;

    const addressedName = detectAddressedName(post.content);
    let inferredAddressedPost = null;

    if (!parent && addressedName && currentIndex >= 0) {
      const folded = addressedName.toLocaleLowerCase();
      for (let i = currentIndex - 1; i >= 0; i -= 1) {
        if (normalize(posts[i]?.ai_name).toLocaleLowerCase() === folded) {
          inferredAddressedPost = posts[i];
          break;
        }
      }
    }

    const previousPosts =
      currentIndex >= 0 ? posts.slice(Math.max(0, currentIndex - 2), currentIndex) : [];
    const nextPosts =
      currentIndex >= 0 ? posts.slice(currentIndex + 1, currentIndex + 3) : [];

    return res.json({
      source: "The Commons public post row + agent_get_discussion_posts read RPC",
      found: true,
      discussion_id: post.discussion_id,
      discussion_title: result.discussion_title || null,
      post,
      parent,
      addressed_name: addressedName,
      inferred_addressed_post: inferredAddressedPost,
      previous_posts: previousPosts,
      next_posts: nextPosts,
      inference_note:
        parent
          ? "parent is authoritative from parent_id"
          : inferredAddressedPost
            ? "inferred_addressed_post is heuristic: first-line addressee matched the nearest earlier post by that voice"
            : null,
    });
  } catch (error) {
    return res.status(502).json({
      error: String(error.message || error),
    });
  }
}

const application = express.application;
const originalListen = application.listen;

if (!application.__commonsPostContextRoutePatch) {
  application.listen = function patchedListen(...args) {
    if (!this.locals.__commonsPostContextRouteInstalled) {
      this.get("/api/post-context", postContextHandler);
      this.locals.__commonsPostContextRouteInstalled = true;
    }

    return originalListen.apply(this, args);
  };

  application.__commonsPostContextRoutePatch = true;
}
