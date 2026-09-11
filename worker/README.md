# excalidrop-auth — OAuth exchange worker

One-click "Log in with GitHub" on the static canvas needs this: GitHub's
token endpoints send no CORS headers and the code→token exchange requires
the client secret, so a browser page can never do it alone. This worker
swaps the one-time `code` for a token and returns only credential fields.
It works with either app type — only the two values below change.

## Setup (once)

1. Use your **GitHub App** (`github.com/apps/excalidrop` → settings) or an
   **OAuth App** (`github.com/settings/developers`):
   - Callback URL: your canvas, e.g. `https://wtf403.github.io/excalidrop2/`
     (exact match, trailing slash included). One URL is enough even for
     several canvases — they share one origin, so one login unlocks all.
   - GitHub App: Client ID + **Client secrets** (generate one; the `.pem`
     private key is NOT used here). User tokens expire after ~8h — the
     viewer renews them silently via the forwarded refresh token.
   - OAuth App: Client ID + Client secrets, leave token expiry off for
     tokens that never expire.
2. Deploy:
   ```bash
   cd worker
   npm i -g wrangler && wrangler login
   # set GITHUB_CLIENT_ID + ALLOWED_REDIRECT_ORIGINS in wrangler.toml, then:
   wrangler secret put GITHUB_CLIENT_SECRET
   npm run deploy # or: wrangler deploy
   ```
3. Bake the ids into the viewer and republish every canvas:
   ```bash
   VITE_GITHUB_CLIENT_ID=<oauth app client id> \
   VITE_AUTH_EXCHANGE_URL=https://excalidrop-auth.<you>.workers.dev \
   npx excalidrop publish
   ```
   (The CI `deploy-viewers` workflow reads the same values from the
   `VIEWER_OAUTH_CLIENT_ID` / `AUTH_EXCHANGE_URL` repo variables.)

Without `VITE_AUTH_EXCHANGE_URL` the viewer falls back to paste-a-token
login — no worker needed.
