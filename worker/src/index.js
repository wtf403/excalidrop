// Minimal OAuth code-exchange backend for the static canvas viewer.
//
// Why this exists: github.com sends no CORS headers, so a browser page can
// never call /login/oauth/access_token (or the device-flow endpoints)
// directly — and the code→token exchange needs the client secret, which must
// never ship in the viewer bundle. This worker holds the secret and swaps a
// one-time code for a token. It never sees or stores user tokens beyond the
// single exchange request.
//
// Deploy: npm i -g wrangler && wrangler login && wrangler secret put GITHUB_CLIENT_SECRET
// (plus GITHUB_CLIENT_ID / ALLOWED_REDIRECT_ORIGINS via vars in wrangler.toml)

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// Match a redirect origin against the allowlist. Entries are either exact
// origins ("https://wtf403.github.io") or wildcard suffixes ("*.github.io")
// so one shared deployment can serve every publisher's canvas without
// registering each URL. HTTPS only — plain-http origins never match.
function originAllowed(origin, allowlist) {
  if (!origin || !origin.startsWith('https://')) return false;
  let host;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    if (e.startsWith('*.')) return host === e.slice(2) || host.endsWith(e.slice(1));
    try {
      return new URL(e).origin.toLowerCase() === new URL(origin).origin.toLowerCase();
    } catch {
      return false;
    }
  });
}

export { RelayRoom } from './relay.js';

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_REDIRECT_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Empty allowlist = forbidden (fail closed). Operators opt in explicitly,
    // either with exact origins or a "*.github.io"-style suffix for shared use.
    const originOk = originAllowed(origin, allowed);
    const cors = {
      'Access-Control-Allow-Origin': originOk ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, relay: !!env.RELAY }, 200, cors);
    }
    if (url.pathname === '/relay' || url.pathname.startsWith('/rpc/')) {
      if (!env.RELAY) return json({ error: 'relay not configured (missing durable object binding)' }, 500, cors);
      const m = url.pathname.startsWith('/rpc/')
        ? url.pathname.slice('/rpc/'.length).split('/').slice(0, 2).join('/')
        : url.searchParams.get('repo');
      const repo = decodeURIComponent(m || '').split('/').slice(0, 2).join('/');
      if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) return json({ error: 'bad repo' }, 400, cors);
      const id = env.RELAY.idFromName(`repo:${repo.toLowerCase()}`);
      const stub = env.RELAY.get(id);
      const fwd = new URL(req.url);
      fwd.searchParams.set('repo', repo.toLowerCase());
      return stub.fetch(new Request(fwd.toString(), req));
    }
    if (req.method !== 'POST' || url.pathname !== '/exchange') {
      return json({ error: 'not found' }, 404, cors);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid JSON body' }, 400, cors);
    }
    const { code, redirect_uri } = body || {};
    if (!code || !redirect_uri) {
      return json({ error: 'code and redirect_uri are required' }, 400, cors);
    }
    if (allowed.length) {
      let ok = false;
      try {
        ok = originAllowed(new URL(redirect_uri).origin, allowed);
      } catch {
        ok = false;
      }
      if (!ok) return json({ error: 'redirect_uri not allowed' }, 403, cors);
    } else {
      return json({ error: 'no allowed origins configured' }, 403, cors);
    }
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return json({ error: 'worker misconfigured (client id/secret missing)' }, 500, cors);
    }

    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri,
        scope: 'repo',
      }),
    }).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (!r || !r.ok || !j?.access_token) {
      // Surface GitHub's own reason (incorrect_client_credentials,
      // bad_verification_code, redirect_uri_mismatch…): it contains no
      // secrets and is the only way to tell id/secret/URL mismatches apart.
      const detail = j?.error_description || j?.error || `github responded ${r?.status ?? 'unreachable'}`;
      try {
        console.log('exchange failed:', j?.error, r?.status);
      } catch { /* logging must never break the response */ }
      return json({ error: detail }, 400, cors);
    }
    // Deliberately returns ONLY credential fields — scope etc. are
    // discoverable by the viewer itself via the API, and the client secret
    // never leaves here. refresh_token/expires_in are forwarded when the
    // provider issues them (GitHub App user tokens expire after ~8h); the
    // viewer persists them and renews silently.
    return json(
      {
        token: j.access_token,
        ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}),
        ...(j.expires_in ? { expires_in: Number(j.expires_in) } : {}),
      },
      200,
      cors,
    );
  },
};
