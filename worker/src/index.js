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

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_REDIRECT_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': !allowed.length || allowed.includes(origin) ? origin || '*' : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true }, 200, cors);
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
        ok = allowed.includes(new URL(redirect_uri).origin);
      } catch {
        ok = false;
      }
      if (!ok) return json({ error: 'redirect_uri not allowed' }, 403, cors);
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
      }),
    }).catch(() => null);
    if (!r || !r.ok) return json({ error: 'github exchange failed' }, 502, cors);
    const j = await r.json().catch(() => null);
    if (!j || !j.access_token) {
      return json({ error: (j && (j.error_description || j.error)) || 'exchange failed' }, 400, cors);
    }
    // Deliberately returns ONLY the token — scope etc. are discoverable by
    // the viewer itself via the API, and nothing secret ever leaves here.
    return json({ token: j.access_token }, 200, cors);
  },
};
