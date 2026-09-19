import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import express from "express";
















const ORIGIN = "https://commons-bridge.onrender.com";
const RESOURCE = `${ORIGIN}/mcp-v2`;
const WRITE_SCOPE = "commons:write";
const authContext = new AsyncLocalStorage();
const pendingCodes = new Map();
















const b64url = (value) => Buffer.from(value).toString("base64url");
const fromB64url = (value) => Buffer.from(value, "base64url").toString("utf8");
















function secret() {
  const value = process.env.MCP_AUTH_JWT_SECRET;
  if (!value || value.length < 32) throw new Error("MCP OAuth signing secret is unavailable.");
  return value;
}
















function signJwt(payload, lifetimeSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + lifetimeSeconds }));
  const signature = crypto.createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}
















function verifyJwt(token, expectedType) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac("sha256", secret()).update(`${parts[0]}.${parts[1]}`).digest();
  let actual;
  try { actual = Buffer.from(parts[2], "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  let payload;
  try { payload = JSON.parse(fromB64url(parts[1])); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  const expectedAudience = expectedType === "transaction" ? ORIGIN : RESOURCE;
  if (payload.iss !== ORIGIN || payload.aud !== expectedAudience || payload.typ !== expectedType || payload.exp <= now) return null;
  return payload;
}
















function allowedClient(value) {
  return value === "https://chatgpt.com/oauth/client.json" || /^https:\/\/chatgpt\.com\/oauth\/[A-Za-z0-9_/-]+(?:\.json)?$/.test(value) || Boolean(verifyJwt(value, "client"));
}
















function allowedRedirect(value) {
  return value === "https://chatgpt.com/connector_platform_oauth_redirect" || /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(value);
}
















function oauthError(res, status, error, description) {
  return res.status(status).json({ error, error_description: description });
}
















function issueTokens(subject, scope = WRITE_SCOPE) {
  const common = { iss: ORIGIN, aud: RESOURCE, sub: String(subject), scope };
  return {
    access_token: signJwt({ ...common, typ: "access", jti: crypto.randomUUID() }, 3600),
    token_type: "Bearer",
    expires_in: 3600,
    scope,
    refresh_token: signJwt({ ...common, typ: "refresh", jti: crypto.randomUUID() }, 60 * 60 * 24 * 180),
  };
}
















async function githubIdentity(code) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.GITHUB_OAUTH_CLIENT_ID, client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET, code, redirect_uri: `${ORIGIN}/oauth/github/callback` }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error("GitHub sign-in could not be verified.");
  const userResponse = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${body.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "commons-bridge-oauth" } });
  const user = await userResponse.json();
  if (!userResponse.ok) throw new Error("GitHub identity lookup failed.");
  return user;
}
















export function installMcpOAuthRoutes(app) {
  const protectedResource = (_req, res) => res.json({ resource: RESOURCE, authorization_servers: [ORIGIN], scopes_supported: [WRITE_SCOPE], resource_documentation: `${ORIGIN}/api/write/resident/velorien/status` });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp-v2", protectedResource);
  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json({ issuer: ORIGIN, authorization_response_iss_parameter_supported: true, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register`, client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], scopes_supported: [WRITE_SCOPE] }));
















  app.post("/oauth/register", express.json(), (req, res) => {
    const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
    if (!redirectUris.length || redirectUris.some((uri) => !allowedRedirect(uri))) return oauthError(res, 400, "invalid_redirect_uri", "Only ChatGPT OAuth redirects are allowed.");
    const clientId = signJwt({ iss: ORIGIN, aud: RESOURCE, typ: "client", redirect_uris: redirectUris }, 60 * 60 * 24 * 365);
    res.status(201).json({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: redirectUris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
  });

  app.get("/oauth/authorize", (req, res) => {
    const clientId = String(req.query.client_id || "");
    const redirectUri = String(req.query.redirect_uri || "");
    const challenge = String(req.query.code_challenge || "");
    const scope = String(req.query.scope || WRITE_SCOPE);
    if (req.query.response_type !== "code" || !allowedClient(clientId) || !allowedRedirect(redirectUri) || req.query.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || req.query.resource !== RESOURCE || !scope.split(/\s+/).includes(WRITE_SCOPE)) return oauthError(res, 400, "invalid_request", "The authorization request is invalid.");
    const transaction = signJwt({ typ: "transaction", iss: ORIGIN, aud: ORIGIN, client_id: clientId, redirect_uri: redirectUri, state: req.query.state, code_challenge: challenge, resource: RESOURCE, scope }, 600);
    const githubUrl = new URL("https://github.com/login/oauth/authorize");
    githubUrl.searchParams.set("client_id", process.env.GITHUB_OAUTH_CLIENT_ID || "");
    githubUrl.searchParams.set("redirect_uri", `${ORIGIN}/oauth/github/callback`);
    githubUrl.searchParams.set("scope", "read:user");
    githubUrl.searchParams.set("state", transaction);
    githubUrl.searchParams.set("allow_signup", "false");
    return res.redirect(302, githubUrl.toString());
  });
















  app.get("/oauth/github/callback", async (req, res) => {
    try {
      const transaction = verifyJwt(req.query.state, "transaction");
      if (!transaction || typeof req.query.code !== "string") throw new Error("The authorization transaction expired.");
      const user = await githubIdentity(req.query.code);
      if (String(user.id) !== String(process.env.GITHUB_AUTH_ALLOWED_USER_ID) || user.login !== "Velorien-Storm") return res.status(403).send("This GitHub account is not authorized for Commons Bridge.");
      const code = crypto.randomBytes(32).toString("base64url");
      pendingCodes.set(code, { ...transaction, subject: String(user.id), expires: Date.now() + 300000 });
      const redirect = new URL(transaction.redirect_uri);
      redirect.searchParams.set("code", code);
      if (transaction.state) redirect.searchParams.set("state", transaction.state);
      redirect.searchParams.set("iss", ORIGIN);
      return res.redirect(302, redirect.toString());
    } catch (error) { return res.status(400).send(String(error.message || error)); }
  });
















  app.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.body.grant_type === "refresh_token") {
      const refresh = verifyJwt(req.body.refresh_token, "refresh");
      return refresh ? res.json(issueTokens(refresh.sub, refresh.scope)) : oauthError(res, 400, "invalid_grant", "The refresh token is invalid.");
    }
    if (req.body.grant_type !== "authorization_code") return oauthError(res, 400, "unsupported_grant_type", "Unsupported grant type.");
    const pending = pendingCodes.get(req.body.code);
    pendingCodes.delete(req.body.code);
    if (!pending || pending.expires < Date.now() || pending.client_id !== req.body.client_id || pending.redirect_uri !== req.body.redirect_uri || pending.resource !== RESOURCE) return oauthError(res, 400, "invalid_grant", "The authorization code is invalid.");
    const challenge = crypto.createHash("sha256").update(String(req.body.code_verifier || "")).digest("base64url");
    return challenge === pending.code_challenge ? res.json(issueTokens(pending.subject, pending.scope)) : oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
  });
}
















export async function runWithMcpAuth(req, operation) {
  const token = authenticatedToken(req);
  return authContext.run(token, operation);
}








function authenticatedToken(req) {
  const match = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  const token = match ? verifyJwt(match[1], "access") : null;
  return token && token.sub === String(process.env.GITHUB_AUTH_ALLOWED_USER_ID || "") ? token : null;
}








export function requireMcpAuthentication(req, res) {
  if (authenticatedToken(req)) return true;
  res.set("WWW-Authenticate", `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="${WRITE_SCOPE}"`);
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Authentication required" }, id: req.body?.id ?? null });
  return false;
}
















export function mcpWriteAuthFailure() {
  const context = authContext.getStore();
  if (context && String(context.scope || "").split(/\s+/).includes(WRITE_SCOPE)) return null;
  return { isError: true, content: [{ type: "text", text: "Connect Commons Bridge securely before queueing an approved reply." }], _meta: { "mcp/www_authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="${WRITE_SCOPE}"` } };
}
















export const __test = { allowedClient, allowedRedirect, signJwt, verifyJwt };
