// OAuth Authorization Server contract tests (worker HTTP seam).
// Run: node worker/test/oauth.test.mjs  (fails until src/oauth.js exists)
import { createHash } from 'node:crypto';

const failures = [];
function check(cond, msg) {
  if (cond) console.log('  ok:', msg);
  else { failures.push(msg); console.log('  FAIL:', msg); }
}

// --- stub env: in-memory KV with TTL, stubbed github fetch
function makeKv() {
  const m = new Map();
  return {
    async get(k) { const e = m.get(k); if (!e || e.exp < Date.now()) return null; return e.v; },
    async put(k, v, opts = {}) { m.set(k, { v, exp: Date.now() + (opts.expirationTtl || 3600) * 1000 }); },
    async delete(k) { m.delete(k); },
  };
}
const GITHUB_CODE = 'gh_code_abc';
const GITHUB_TOKEN = 'ghu_test123';
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'https://github.com/login/oauth/access_token') {
    const body = JSON.parse(init.body);
    if (body.code === GITHUB_CODE && body.client_secret === 'TEST_SECRET') {
      return Response.json({ access_token: GITHUB_TOKEN, scope: 'repo', token_type: 'bearer' });
    }
    return Response.json({ error: 'bad_verification_code' }, { status: 200 });
  }
  throw new Error('unexpected fetch: ' + u);
};
const env = { OAUTH: makeKv(), GITHUB_CLIENT_ID: 'TEST_APP_ID', GITHUB_CLIENT_SECRET: 'TEST_SECRET' };
const HOST = 'https://relay.example.test';

const { handleOAuth } = await import('../src/oauth.js');
const call = (path, opts = {}) => handleOAuth(new Request(HOST + path, opts), env, {});

// RFC7636 example pair (independent of implementation)
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

// 1. AS metadata points at US, advertises DCR + PKCE
{
  const r = await call('/.well-known/oauth-authorization-server');
  const j = await r.json();
  check(r.status === 200, 'metadata 200');
  check(j.issuer === HOST, 'metadata issuer is worker origin');
  check(j.authorization_endpoint === HOST + '/authorize', 'metadata authorize endpoint');
  check(j.token_endpoint === HOST + '/token', 'metadata token endpoint');
  check(j.registration_endpoint === HOST + '/register', 'metadata registration endpoint (DCR)');
  check((j.code_challenge_methods_supported || []).includes('S256'), 'metadata advertises S256');
}
// 2. protected-resource doc
{
  const r = await call('/.well-known/oauth-protected-resource');
  const j = await r.json();
  check(r.status === 200, 'protected-resource 200');
  check(j.resource === HOST + '/mcp', 'protected resource is /mcp');
  check((j.authorization_servers || []).includes(HOST), 'protected resource lists our AS');
}
// 3. register validation
{
  const bad = await call('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.com/cb'] }) });
  check(bad.status === 400, 'register rejects non-https redirect');
  const ok = await call('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://app.example/cb'], client_name: 't' }) });
  const j = await ok.json();
  check(ok.status === 201 && !!j.client_id && !!j.client_secret, 'register returns client_id + client_secret');
  var CLIENT = j;
  const local = await call('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://localhost:8787/cb'] }) });
  check(local.status === 201, 'register allows http localhost');
}
// 4. authorize validation + github redirect
{
  const unknown = await call(`/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent('https://app.example/cb')}`);
  check(unknown.status === 400, 'authorize rejects unknown client');
  const mismatch = await call(`/authorize?response_type=code&client_id=${CLIENT.client_id}&redirect_uri=${encodeURIComponent('https://evil.com/cb')}&state=s1`);
  check(mismatch.status === 400, 'authorize rejects redirect mismatch');
  const ok = await call(`/authorize?response_type=code&client_id=${CLIENT.client_id}&redirect_uri=${encodeURIComponent('https://app.example/cb')}&scope=repo&state=s1&code_challenge=${CHALLENGE}&code_challenge_method=S256`);
  check(ok.status === 302, 'authorize 302s to github');
  const loc = new URL(ok.headers.get('location'));
  check(loc.hostname === 'github.com' && loc.pathname === '/login/oauth/authorize', 'authorize target is github');
  check(loc.searchParams.get('client_id') === 'TEST_APP_ID', 'authorize uses app client_id (secret stays server-side)');
  check(loc.searchParams.get('redirect_uri') === HOST + '/oauth/callback', 'authorize callback is worker endpoint');
  check(loc.searchParams.get('scope') === 'repo', 'authorize requests repo scope');
  check(!!loc.searchParams.get('state'), 'authorize carries session state');
  var SESSION = loc.searchParams.get('state');
}
// 5. callback: bad state, then happy path
{
  const bad = await call(`/oauth/callback?code=${GITHUB_CODE}&state=bogus`);
  check(bad.status === 400, 'callback rejects unknown session');
  const ok = await call(`/oauth/callback?code=${GITHUB_CODE}&state=${SESSION}`);
  check(ok.status === 302, 'callback 302s back to client');
  const loc = new URL(ok.headers.get('location'));
  check(loc.origin === 'https://app.example' && loc.pathname === '/cb', 'callback returns to registered redirect');
  check(!!loc.searchParams.get('code') && loc.searchParams.get('state') === 's1', 'callback carries code + client state');
  var CODE = loc.searchParams.get('code');
}
// 6. token: bad code, happy path with secret, single-use
{
  const bad = await call('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: 'bogus', redirect_uri: 'https://app.example/cb', client_id: CLIENT.client_id, client_secret: CLIENT.client_secret }) });
  check(bad.status === 400 && (await bad.json()).error === 'invalid_grant', 'token rejects bad code');
  const ok = await call('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: CODE, redirect_uri: 'https://app.example/cb', client_id: CLIENT.client_id, client_secret: CLIENT.client_secret }) });
  const j = await ok.json();
  check(ok.status === 200 && j.access_token === GITHUB_TOKEN && j.token_type === 'Bearer', 'token returns github user token as access_token');
  const reuse = await call('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: CODE, redirect_uri: 'https://app.example/cb', client_id: CLIENT.client_id, client_secret: CLIENT.client_secret }) });
  check(reuse.status === 400, 'code is single-use');
}
// 7. PKCE-only public client (no secret presented)
{
  const ok = await call(`/authorize?response_type=code&client_id=${CLIENT.client_id}&redirect_uri=${encodeURIComponent('https://app.example/cb')}&state=s2&code_challenge=${CHALLENGE}&code_challenge_method=S256`);
  const sid = new URL(ok.headers.get('location')).searchParams.get('state');
  const cb = await call(`/oauth/callback?code=${GITHUB_CODE}&state=${sid}`);
  const code = new URL(cb.headers.get('location')).searchParams.get('code');
  const good = await call('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://app.example/cb', client_id: CLIENT.client_id, code_verifier: VERIFIER }) });
  check(good.status === 200, 'PKCE verifier without secret succeeds');
  const ok2 = await call(`/authorize?response_type=code&client_id=${CLIENT.client_id}&redirect_uri=${encodeURIComponent('https://app.example/cb')}&state=s3&code_challenge=${CHALLENGE}&code_challenge_method=S256`);
  const sid2 = new URL(ok2.headers.get('location')).searchParams.get('state');
  const cb2 = await call(`/oauth/callback?code=${GITHUB_CODE}&state=${sid2}`);
  const code2 = new URL(cb2.headers.get('location')).searchParams.get('code');
  const wrong = await call('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, redirect_uri: 'https://app.example/cb', client_id: CLIENT.client_id, code_verifier: 'wrong' }) });
  check(wrong.status === 400, 'wrong PKCE verifier rejected');
}
// 8. wrong secret rejected
{
  const ok = await call(`/authorize?response_type=code&client_id=${CLIENT.client_id}&redirect_uri=${encodeURIComponent('https://app.example/cb')}&state=s4&code_challenge=${CHALLENGE}&code_challenge_method=S256`);
  const sid = new URL(ok.headers.get('location')).searchParams.get('state');
  const cb = await call(`/oauth/callback?code=${GITHUB_CODE}&state=${sid}`);
  const code = new URL(cb.headers.get('location')).searchParams.get('code');
  const bad = await call('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://app.example/cb', client_id: CLIENT.client_id, client_secret: 'wrong' }) });
  check(bad.status === 401, 'wrong client_secret rejected');
}

// 9. dedicated MCP app credentials override the shared viewer-app ones
{
  const env2 = { ...env, OAUTH: makeKv(), MCP_GITHUB_CLIENT_ID: 'OWN_APP', MCP_GITHUB_CLIENT_SECRET: 'OWN_SECRET' };
  const reg = await handleOAuth(new Request(HOST + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://app.example/cb'] }) }), env2, {});
  const cid = (await reg.json()).client_id;
  const auth = await handleOAuth(new Request(HOST + `/authorize?response_type=code&client_id=${cid}&redirect_uri=${encodeURIComponent('https://app.example/cb')}`), env2, {});
  const loc = new URL(auth.headers.get('location'));
  check(loc.searchParams.get('client_id') === 'OWN_APP', 'authorize prefers MCP_GITHUB_CLIENT_ID over shared id');
}

console.log(failures.length ? `\n${failures.length} FAILURES` : '\nALL GREEN');
process.exit(failures.length ? 1 : 0);
