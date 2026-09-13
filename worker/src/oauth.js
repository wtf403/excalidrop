// OAuth Authorization Server for remote MCP clients (spec 2026-07-28,
// RFC 7591 DCR + RFC 7636 PKCE). The worker fronts the GitHub OAuth App:
// clients register with US, users log in at github.com, and /token hands
// back the GitHub user token as the access token. The app secret never
// leaves the worker. Viewer /exchange flow is untouched.
//
// State lives in the OAUTH KV binding (fail closed when missing):
//   oauth:client:{id}   {secret, redirect_uris[], name}            90d
//   oauth:session:{sid}  {client_id, redirect_uri, scope, challenge, client_state}  10min
//   oauth:code:{code}    {client_id, redirect_uri, scope, github_token, challenge}  5min, single-use

// App credentials for the AS flow. Prefer dedicated MCP_* vars (your own
// GitHub OAuth App, where you register /oauth/callback); fall back to the
// shared viewer-app vars.
function appCreds(env) {
  return {
    id: env.MCP_GITHUB_CLIENT_ID || env.GITHUB_CLIENT_ID,
    secret: env.MCP_GITHUB_CLIENT_SECRET || env.GITHUB_CLIENT_SECRET,
  };
}
//   oauth:client:{id}   {secret, redirect_uris[], name}            90d
//   oauth:session:{sid}  {client_id, redirect_uri, scope, challenge, client_state}  10min
//   oauth:code:{code}    {client_id, redirect_uri, scope, github_token, challenge}  5min, single-use

function rnd(prefix, bytes = 24) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return prefix + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256B64url(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  let bin = '';
  for (const x of new Uint8Array(d)) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function err(status, error, description, cors) {
  return new Response(JSON.stringify({ error, ...(description ? { error_description: description } : {}) }), {
    status, headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// https anywhere; http only for loopback (RFC 8252 §7.3).
function redirectAllowed(u) {
  let p;
  try { p = new URL(u); } catch { return false; }
  if (p.protocol === 'https:') return true;
  if (p.protocol === 'http:') return p.hostname === 'localhost' || p.hostname === '127.0.0.1' || p.hostname === '[::1]';
  return false;
}

function clientAuth(req, params) {
  // client_secret_basic or client_secret_post (RFC 6749 §2.3).
  const h = req.headers.get('Authorization') || '';
  const m = /^Basic\s+(.+)$/i.exec(h);
  if (m) {
    try {
      const [id, secret] = atob(m[1]).split(':');
      return { id: id || params.client_id, secret };
    } catch { /* fall through */ }
  }
  return { id: params.client_id, secret: params.client_secret };
}

export async function handleOAuth(req, env, cors) {
  const url = new URL(req.url);
  const origin = url.origin;
  const kv = env.OAUTH;

  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
    return new Response(JSON.stringify({
      issuer: origin,
      authorization_endpoint: origin + '/authorize',
      token_endpoint: origin + '/token',
      registration_endpoint: origin + '/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_modes_supported: ['query'],
      scopes_supported: ['repo'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256', 'plain'],
    }), { headers: { 'Content-Type': 'application/json', ...cors } });
  }

  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
    return new Response(JSON.stringify({
      resource: origin + '/mcp',
      authorization_servers: [origin],
      scopes_supported: ['repo'],
      bearer_methods_supported: ['header'],
    }), { headers: { 'Content-Type': 'application/json', ...cors } });
  }

  if (!kv) return err(500, 'server_error', 'oauth store not configured on this deployment', cors);

  // ---- RFC 7591 Dynamic Client Registration
  if (url.pathname === '/register') {
    if (req.method !== 'POST') return err(405, 'invalid_request', 'use POST', cors);
    let body;
    try { body = await req.json(); } catch { return err(400, 'invalid_request', 'bad json', cors); }
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string' && redirectAllowed(u))) {
      return err(400, 'invalid_redirect_uri', 'redirect_uris must be non-empty; https required (http allowed for localhost only)', cors);
    }
    const client_id = rnd('excc_');
    const client_secret = rnd('excs_', 32);
    await kv.put(`oauth:client:${client_id}`, JSON.stringify({ secret: client_secret, redirect_uris: uris, name: String(body.client_name || '').slice(0, 100), created: Date.now() }), { expirationTtl: 90 * 86400 });
    return new Response(JSON.stringify({
      client_id, client_secret, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'client_secret_post',
    }), { status: 201, headers: { 'Content-Type': 'application/json', ...cors } });
  }

  // ---- Authorize: validate, stash session, bounce to GitHub
  if (url.pathname === '/authorize') {
    if (req.method !== 'GET') return err(405, 'invalid_request', 'use GET', cors);
    const q = url.searchParams;
    if (q.get('response_type') !== 'code') return err(400, 'unsupported_response_type', 'only code is supported', cors);
    const rawClient = await kv.get(`oauth:client:${q.get('client_id') || ''}`);
    if (!rawClient) return err(400, 'invalid_request', 'unknown client_id (register at POST /register first)', cors);
    const client = JSON.parse(rawClient);
    const redirect_uri = q.get('redirect_uri') || '';
    if (!client.redirect_uris.includes(redirect_uri)) return err(400, 'invalid_request', 'redirect_uri mismatch (must exactly match a registered URI)', cors);
    const app = appCreds(env);
    if (!app.id || !app.secret) return err(500, 'server_error', 'github app not configured', cors);
    const method = q.get('code_challenge_method') || 'plain';
    if (q.get('code_challenge') && method !== 'S256' && method !== 'plain') return err(400, 'invalid_request', 'code_challenge_method must be S256 or plain', cors);
    const sid = rnd('excsess_');
    await kv.put(`oauth:session:${sid}`, JSON.stringify({
      client_id: q.get('client_id'), redirect_uri,
      scope: String(q.get('scope') || 'repo').slice(0, 200),
      challenge: q.get('code_challenge') || null, challenge_method: method,
      client_state: q.get('state') || '',
    }), { expirationTtl: 600 });
    const gh = new URL('https://github.com/login/oauth/authorize');
    gh.searchParams.set('client_id', app.id);
    gh.searchParams.set('redirect_uri', origin + '/oauth/callback');
    gh.searchParams.set('scope', 'repo');
    gh.searchParams.set('state', sid);
    return new Response(null, { status: 302, headers: { Location: gh.toString(), ...cors } });
  }

  // ---- Callback from GitHub: swap code, mint our code, return to client
  if (url.pathname === '/oauth/callback') {
    if (req.method !== 'GET') return err(405, 'invalid_request', 'use GET', cors);
    const q = url.searchParams;
    const rawSess = q.get('state') ? await kv.get(`oauth:session:${q.get('state')}`) : null;
    if (!rawSess || !q.get('code')) return err(400, 'invalid_request', 'unknown or expired session (restart login)', cors);
    const sess = JSON.parse(rawSess);
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: appCreds(env).id, client_secret: appCreds(env).secret,
        code: q.get('code'), redirect_uri: origin + '/oauth/callback',
      }),
    }).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (!r || !r.ok || !j?.access_token) {
      return err(400, 'access_denied', j?.error_description || j?.error || 'github exchange failed', cors);
    }
    const code = rnd('excode_');
    await kv.put(`oauth:code:${code}`, JSON.stringify({
      client_id: sess.client_id, redirect_uri: sess.redirect_uri, scope: 'repo',
      github_token: j.access_token, challenge: sess.challenge, challenge_method: sess.challenge_method,
    }), { expirationTtl: 300 });
    await kv.delete(`oauth:session:${q.get('state')}`);
    const back = new URL(sess.redirect_uri);
    back.searchParams.set('code', code);
    if (sess.client_state) back.searchParams.set('state', sess.client_state);
    return new Response(null, { status: 302, headers: { Location: back.toString(), ...cors } });
  }

  // ---- Token endpoint
  if (url.pathname === '/token') {
    if (req.method !== 'POST') return err(405, 'invalid_request', 'use POST', cors);
    const ct = req.headers.get('Content-Type') || '';
    let params = {};
    try {
      if (ct.includes('application/json')) params = await req.json();
      else params = Object.fromEntries(new URLSearchParams(await req.text()));
    } catch { return err(400, 'invalid_request', 'bad body', cors); }
    if (params.grant_type === 'refresh_token') {
      return err(400, 'unsupported_grant_type', 'tokens do not expire; re-authorize if needed', cors);
    }
    if (params.grant_type !== 'authorization_code') return err(400, 'unsupported_grant_type', 'only authorization_code is supported', cors);
    const rawCode = params.code ? await kv.get(`oauth:code:${params.code}`) : null;
    if (!rawCode) return err(400, 'invalid_grant', 'unknown or expired code', cors);
    const rec = JSON.parse(rawCode);
    const { id, secret } = clientAuth(req, params);
    if (!id || id !== rec.client_id) return err(401, 'invalid_client', 'client mismatch', cors);
    if (params.redirect_uri && params.redirect_uri !== rec.redirect_uri) return err(400, 'invalid_grant', 'redirect_uri mismatch', cors);
    const rawClient = await kv.get(`oauth:client:${id}`);
    const client = rawClient ? JSON.parse(rawClient) : null;
    if (!client) return err(401, 'invalid_client', 'unknown client', cors);
    if (secret !== undefined && secret !== null && secret !== '') {
      if (secret !== client.secret) return err(401, 'invalid_client', 'bad client_secret', cors);
    } else if (rec.challenge) {
      const verifier = params.code_verifier || '';
      const ok = rec.challenge_method === 'plain'
        ? verifier === rec.challenge
        : verifier && (await sha256B64url(verifier)) === rec.challenge;
      if (!ok) return err(400, 'invalid_grant', 'PKCE verification failed', cors);
    } else {
      return err(401, 'invalid_client', 'client authentication required (secret or PKCE)', cors);
    }
    await kv.delete(`oauth:code:${params.code}`);
    return new Response(JSON.stringify({
      access_token: rec.github_token, token_type: 'Bearer', scope: 'repo',
    }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', ...cors } });
  }

  return err(404, 'not_found', 'unknown oauth route', cors);
}
