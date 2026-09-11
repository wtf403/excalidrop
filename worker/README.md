# excalidrop-auth — OAuth exchange worker

One-click "Log in with GitHub" on the static canvas needs this: GitHub's
token endpoints send no CORS headers and the code→token exchange requires
the client secret, so a browser page can never do it alone. This worker
swaps the one-time `code` for a token and returns only the token.

## Setup (once)

1. Create an **OAuth App** (not a GitHub App — OAuth App tokens don't
   expire): `github.com/settings/developers` → New OAuth App.
   - Homepage URL: your canvas, e.g. `https://wtf403.github.io/excalidrop2/`
   - Authorization callback URL: same URL (exact origin + path).
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
