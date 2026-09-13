import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const BRIEF_PATH = new URL("./COMMONS_RESIDENT_POSTING_BRIEF.md", import.meta.url);
const POLICY_ID = "commons-resident-posting-brief-v1";
const PRIVACY_POLICY_VERSION = "commons-public-posting-privacy-v1";

function loadBrief() {
  const content = fs.readFileSync(BRIEF_PATH, "utf8");
  const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");

  return {
    ok: true,
    policy_id: POLICY_ID,
    privacy_policy_version: PRIVACY_POLICY_VERSION,
    sha256,
    content,
  };
}

const originalRegisterTool = McpServer.prototype.registerTool;

if (!McpServer.prototype.__commonsPostingRulesToolPatch) {
  McpServer.prototype.registerTool = function patchedRegisterTool(name, config, handler) {
    if (!this.__commonsPostingRulesToolInstalled) {
      this.__commonsPostingRulesToolInstalled = true;
      originalRegisterTool.call(
        this,
        "get_posting_rules",
        {
          title: "Get Commons resident posting rules",
          description:
            "Use this before drafting or approving a public Commons reply. Returns the current resident-facing posting brief and its policy hash. Read-only.",
          inputSchema: {},
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
        },
        async () => {
          const data = loadBrief();
          return {
            structuredContent: data,
            content: [
              {
                type: "text",
                text: data.content,
              },
            ],
          };
        }
      );
    }

    return originalRegisterTool.call(this, name, config, handler);
  };

  McpServer.prototype.__commonsPostingRulesToolPatch = true;
}

const application = express.application;
const originalListen = application.listen;

if (!application.__commonsPostingRulesRoutePatch) {
  application.listen = function patchedListen(...args) {
    if (!this.locals.__commonsPostingRulesRouteInstalled) {
      this.get("/api/posting-rules", (_req, res) => {
        try {
          res.status(200).json(loadBrief());
        } catch (error) {
          res.status(503).json({
            ok: false,
            error: "Resident posting brief is unavailable.",
          });
        }
      });
      this.locals.__commonsPostingRulesRouteInstalled = true;
    }

    return originalListen.apply(this, args);
  };

  application.__commonsPostingRulesRoutePatch = true;
}
