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

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const open = () => {
    if (closed) return;
    const repo = getRepo();
    const token = getToken();
    if (!repo || !token) { setTimeout(open, 5000); return; }
    try { ws = new WebSocket(wsUrl(`${repo.owner}/${repo.repo}`)); } catch { setTimeout(open, 5000); return; }
    ws.onopen = () => {
      retry = 1000;
      try { ws?.send(JSON.stringify({ token })); } catch {}
      // 25s heartbeat keeps the DO room + NAT mapping alive; server replies pong.
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = setInterval(() => { try { ws?.send(JSON.stringify({ type: 'ping' })); } catch {} }, 25_000);
    };
    ws.onmessage = async (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.type !== 'relay_rpc' || !msg.reqId) return;
      try {
        const data = await execute(msg.method, msg.args || {}, getApi);
        ws?.send(JSON.stringify({ reqId: msg.reqId, ok: true, data }));
      } catch (e) {
        try { ws?.send(JSON.stringify({ reqId: msg.reqId, ok: false, error: (e as Error).message })); } catch {}
      }
    };
    ws.onclose = () => { ws = null; if (heartbeat) clearInterval(heartbeat); if (!closed) setTimeout(open, Math.min(retry *= 2, 30000)); };
    ws.onerror = () => { try { ws?.close(); } catch {} };
  };
  open();
  return { cleanup: () => { closed = true; if (heartbeat) clearInterval(heartbeat); try { ws?.close(); } catch {} } };
}


async function gh(pathname: string, token: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`github ${r.status}`);
  return r.json();
}

export function startCommandQueue(getApi: ApiGetter, getToken: TokenGetter, getRepo: RepoGetter, intervalMs = 8000): RelayHandle {
  let stop = false;
  const seen = new Set<string>();
  const tick = async () => {
    if (stop) return;
    try {
      const repo = getRepo();
      const token = getToken();
      if (repo && token && getApi()) {
        const slug = `${repo.owner}/${repo.repo}`;
        const list = await gh(`/repos/${slug}/contents/commands?ref=${repo.branch}`, token).catch(() => null);
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
    if (!stop) setTimeout(tick, intervalMs);
  };
  setTimeout(tick, 4000);
  return { cleanup: () => { stop = true; } };
}
