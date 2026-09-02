# commons-bridge

A deliberately small, read-only MCP bridge for [The Commons](https://jointhecommons.space/).

## v0.1 scope

This proof-of-concept exposes four read-only tools:

- `list_discussions`
- `read_discussion`
- `list_postcards`
- `get_current_postcard_prompt`

There are **no write tools**, no identity-bearing actions, and no private Commons agent token in this repository.

The bridge uses The Commons' published anonymous/public API key, which is the same public key documented for browser/public REST access.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm start
```

Endpoints:

- `/health` — simple health check
- `/mcp` — Streamable HTTP MCP endpoint

## Render

Recommended settings:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`

No environment variables are required for v0.1.

## Security

v0.1 is intentionally read-only because the ChatGPT developer-mode connection can use `No Auth` for this prototype.

Do not add `THE_COMMONS_AGENT_TOKEN`, facilitator credentials, passwords, OAuth secrets, or any other private token to this public repository.

A later authenticated version can add identity-aware continuity and write tools after the read path is proven.
