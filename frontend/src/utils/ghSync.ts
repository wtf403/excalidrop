

export interface RepoRef { owner: string; repo: string; branch: string }

export function detectRepo(): RepoRef | null {
  const explicit = (import.meta as any).env?.VITE_REPO_SLUG as string | undefined;
  if (explicit?.includes('/')) {
    const [owner, repo] = explicit.split('/');
    return { owner, repo, branch: 'gh-pages' };
  }
  const host = window.location.hostname; // <owner>.github.io
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (host.endsWith('.github.io') && parts.length > 0) {
    return { owner: host.slice(0, -'.github.io'.length), repo: parts[0], branch: 'gh-pages' };
  }
  return null;
}

const TOKEN_KEY = 'excalidrop_gh_token';

export function getToken(): string | null {

  if (window.location.hash.startsWith('#token=')) {
    const t = decodeURIComponent(window.location.hash.slice('#token='.length));
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
      history.replaceState(null, '', window.location.pathname + window.location.search);
      return t;
    }
  }
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function gh(path: string, token: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}


export async function pushScene(
  ref: RepoRef, token: string, scene: { elements: unknown[]; files?: Record<string, unknown> },
): Promise<string> {
  const path = 'canvas.excalidraw';
  let sha: string | undefined;
  try {
    const cur = await gh(`/repos/${ref.owner}/${ref.repo}/contents/${path}?ref=${ref.branch}`, token);
    sha = cur.sha;
  } catch {}
  const body: any = {
    message: `excalidrop: autosync ${scene.elements.length} elements`,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(
      { type: 'excalidraw', version: 2, source: 'excalidrop', elements: scene.elements },
      null, 2,
    )))),
    branch: ref.branch,
  };
  if (sha) body.sha = sha;
  const out = await gh(`/repos/${ref.owner}/${ref.repo}/contents/${path}`, token, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return out.content.sha as string;
}


export async function loadStaticScene(): Promise<{ elements: any[]; files?: Record<string, unknown> }> {
  const r = await fetch('./canvas.excalidraw', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`scene fetch ${r.status}`);
  const j = await r.json();
  return { elements: j.elements || [], files: j.files || {} };
}


export async function startDeviceFlow(clientId: string): Promise<{ user_code: string; verification_uri: string }> {
  const r = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!r.ok) throw new Error('device flow start failed');
  const j = await r.json();
  return { user_code: j.user_code, verification_uri: j.verification_uri };
}

export interface DeviceFlowSession {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;

  expires_at: number;
}

const FLOW_KEY = 'excalidrop_device_flow';


export async function startDeviceFlowFull(clientId: string): Promise<DeviceFlowSession> {
  const r = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!r.ok) throw new Error('device flow start failed');
  const j = await r.json();
  return {
    device_code: j.device_code as string,
    user_code: j.user_code as string,
    verification_uri: (j.verification_uri as string) || 'https://github.com/login/device',
    interval: Number(j.interval) || 5,
    expires_at: Date.now() + (Number(j.expires_in) || 900) * 1000,
  };
}


export async function pollDeviceToken(
  clientId: string,
  session: Pick<DeviceFlowSession, 'device_code' | 'interval' | 'expires_at'>,
  signal?: AbortSignal,
): Promise<string> {
  let interval = session.interval;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Login cancelled', 'AbortError');
    if (Date.now() >= session.expires_at) throw new Error('Login code expired — please try again.');
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (signal?.aborted) throw new DOMException('Login cancelled', 'AbortError');
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: session.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    if (!r.ok) throw new Error('Login polling failed');
    const j = await r.json();
    if (j.access_token) return j.access_token as string;
    if (j.error === 'authorization_pending') continue;
    if (j.error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (j.error) throw new Error(j.error_description || j.error);
  }
}

export function saveFlowSession(s: DeviceFlowSession | null): void {
  try {
    if (s) sessionStorage.setItem(FLOW_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(FLOW_KEY);
  } catch {

  }
}

export function loadFlowSession(): DeviceFlowSession | null {
  try {
    const raw = sessionStorage.getItem(FLOW_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as DeviceFlowSession;
    if (!s.device_code || Date.now() >= s.expires_at) {
      sessionStorage.removeItem(FLOW_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export type Access = 'editor' | 'viewer' | 'denied';

export type AccessDetail =
  | 'app-not-installed' // ghu_ token, but the user has no app installation reaching this repo
  | 'repo-not-covered' // installation(s) exist, but none of them include this repo
  | 'no-token-permissions' // classic token with no read access to the repo
  | null; // editor/viewer — no problem to report


export async function checkAccess(ref: RepoRef, token: string): Promise<{ access: Access; login: string; detail: AccessDetail }> {
  const me = await gh('/user', token);
  const login = (me.login || '') as string;
  const wanted = `${ref.owner}/${ref.repo}`.toLowerCase();

  const inst = await gh('/user/installations?per_page=100', token).catch(() => null);
  if (inst?.installations) {
    if ((inst.installations as unknown[]).length === 0) {
      return { access: 'denied', login, detail: 'app-not-installed' };
    }
    for (const i of inst.installations || []) {
      const repos = await gh(`/user/installations/${(i as any).id}/repositories?per_page=100`, token).catch(() => null);
      const hit = (repos?.repositories || []).find((r: any) => r.full_name.toLowerCase() === wanted);
      if (hit) {

        const perms = await gh(`/repos/${ref.owner}/${ref.repo}/collaborators/${login}/permission`, token).catch(() => null);
        const p = (perms?.permission || '') as string;
        if (p === 'read' || p === 'triage') return { access: 'viewer', login, detail: null };
        return { access: 'editor', login, detail: null };
      }
    }
    return { access: 'denied', login, detail: 'repo-not-covered' };
  }

  const repo = await gh(`/repos/${ref.owner}/${ref.repo}`, token).catch(() => null);
  if (!repo?.permissions) return { access: 'denied', login, detail: 'no-token-permissions' };
  if (repo.permissions.push || repo.permissions.admin || repo.permissions.maintain) {
    return { access: 'editor', login, detail: null };
  }
  return { access: 'viewer', login, detail: null };
}


export const CLIENT_ID =
  ((import.meta as any).env?.VITE_GITHUB_CLIENT_ID as string | undefined) ||
  'Iv23liuS2fx3QOEIoDmx';
export const APP_SLUG =
  ((import.meta as any).env?.VITE_GITHUB_APP_SLUG as string | undefined) || 'excalidrop';
export const APP_INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;

export const HAS_CLIENT_ID = !!CLIENT_ID && !CLIENT_ID.includes('EXCALIDROP_APP');
