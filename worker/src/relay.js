// One instance per repo. Verifies the caller's GitHub token per request (cached
// ~60s by hash); holds viewer sockets + pending rpc ≤30s. Nothing is persisted.

const AUTH_CACHE_MS = 60_000;
const RPC_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const authCache = new Map();

function hashToken(t) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

const rate = new Map();
function rateOk(key, limit, windowMs) {
  const now = Date.now();
  const cur = rate.get(key);
  if (!cur || now > cur.reset) { rate.set(key, { count: 1, reset: now + windowMs }); return true; }
  cur.count += 1;
  return cur.count <= limit;
}

async function verifyRepoAccess(token, repo, needPush) {
  const key = `${hashToken(token)}:${repo}`;
  const cached = authCache.get(key);
  if (cached && Date.now() - cached.at < AUTH_CACHE_MS) {
    if (needPush && !cached.push) return { ok: false, status: 403 };
    if (!cached.pull) return { ok: false, status: 403 };
    return { ok: true, login: cached.login };
  }
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'excalidrop-relay' };
  const r = await fetch(`https://api.github.com/repos/${repo}`, { headers }).catch(() => null);
  if (!r || r.status === 404) return { ok: false, status: 404 };
  if (r.status === 401) return { ok: false, status: 403 };
  if (!r.ok) return { ok: false, status: 403 };
  const j = await r.json().catch(() => ({}));
  const pull = !!(j.permissions?.pull ?? true);
  const push = !!j.permissions?.push;
  if (!pull || (needPush && !push)) return { ok: false, status: 403 };
  const me = await fetch('https://api.github.com/user', { headers }).then((x) => x.json()).catch(() => ({}));
  authCache.set(key, { at: Date.now(), login: me.login || '?', pull, push });
  return { ok: true, login: me.login || '?' };
}

export class RelayRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.viewers = new Set();
    this.pending = new Map(); // reqId -> { resolve, timer }
  }

  async fetch(req) {
    const url = new URL(req.url);
    const repo = url.searchParams.get('repo') || '';
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) {
      return new Response(JSON.stringify({ error: 'bad repo' }), { status: 400 });
    }
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';

    if (req.headers.get('Upgrade') === 'websocket') {
      if (!rateOk(`ws:${ip}`, 20, 60_000)) return new Response('rate limited', { status: 429 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleViewer(server, repo);
      return new Response(null, { status: 101, webSocket: client });
    }

    const noStore = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    if (req.method === 'POST') {
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!token) return new Response(JSON.stringify({ error: 'missing bearer' }), { status: 401, headers: noStore });
      if (!rateOk(`rpc:${hashToken(token)}`, 30, 60_000) || !rateOk(`rpcip:${ip}`, 60, 60_000)) {
        return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429, headers: noStore });
      }
      const len = Number(req.headers.get('content-length') || 0);
      if (len > MAX_BODY_BYTES) return new Response(JSON.stringify({ error: 'too large' }), { status: 413, headers: noStore });
      let body;
      try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: noStore }); }
      const method = body.method || url.pathname.split('/').pop();
      const needPush = method !== 'screenshot' && method !== 'viewport' && method !== 'export' && method !== 'describe';
      const v = await verifyRepoAccess(token, repo, needPush);
      const noStore = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (!v.ok) return new Response(JSON.stringify({ error: v.status === 404 ? 'repo not found' : 'no access to this repo with this token' }), { status: v.status, headers: noStore });
      if (this.viewers.size === 0) return new Response(JSON.stringify({ error: 'no viewer connected — open the canvas URL in a browser first' }), { status: 503, headers: noStore });
      const reqId = body.reqId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const msg = JSON.stringify({ type: 'relay_rpc', reqId, method, args: body.args || {} });
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(reqId); resolve({ error: 'viewer timed out' }); }, RPC_TIMEOUT_MS);
        this.pending.set(reqId, { resolve, timer });
        for (const ws of this.viewers) { try { ws.send(msg); } catch { /* drop */ } }
      });
      if (result?.error) return new Response(JSON.stringify(result), { status: 504, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }

    return new Response(JSON.stringify({ repo, viewers: this.viewers.size }), { headers: { 'Content-Type': 'application/json' } });
  }

  handleViewer(ws, repo) {
    ws.accept();
    let authed = false;
    ws.addEventListener('message', async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch {} return; }
      if (!authed) {
        const v = msg?.token ? await verifyRepoAccess(msg.token, repo, false) : { ok: false };
        if (!v.ok) { try { ws.send(JSON.stringify({ error: 'auth failed' })); } catch {} ws.close(4403, 'auth'); return; }
        authed = true;
        this.viewers.add(ws);
        try { ws.send(JSON.stringify({ type: 'relay_ready', repo })); } catch {}
        return;
      }
      if (msg?.reqId && this.pending.has(msg.reqId)) {
        const p = this.pending.get(msg.reqId);
        this.pending.delete(msg.reqId);
        clearTimeout(p.timer);
        p.resolve(msg.ok === false ? { error: msg.error || 'viewer error' } : (msg.data ?? msg.result ?? { ok: true }));
      }
    });
    ws.addEventListener('close', () => { this.viewers.delete(ws); });
    ws.addEventListener('error', () => { this.viewers.delete(ws); });
  }
}
