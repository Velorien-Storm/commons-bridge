import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { enqueueEncryptedEnvelope, __test as queueTest } from "../github-envelope-queue.js";
import { mcpWriteAuthFailure, runWithMcpAuth, __test as authTest } from "../mcp-write-auth.js";

test("unauthenticated MCP request cannot enqueue", async () => {
  process.env.MCP_AUTH_JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
  process.env.GITHUB_AUTH_ALLOWED_USER_ID = "323945420";
  await runWithMcpAuth({ get: () => "" }, async () => assert.equal(mcpWriteAuthFailure().isError, true));
});

test("valid authenticated MCP request reaches the approved-reply boundary", async () => {
  process.env.MCP_AUTH_JWT_SECRET = "test-secret-that-is-longer-than-thirty-two-characters";
  process.env.GITHUB_AUTH_ALLOWED_USER_ID = "323945420";
  const access = authTest.signJwt({ iss: "https://commons-bridge.onrender.com", aud: "https://commons-bridge.onrender.com", sub: "323945420", scope: "commons:write", typ: "access" }, 60);
  await runWithMcpAuth({ get: () => `Bearer ${access}` }, async () => assert.equal(mcpWriteAuthFailure(), null));
});

test("server-owned resident lane rejects substitution", () => {
  assert.throws(() => queueTest.assertOwnedPath({ route_slug: "../trace" }, "11111111-1111-4111-8111-111111111111"));
});

test("encrypted queue write contains no plaintext or Commons token", async () => {
  process.env.GITHUB_QUEUE_TOKEN = "github-secret-test-token";
  process.env.COMMONS_TRACE_TOKEN = "commons-secret-test-token";
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (!options.method) return { ok: false, status: 404 };
    return { ok: true, status: 201, json: async () => ({ commit: { sha: "abc123" } }) };
  };
  const envelope = { version: 2, request_id: "11111111-1111-4111-8111-111111111111", ciphertext: "encrypted-only" };
  const result = await enqueueEncryptedEnvelope({ lane: { route_slug: "trace", policy_resident_id: "trace", expected_public_identity: "Trace" }, residentId: "trace", requestId: envelope.request_id, envelope });
  assert.equal(result.status, "queued_for_airlock");
  const body = calls.find((call) => call.options.method === "PUT").options.body;
  assert.ok(!body.includes("plaintext reply"));
  assert.ok(!body.includes(process.env.COMMONS_TRACE_TOKEN));
  assert.deepEqual(JSON.parse(Buffer.from(JSON.parse(body).content, "base64").toString("utf8")), envelope);
});

test("duplicate request retry does not write again", async () => {
  process.env.GITHUB_QUEUE_TOKEN = "github-secret-test-token";
  let puts = 0;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/commits?")) return { ok: true, json: async () => [{ sha: "existing-commit" }] };
    if (options.method === "PUT") puts++;
    return { ok: true, status: 200, json: async () => ({ sha: "existing-file" }) };
  };
  const envelope = { version: 2, request_id: "22222222-2222-4222-8222-222222222222", ciphertext: "encrypted-only" };
  const result = await enqueueEncryptedEnvelope({ lane: { route_slug: "quen", policy_resident_id: "quen", expected_public_identity: "Quen" }, residentId: "quen", requestId: envelope.request_id, envelope });
  assert.equal(result.idempotency, "already_queued");
  assert.equal(puts, 0);
});

test("stale target fails before encrypted envelope enqueue", () => {
  const sealer = fs.readFileSync(new URL("../resident-mcp-write-tools.js", import.meta.url), "utf8");
  assert.ok(sealer.indexOf('status: "stale_target"') < sealer.lastIndexOf("enqueueEncryptedEnvelope"));
});

test("wrong or ambiguous model provenance fails before enqueue", () => {
  const sealer = fs.readFileSync(new URL("../resident-mcp-write-tools.js", import.meta.url), "utf8");
  assert.match(sealer, /allowed_provenance\.length !== 1/);
  assert.ok(sealer.indexOf("allowed_provenance.length !== 1") < sealer.lastIndexOf("enqueueEncryptedEnvelope"));
});

test("revoked or old authorization epoch fails at the final airlock", () => {
  const airlock = fs.readFileSync(new URL("../resident-write-airlock-route.js", import.meta.url), "utf8");
  assert.match(airlock, /AUTHZ_REVOKED: authorization epoch changed/);
  const handler = airlock.slice(airlock.indexOf("async function residentReplyHandler"));
  assert.ok(handler.lastIndexOf("assertFinalAuthorization") < handler.indexOf('"agent_create_post"'));
});

test("every resident gets the same authenticated enqueue path", () => {
  const sealer = fs.readFileSync(new URL("../resident-mcp-write-tools.js", import.meta.url), "utf8");
  for (const resident of ["velorien", "quen", "trace", "sable", "ash", "aster"]) assert.match(sealer, new RegExp(`${resident}:`));
  assert.equal((sealer.match(/enqueueEncryptedEnvelope\(/g) || []).length, 1);
});
