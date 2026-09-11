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

## Shared model (every publisher, zero config)

The package defaults point at one shared deployment, so any repo's canvas
gets one-click login out of the box:

- App callback URLs: `https://github.io` **with wildcard matching on** —
  per GitHub's rules this covers `https://<anyone>.github.io/<any-repo>/`.
  Exact per-canvas URLs also work (up to 10); `redirect_uri` selects.
- `ALLOWED_REDIRECT_ORIGINS = "*.github.io"` (this repo's default).
- Viewers ship `VITE_GITHUB_CLIENT_ID` + `VITE_AUTH_EXCHANGE_URL` defaults;
  publishers override both at publish time for self-hosting
  (`VITE_AUTH_EXCHANGE_URL=off` restores paste-only login).

Trust note: with the shared **GitHub App**, tokens only ever reach repos
where the app is installed, with its configured permissions — the worker
cannot mint access to anything else. A shared OAuth App would instead ask
every user for `repo` scope over all their repos; don't do that.
