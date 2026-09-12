// Executes relay rpc + command-queue jobs in the viewer tab (screenshots, viewport).

import { exportToBlob, exportToSvg } from '@excalidraw/excalidraw';
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './mermaidConverter';

export interface RelayApi {
  getSceneElements(): Array<Record<string, any>>;
  getFiles?(): Record<string, any>;
  getAppState?(): Record<string, any>;
  scrollToContent?(els: any[], opts?: any): void;
  updateScene?(scene: any): void;
}

export type ApiGetter = () => RelayApi | null | undefined;
export type TokenGetter = () => string | null;
export type RepoGetter = () => { owner: string; repo: string; branch: string } | null;

export interface RelayHandle { cleanup: () => void; }

const RELAY_URL: string =
  ((import.meta as any).env?.VITE_RELAY_URL as string | undefined) ||
  'https://excalidrop.wtf403.workers.dev';

function wsUrl(repo: string): string {
  const u = new URL('/relay', RELAY_URL);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('repo', repo);
  return u.toString();
}

async function execute(method: string, args: any, getApi: ApiGetter): Promise<any> {
  const api = getApi();
  if (!api) throw new Error('Canvas not ready yet');
  if (method === 'screenshot' || method === 'export') {
    const elements = api.getSceneElements() as any;
    const files = (api.getFiles?.() || {}) as any;
    const appState = (api.getAppState?.() || {}) as any;
    const format = args?.format === 'svg' ? 'svg' : 'png';
    if (format === 'svg') {
      const svg = await exportToSvg({ elements, appState: { ...appState, exportBackground: args?.background ?? true }, files });
      return { format: 'svg', data: svg.outerHTML };
    }
    const blob = await exportToBlob({ elements, mimeType: 'image/png', quality: 0.9, appState: { ...appState, exportBackground: args?.background ?? true }, files });
    const dataUrl: string = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] || '');
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
    return { format: 'png', data: dataUrl };
  }
  if (method === 'viewport') {
    if (args?.scrollToContent) api.scrollToContent?.(api.getSceneElements(), { fitToViewport: true, animate: false });
    else if (args?.scrollToElementId) {
      const el = api.getSceneElements().find((e) => e['id'] === args.scrollToElementId);
      if (!el) throw new Error(`Element ${args.scrollToElementId} not found`);
      api.scrollToContent?.([el], { fitToViewport: false, animate: false });
    } else if (args?.zoom !== undefined || args?.offsetX !== undefined || args?.offsetY !== undefined) {
      const appState: any = {};
      if (args.zoom !== undefined) appState.zoom = { value: args.zoom };
      if (args.offsetX !== undefined) appState.scrollX = args.offsetX;
      if (args.offsetY !== undefined) appState.scrollY = args.offsetY;
      api.updateScene?.({ appState });
    }
    return { success: true, message: 'Viewport updated' };
  }
  if (method === 'mermaid') {
    const result = await convertMermaidToExcalidraw(args?.mermaidDiagram || '', args?.config || DEFAULT_MERMAID_CONFIG);
    if ((result as any).error) throw new Error(String((result as any).error));
    return { ok: true, count: (result as any).elements?.length || 0, elements: (result as any).elements || [] };
  }
  if (method === 'describe') {
    const els = api.getSceneElements();
    return { count: els.length, elements: els.slice(0, 200) };
  }
  throw new Error(`unknown method ${method}`);
}

export function connectRelay(getApi: ApiGetter, getToken: TokenGetter, getRepo: RepoGetter): RelayHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 1000;
  let fails = 0;

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let relayChecked = false;
  const open = () => {
    if (closed) return;
    const repo = getRepo();
    const token = getToken();
    if (!repo || !token) { setTimeout(open, 5000); return; }
    // One cheap probe per page load: if this deployment predates the relay
    // (or it's disabled), don't open — and fail — WebSockets at all.
    if (!relayChecked) {
      relayChecked = true;
      void (async () => {
        try {
          const r = await fetch(`${RELAY_URL}/health`, { cache: 'no-store' });
          const j = await r.json().catch(() => null);
          if (!j?.relay) return; // no relay here — queue fallback covers rpc
        } catch { return; }
        open();
      })();
      return;
    }
    // Deployed worker missing (or offline): stop hammering after 6 straight
    // failures — resume on tab refocus / reconnect instead of console spam.
    if (fails >= 6) return;
    let sock: WebSocket;
    try { sock = new WebSocket(wsUrl(`${repo.owner}/${repo.repo}`)); } catch { scheduleRetry(); return; }
    ws = sock;
    sock.onopen = () => {
      retry = 1000;
      fails = 0;
      try { sock.send(JSON.stringify({ token })); } catch {}
      // 25s heartbeat keeps the DO room + NAT mapping alive; server replies pong.
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => { try { sock.send(JSON.stringify({ type: 'ping' })); } catch {} }, 25_000);
    };
    sock.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.type !== 'relay_rpc' || !msg.reqId) return;
      void (async () => {
        try {
          const data = await execute(msg.method, msg.args || {}, getApi);
          try { sock.send(JSON.stringify({ reqId: msg.reqId, ok: true, data })); } catch {}
        } catch (e) {
          try { sock.send(JSON.stringify({ reqId: msg.reqId, ok: false, error: (e as Error).message })); } catch {}
        }
      })().catch(() => {});
    };
    const scheduleRetry = (): void => {
      fails += 1;
      ws = null;
      if (heartbeat) clearInterval(heartbeat);
      if (!closed && fails < 6) setTimeout(open, Math.min(retry *= 2, 30000));
    };
    sock.onclose = scheduleRetry;
    sock.onerror = () => { try { sock.close(); } catch {} };
  };
  const onVisible = (): void => {
    if (!closed && document.visibilityState === 'visible' && !ws) { fails = 0; retry = 1000; open(); }
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);
  open();
  return { cleanup: () => { closed = true; if (heartbeat) clearInterval(heartbeat); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onVisible); try { ws?.close(); } catch {} } };
}


async function gh(pathname: string, token: string, init?: RequestInit): Promise<any> {
  const { timedFetch } = await import('./ghSync');
  const r = await timedFetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`github ${r.status}`);
  return r.json();
}

export function startCommandQueue(getApi: ApiGetter, getToken: TokenGetter, getRepo: RepoGetter, intervalMs = 8000): RelayHandle {
  let stop = false;
  let interval = intervalMs;
  const seen = new Set<string>();
  const tick = async () => {
    if (stop) return;
    try {
      const repo = getRepo();
      const token = getToken();
      if (repo && token && getApi()) {
        const slug = `${repo.owner}/${repo.repo}`;
        // No queue ever used on this repo (404): back off to 60s instead of
        // burning API quota every 8s for the tab's whole lifetime.
        let missing = false;
        const list = await gh(`/repos/${slug}/contents/commands?ref=${repo.branch}`, token).catch((e) => {
          if (String((e as Error)?.message || '').includes('404')) missing = true;
          return null;
        });
        interval = missing ? 60_000 : intervalMs;
        const files: any[] = Array.isArray(list) ? list : [];
        for (const f of files.slice(-5)) {
          const name: string = f.name || '';
          if (!name.endsWith('.json') || seen.has(name)) continue;
          seen.add(name);
          try {
            const doc = await gh(`/repos/${slug}/contents/commands/${name}?ref=${repo.branch}`, token);
            const cmd = JSON.parse(atob(doc.content.replace(/\n/g, '')));
            const data = await execute(cmd.method, cmd.args || {}, getApi);
            const body = { message: `excalidrop: result ${cmd.reqId || name}`, content: btoa(JSON.stringify({ reqId: cmd.reqId, ok: true, ...data })), branch: repo.branch };
            await gh(`/repos/${slug}/contents/results/${name}`, token, { method: 'PUT', body: JSON.stringify(body) }).catch(() => null);
          } catch { /* one bad command must not stop the queue */ }
        }
        if (seen.size > 200) { const arr = [...seen]; arr.slice(0, 100).forEach((k) => seen.delete(k)); }
      }
    } catch { /* offline — retry next tick */ }
    if (!stop) setTimeout(tick, interval);
  };
  setTimeout(tick, 4000);
  return { cleanup: () => { stop = true; } };
}
