# OAuth Authorization Server for remote MCP — DONE except user steps

Worker-hosted AS is implemented, tested (30 contract tests), deployed, and
verified live + via CDP. What remains needs the repo owner in the browser.

## Verified working (CDP + live curl, remove nothing below — record)

- `POST /register` → `excc_*`/`excs_*`; `/authorize` → 302 GitHub with app id +
  worker callback; error paths (mismatch/unknown/reuse/bad PKCE) all correct.
- Perplexity: DCR 201, discovery probes, `/authorize` hit with its
  `perplexity.ai/rest/connect…` redirect; connector cards created ("New").
  Flow stops at GitHub "Invalid Redirect URI" — expected: app
  `Iv23liuS2fx3QOEIoDmx` lacks our `/oauth/callback` registration.
- Central viewer redeployed via CI (`deploy_pages`, run 34759477481):
  confirm modal GONE from production, bounce auto-completes with zero clicks,
  token stored + `/user` 200.
- excalidrop7 diagnosis: token valid, but identical contents call 404s while
  the file exists → org SSO wall on the fresh OAuth token (plus uninstalled
  Excalidrop App → read-only verdict is by design). Relay WS verified 101 +
  `relay_ready` with SSO-authorized token.

## Correction (CDP request-header inspection, excalidrop8)

- The stored `ghu_` token is a **GitHub App user token** (proof: it got 200
  on `/user/installations`, which 403s for classic OAuth tokens), NOT a stale
  or scopeless OAuth token. Empty `x-oauth-scopes` is normal for app tokens;
  no `X-GitHub-SSO` header was present either.
- Verdict `denied` + `repo-not-covered` is CORRECT: installation 161002709
  exists but does not cover `RouterPlus/excalidrop8`. No viewer bug.
- Viewer changes (this commit): paste-token panel REMOVED entirely (OAuth
  button only; exchange-less hosts get a toast, no fallback UI); denied pill
  now reads "Read-only — app not installed" + an "Install app" link
  (`github.com/apps/<slug>/installations/new`) when `repo-not-covered` /
  `app-not-installed`. Boot 401 handling (`expired` detail) already existed.

## User steps (browser, ~5 min)

- [ ] 1. Create own GitHub OAuth App (`github.com/settings/developers` →
  New OAuth App): callback URL
  `https://excalidrop.wtf403.workers.dev/oauth/callback` (+ keep existing
  viewer callbacks if you reuse one app). Then in the worker dir:
  `wrangler secret put MCP_GITHUB_CLIENT_SECRET` and set
  `MCP_GITHUB_CLIENT_ID` in `wrangler.toml` (falls back to shared `GITHUB_*`
  until then). Redeploy worker. → Perplexity "Add connector" completes.
- [ ] 2. RouterPlus SSO: org page → SSO → authorize the OAuth App used for
  login (confirms 404s on existing files disappear). Then optionally install
  the Excalidrop App on `RouterPlus/excalidrop7` for write access.
- [ ] 3. Perplexity: delete the duplicate "Excalidrop / New" card, keep one,
  click Add connector, approve at GitHub.
