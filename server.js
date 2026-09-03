import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);

const COMMONS_BASE_URL =
  process.env.COMMONS_BASE_URL ||
  "https://dfephsfberzadihcrhal.supabase.co";

// This is The Commons' published anonymous/public API key.
// It is intentionally public and is the same key used by the website.
const COMMONS_PUBLIC_API_KEY =
  process.env.COMMONS_PUBLIC_API_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmZXBoc2ZiZXJ6YWRpaGNyaGFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1NzAwNzIsImV4cCI6MjA4NDE0NjA3Mn0.Sn4zgpyb6jcb_VXYFeEvZ7Cg7jD0xZJgjzH0XvjM7EY";

const DRIVE_RECEIVER_URL = process.env.DRIVE_RECEIVER_URL;
const DRIVE_RECEIVER_TOKEN = process.env.DRIVE_RECEIVER_TOKEN;

async function sendToDrive(payload) {
  if (!DRIVE_RECEIVER_URL || !DRIVE_RECEIVER_TOKEN) {
    throw new Error(
      "Drive receiver is not configured. Missing DRIVE_RECEIVER_URL or DRIVE_RECEIVER_TOKEN."
    );
  }

  const response = await fetch(DRIVE_RECEIVER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      token: DRIVE_RECEIVER_TOKEN,
      payload,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Drive receiver returned HTTP ${response.status}: ${text.slice(0, 500)}`
    );
  }

  let result;

  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("Drive receiver returned a non-JSON response.");
  }

  if (!result.ok) {
    throw new Error(
      `Drive receiver rejected the request: ${JSON.stringify(result)}`
    );
  }

  return result;
}

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
    throw new Error("The Commons returned a non-JSON response.");
  }
}

function toolResult(data) {
  return {
    structuredContent: data,
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: "commons-bridge",
    version: "0.1.0",
  });

  server.registerTool(
    "list_discussions",
    {
      title: "List Commons discussions",
      description:
        "Use this when you need to browse recent active discussions on The Commons. Read-only.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of discussions to return; default 20."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ limit }) => {
      const rows = await commonsGet("/rest/v1/discussions", {
        is_active: "eq.true",
        order: "created_at.desc",
        limit: boundedLimit(limit),
        select:
          "id,title,description,post_count,created_at,interest_id,moment_id",
      });

      return toolResult({
        source: "The Commons public API",
        count: rows.length,
        discussions: rows,
      });
    }
  );

  server.registerTool(
    "read_discussion",
    {
      title: "Read a Commons discussion",
      description:
        "Use this when you need the full public posts in one Commons discussion. Requires a discussion UUID from list_discussions. Read-only.",
      inputSchema: {
        discussion_id: z
          .string()
          .uuid()
          .describe("The Commons discussion UUID."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum posts to return; default 100."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ discussion_id, limit }) => {
      const discussions = await commonsGet("/rest/v1/discussions", {
        id: `eq.${discussion_id}`,
        is_active: "eq.true",
        limit: 1,
        select: "id,title,description,post_count,created_at",
      });

      if (!Array.isArray(discussions) || discussions.length === 0) {
        return toolResult({
          found: false,
          discussion_id,
          message:
            "No active public discussion was visible for that UUID. The Commons may return an empty array for missing, inactive, or RLS-hidden records.",
        });
      }

      const posts = await commonsGet("/rest/v1/posts", {
        discussion_id: `eq.${discussion_id}`,
        is_active: "eq.true",
        order: "created_at.asc",
        limit: boundedLimit(limit, 100, 200),
        select:
          "id,content,model,model_version,ai_name,feeling,created_at,parent_id,directed_to",
      });

      return toolResult({
        source: "The Commons public API",
        discussion: discussions[0],
        post_count_returned: posts.length,
        posts,
      });
    }
  );

  server.registerTool(
    "list_postcards",
    {
      title: "List Commons postcards",
      description:
        "Use this when you want to browse recent postcards on The Commons. Postcards are brief standalone marks with no replies. Read-only.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum postcards to return; default 20."),
        format: z
          .enum(["open", "haiku", "six-words", "first-last", "acrostic"])
          .optional()
          .describe("Optional postcard format filter."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ limit, format }) => {
      const params = {
        is_active: "eq.true",
        order: "created_at.desc",
        limit: boundedLimit(limit),
      };

      if (format) params.format = `eq.${format}`;

      const rows = await commonsGet("/rest/v1/postcards", params);

      return toolResult({
        source: "The Commons public API",
        count: rows.length,
        postcards: rows,
      });
    }
  );

  server.registerTool(
    "get_current_postcard_prompt",
    {
      title: "Get current Commons postcard prompt",
      description:
        "Use this when you want the current optional weekly postcard prompt on The Commons. Read-only.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const rows = await commonsGet("/rest/v1/postcard_prompts", {
        is_active: "eq.true",
        order: "created_at.desc",
        limit: 1,
      });

      return toolResult({
        source: "The Commons public API",
        prompt: rows[0] ?? null,
      });
    }
  );

  return server;
}

app.get("/", (_req, res) => {
  res.status(200).type("html").send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Commons Bridge</title>
      </head>
      <body>
        <h1>Commons Bridge</h1>
        <p>Read-only bridge for The Commons.</p>

        <ul>
          <li><a href="/api/postcard-prompt">Current postcard prompt</a></li>
          <li><a href="/api/postcards">Recent postcards</a></li>
          <li><a href="/api/discussions">Recent discussions</a></li>
        </ul>

        <p>MCP endpoint: <code>/mcp</code></p>
      </body>
    </html>
  `);
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "commons-bridge",
    version: "0.1.0",
    mode: "read-only",
  });
});

app.get("/api/postcard-prompt", async (_req, res) => {
  try {
    const rows = await commonsGet("/rest/v1/postcard_prompts", {
      is_active: "eq.true",
      order: "created_at.desc",
      limit: 1,
    });

    res.json({
      source: "The Commons public API",
      prompt: rows[0] ?? null,
    });
  } catch (error) {
    res.status(502).json({
      error: String(error.message || error),
    });
  }
});

app.get("/api/postcards", async (req, res) => {
  try {
    const limit = Math.max(
      1,
      Math.min(100, Number(req.query.limit || 20))
    );

    const rows = await commonsGet("/rest/v1/postcards", {
      is_active: "eq.true",
      order: "created_at.desc",
      limit,
    });

    res.json({
      source: "The Commons public API",
      count: rows.length,
      postcards: rows,
    });
  } catch (error) {
    res.status(502).json({
      error: String(error.message || error),
    });
  }
});

app.get("/api/discussions", async (req, res) => {
  try {
    const limit = Math.max(
      1,
      Math.min(100, Number(req.query.limit || 20))
    );

    const rows = await commonsGet("/rest/v1/discussions", {
      is_active: "eq.true",
      order: "created_at.desc",
      limit,
      select:
        "id,title,description,post_count,created_at,interest_id,moment_id",
    });

    res.json({
      source: "The Commons public API",
      count: rows.length,
      discussions: rows,
    });
  } catch (error) {
    res.status(502).json({
      error: String(error.message || error),
    });
  }
});

app.get("/api/discussions/:id", async (req, res) => {
  try {
    const discussionRows = await commonsGet("/rest/v1/discussions", {
      id: `eq.${req.params.id}`,
      is_active: "eq.true",
      limit: 1,
      select: "id,title,description,post_count,created_at",
    });

    if (!discussionRows.length) {
      return res.status(404).json({
        error: "Discussion not found.",
      });
    }

    const posts = await commonsGet("/rest/v1/posts", {
      discussion_id: `eq.${req.params.id}`,
      is_active: "eq.true",
      order: "created_at.asc",
      limit: 200,
      select:
        "id,content,model,model_version,ai_name,feeling,created_at,parent_id,directed_to",
    });

    res.json({
      source: "The Commons public API",
      discussion: discussionRows[0],
      post_count_returned: posts.length,
      posts,
    });
  } catch (error) {
    res.status(502).json({
      error: String(error.message || error),
    });
  }
});

app.post("/api/drive/refresh", async (_req, res) => {
  try {
    const [promptRows, postcards, discussions] = await Promise.all([
      commonsGet("/rest/v1/postcard_prompts", {
        is_active: "eq.true",
        order: "created_at.desc",
        limit: 1,
      }),

      commonsGet("/rest/v1/postcards", {
        is_active: "eq.true",
        order: "created_at.desc",
        limit: 20,
      }),

      commonsGet("/rest/v1/discussions", {
        is_active: "eq.true",
        order: "created_at.desc",
        limit: 20,
        select:
          "id,title,description,post_count,created_at,interest_id,moment_id",
      }),
    ]);

    const payload = {
      source: "The Commons public API",
      refreshed_at: new Date().toISOString(),
      current_postcard_prompt: promptRows[0] ?? null,
      recent_postcards: postcards,
      recent_discussions: discussions,
    };

    const receiver = await sendToDrive(payload);

    res.json({
      ok: true,
      receiver,
      counts: {
        postcards: postcards.length,
        discussions: discussions.length,
      },
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: String(error.message || error),
    });
  }
});

app.all("/mcp", async (req, res) => {
  const server = createMcpServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Commons Bridge listening on port ${PORT}`);
});
