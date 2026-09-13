# Plan: MCP `2026-07-28` remote — single universal URL, shared relay

## Decision locked

* Single universal endpoint: `POST https://excalidrop.wtf403.workers.dev/mcp` (custom domain later). Registered once per chat client, works for ANY deployed excalidrop canvas. No `?repo=` — repo travels per tool call.
* Stateless per spec `2026-07-28` (no `initialize`, `Mcp-Method`/`Mcp-Name` headers, `server/discover`, cacheable `tools/list`).
* Auth: reuse OAuth App `Iv23liuS2fx3QOEIoDmx` with `repo` scope (universal relay serves private canvases too via the caller's own token; per-repo access enforced by GitHub). Per-request user token, RFC 9207 `iss` validation. GitHub App deferred.
* Relay: **shared worker for all repos** with honest quota errors (`429` + self-host hint); `setup --relay self` opt-in deploys relay into user's own CF account (own 100k/day). Viewers default-WS to shared relay.
* Keep `RelayRoom` DO scoped to 4 viewer-live tools only.

## How it works (target state)

```
Agent (ChatGPT/Claude.ai/local) → POST /mcp   (one URL, once)
  ├─ tools/list, server/discover → no repo needed (catalog identical)
  ├─ canvas tools {repo, ...} → GitHub API directly (no DO)
  │    auth: Bearer user-token, per-call verifyRepoAccess(token, repo)
  │    switch_remote sets per-token default; explicit repo overrides
  └─ screenshot/viewport/export/mermaid {repo, ...}
       → RelayRoom DO idFromName('repo:'+repo) → viewer tab(s)
       └─ no tab → 503 + Tasks poll envelope (or GitHub-queue fallback)
```

## Connector setup (target UX)

* ChatGPT / Claude.ai: Add connector → paste `https://excalidrop.wtf403.workers.dev/mcp` → GitHub OAuth approve → `describe_scene {repo: "anyone/anything"}`.
* Local (Claude Code/Cursor): stdio shim unchanged; same tools over stdio.
* `npx excalidrop setup` prints the `/mcp` URL alongside the viewer URL.

## Implementation phases

### Phase 0 — groundwork (no behavior change)
1. Fix `parseRepoFlag()` (`mcp.ts:109`) to accept `--repo value` + `--repo=value` (copy `cli.ts:561` logic). ✅ done.
2. Longer auth-cache TTL: `AUTH_CACHE_MS` 60s → 10min for `pull`-only checks (`relay.js:4`), keep 60s for push. Cuts GitHub API burn ~10x — GitHub limits bite before CF limits.
3. Flush-or-block on `switch_remote` with dirty autosync timer (`mcp.ts:273,308`): `commitNow()` before switching or return `dirty:true` + require `commit_scene` first.

### Phase 1 — stateless `/mcp` on shared worker
4. `worker/src/mcp.js` (new): `POST /mcp` handler —
   * require `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method`, `Mcp-Name` headers; `server/discover` capability probe; `tools/list` with `ttlMs: 3600000, cacheScope: catalog`.
   * stateless: `repo` as required arg on every canvas tool (explicit handle the model threads back), token from `Authorization: Bearer`. `switch_remote` sets per-token default (KV TTL); explicit `repo` overrides. New `list_canvases` via `/user/repos`.
   * ~25 GitHub-backed tools implemented directly (create/update/delete/query/describe/commit/snapshot/import/export/restore/current_canvas). No DO import on this path.
   * auth: validate OAuth user token → `GET /repos/{repo}` permission check (`pull` always, `push` for mutating tools); `iss` check on OAuth exchange response. Quota/rate keys `tokenHash:repo`.
5. Viewer-live tools via Tasks extension: return `resultType: input_required` / `tasks/get` poll envelope pointing at existing `/rpc/:repo/:method` + DO; client polls. No new transport yet.
6. Quota errors (honest, actionable): shared worker returns `429 {error, quota: daily, reset: 00:00 UTC, fix: self-host relay via setup --relay self}` when approaching 100k/day (in-memory best-effort v1; KV optional). Per-token 30/min + per-IP 60/min kept (`relay.js:74`).
7. SDK upgrade: `@modelcontextprotocol/sdk` → Tier-1 version speaking `2026-07-28`; keep stdio `mcp.ts` as local shim (stdio→HTTP bridge optional). Add `/.well-known/oauth-authorization-server` (CIMD doc) for ChatGPT discovery.

### Phase 2 — optional self-host relay + viewer wiring
8. `setup --relay self|shared` (default `shared`): `self` runs `wrangler deploy worker/` into the user's account (same `wranglerAccount()` identity, user's quota). Store `relayUrl` in `.excalidrop.json`; MCP entry gets `EXCALIDROP_RELAY_URL=<relay>`. `publish` redeploys viewer + relay when `self`.
9. Viewers default-WS to shared relay (`RELAY_DEFAULT`); `self` viewers get their own relay URL injected at deploy.
10. Custom domain (later): `mcp.excalidrop.dev/mcp` route; clients re-paste URL, no protocol change.

### Phase 3 — cutover + compat
11. Keep stdio server working (Claude Code/Cursor local) — points `RELAY_URL` at shared or self-hosted relay.
12. Deprecation: legacy HTTP+SSE transport, `roots/sampling/logging` per spec — don't adopt; document 12-month window.
13. Docs: README "Remote MCP (ChatGPT)" section — paste-URL flow: `https://excalidrop.wtf403.workers.dev/mcp` + OAuth approve.

## Files touched

| File | Change |
|---|---|
| `worker/src/mcp.js` (new) | stateless route, tool handlers, Tasks envelopes |
| `worker/src/index.js:64-80` | add `/mcp` branch, route public→shared logic untouched |
| `worker/wrangler.toml` | no new bindings (KV only if quota counter needs it — optional) |
| `worker/src/relay.js` | TTL bump, quota error shape; logic otherwise frozen |
| `mcp.ts:109,273` | arg-parse fix, dirty-switch guard |
| `cli.ts` | `--relay self\|shared` flag, self-host deploy, print `/mcp` URL at setup |
| `frontend/*` (viewer) | relay URL injection (default shared), `/jobs` poll fallback unchanged |

## Open questions (answer before build)

1. Shared quota: hard fail at 100k/day with `429`, or soft-degrade (CRUD ok, viewer tools 503 first)? Recommend hard-fail with self-host hint — predictable.
2. KV for cross-isolate quota counting on shared relay — accept $0 (in-memory best-effort, per-isolate) for v1, or add KV for exactness?
