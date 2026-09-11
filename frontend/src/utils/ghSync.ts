

export interface RepoRef { owner: string; repo: string; branch: string }

export function detectRepo(): RepoRef | null {
  // Localhost override for dev/testing: ?repo=owner/name
  try {
    const q = new URLSearchParams(window.location.search).get('repo');
    if (q?.includes('/')) {
      const [owner, repo] = q.split('/');
      if (owner && repo) return { owner, repo, branch: 'excalidrop' };
    }
  } catch {}
  const explicit = (import.meta as any).env?.VITE_REPO_SLUG as string | undefined;
  if (explicit?.includes('/')) {
    const [owner, repo] = explicit.split('/');
    return { owner, repo, branch: 'excalidrop' };
  }
  const host = window.location.hostname; // <owner>.github.io
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (host.endsWith('.github.io') && parts.length > 0) {
    return { owner: host.slice(0, -'.github.io'.length), repo: parts[0], branch: 'excalidrop' };
  }
  return null;
}

// Direct git-blob URL for the scene file. Raw serves CORS * with a 300s edge
// TTL, so anonymous polls add a cache-buster and never depend on a Pages
// build; saves commit straight to this branch via the Contents API.
export function rawSceneUrl(ref: RepoRef): string {
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.branch}/canvas.excalidraw`;
}

const TOKEN_KEY = 'excalidrop_gh_token';

/** Parse `#a=b&c=d` style hash regardless of param order. */
export function parseHashParams(): URLSearchParams {
  const h = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  // URLSearchParams handles decoding; a bare `#token=xyz` still works.
  try {
    return new URLSearchParams(h);
  } catch {
    return new URLSearchParams();
  }
}

/** Remove consumed keys from the hash, preserving anything not yet handled. */
export function removeHashParams(...keys: string[]): void {
  try {
    const p = parseHashParams();
    let changed = false;
    for (const k of keys) {
      if (p.has(k)) {
        p.delete(k);
        changed = true;
      }
    }
    if (!changed) return;
    const rest = p.toString();
    const url = window.location.pathname + window.location.search + (rest ? `#${rest}` : '');
    history.replaceState(null, '', url);
  } catch {
    /* non-fatal */
  }
}

export function getAddLibraryUrls(): string[] {
  const out: string[] = [];
  try {
    const p = parseHashParams();
    for (const v of p.getAll('addLibrary')) {
      if (v) out.push(v);
      // Support comma-separated lists like excalidraw.com share links.
      // getAll above already returns the whole value, so split it here.
      if (v?.includes(',')) {
        const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
        out.pop();
        out.push(...parts);
      }
    }
  } catch {
    /* non-fatal */
  }
  return out.filter(Boolean);
}

export function getToken(): string | null {
  const t = parseHashParams().get('token');
  if (t) {
    localStorage.setItem(TOKEN_KEY, t);
    // Keep addLibrary (not yet consumed) so the library effect can read it.
    removeHashParams('token');
    return t;
  }
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function gh(path: string, token: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`https://api.github.com${path}`, {
    cache: 'no-store',
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


// Union of two element lists by id. `incoming` wins per id; ids only in
// `base` are preserved. Used on 409 conflicts so concurrent writers compose
// instead of last-writer-wins wiping the other side's work.
// Limitation: an element deleted locally is resurrected if it still exists
// upstream at conflict time — re-delete afterwards; creations are never lost.
export function mergeSceneElements(base: any[], incoming: any[]): any[] {
  return threeWayMerge(base, base, incoming).merged;
}

function elTime(el: any): number {
  const t = el?.updatedAt ?? el?.createdAt;
  const n = typeof t === 'number' ? t : Date.parse(String(t ?? ''));
  return Number.isFinite(n) ? n : 0;
}

// Semantic per-element signature. Ignores Excalidraw re-normalization noise
// (versionNonce, seed, selection) so remote polls don't look like changes.
export function elementSig(el: any): string {
  try {
    return JSON.stringify([
      el.id, el.version, el.x, el.y, el.width, el.height, el.angle,
      el.text, el.originalText, el.points, el.isDeleted,
      el.containerId, el.boundElements, el.groupIds, el.link,
      el.backgroundColor, el.strokeColor, el.fontSize,
    ]);
  } catch { return String(el?.id); }
}

export interface MergeResult {
  merged: any[];
  conflicts: string[]; // ids edited on both sides with different content
  added: number;       // upstream-only ids folded in
  updated: number;     // upstream-newer ids that overwrote local
}

// 3-way merge: base = last synced snapshot, local = canvas, remote = upstream.
// - Unchanged on one side → take the other side.
// - Changed identically → keep either.
// - Changed differently (same id) → newer updatedAt wins, id in conflicts.
// - Deleted on one side + edited on the other → edit wins (resurrect), id in
//   conflicts so the UI can let the user re-delete.
export function threeWayMerge(base: any[], local: any[], remote: any[]): MergeResult {
  const b = new Map<string, any>(); for (const el of base || []) if (el?.id) b.set(el.id, el);
  const l = new Map<string, any>(); for (const el of local || []) if (el?.id) l.set(el.id, el);
  const r = new Map<string, any>(); for (const el of remote || []) if (el?.id) r.set(el.id, el);
  const merged: any[] = [];
  const conflicts: string[] = [];
  let added = 0, updated = 0;
  for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
    const be = b.get(id), le = l.get(id), re = r.get(id);
    if (le && !re) {
      if (be && elementSig(be) !== elementSig(le)) {
        merged.push(re ?? le); // remote deleted, local edited → edit wins
        conflicts.push(id);
      } else merged.push(le); // created locally or deleted remotely untouched
      continue;
    }
    if (!le && re) {
      if (be && elementSig(be) !== elementSig(re)) {
        merged.push(re); // local deleted, remote edited → edit wins
        conflicts.push(id);
      } else merged.push(re); // created remotely or deleted locally untouched
      if (!be) added++;
      continue;
    }
    if (!le && !re) continue; // deleted both sides
    // present both sides
    const bs = be ? elementSig(be) : null;
    const ls = elementSig(le), rs = elementSig(re);
    if (ls === rs) { merged.push(le); continue; }
    if (bs === null || bs === rs) { merged.push(le); continue; } // remote untouched
    if (bs === ls) { merged.push(re); updated++; continue; }     // local untouched
    const winner = elTime(re) >= elTime(le) ? re : le; // both edited → newer wins
    merged.push(winner);
    if (winner === re) updated++;
    conflicts.push(id);
  }
  return { merged, conflicts, added, updated };
}

function encodeSceneDoc(elements: unknown[]): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(
    { type: 'excalidraw', version: 2, source: 'excalidrop', elements },
    null, 2,
  ))));
}

function decodeSceneDoc(b64: string): any | null {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(b64.replace(/\n/g, '')))));
  } catch {
    return null;
  }
}

async function readSceneFile(ref: RepoRef, token: string): Promise<{ sha: string; elements: any[] } | null> {
  try {
    const cur = await gh(`/repos/${ref.owner}/${ref.repo}/contents/canvas.excalidraw?ref=${ref.branch}`, token);
    const doc = decodeSceneDoc(cur.content);
    if (!doc) return null;
    return { sha: cur.sha as string, elements: Array.isArray(doc.elements) ? doc.elements : [] };
  } catch {
    return null;
  }
}

async function putSceneFile(
  ref: RepoRef, token: string, elements: unknown[], message: string,
  sha: string | undefined, keepalive: boolean,
): Promise<string> {
  // Attribute the commit to the actual GitHub user behind the token, not the
  // OAuth app: Contents API defaults author/committer to the token owner only
  // when omitted in some flows — set explicitly from /user.
  let author: { name: string; email: string } | undefined;
  try {
    const me = await gh('/user', token);
    if (me?.login) author = { name: me.login, email: `${me.login}@users.noreply.github.com` };
  } catch { /* fall back to token-owner default */ }
  const out = await gh(`/repos/${ref.owner}/${ref.repo}/contents/canvas.excalidraw`, token, {
    method: 'PUT',
    ...(keepalive ? { keepalive: true } : {}),
    body: JSON.stringify({
      message: author ? `${message} — ${author.name}` : message,
      content: encodeSceneDoc(elements),
      branch: ref.branch,
      ...(sha ? { sha } : {}),
      ...(author ? { author, committer: author } : {}),
    }),
  });
  return out.content.sha as string;
}


export async function pushScene(
  ref: RepoRef, token: string, scene: { elements: unknown[]; files?: Record<string, unknown> },
  opts: { keepalive?: boolean; base?: any[] } = {},
): Promise<{ sha: string; elements: any[]; conflicts?: string[]; added?: number; updated?: number }> {
  const local = (scene.elements || []) as any[];
  const keepalive = opts.keepalive ?? false;
  const cur = await readSceneFile(ref, token);
  try {
    const sha = await putSceneFile(ref, token, local, `excalidrop: autosync ${local.length} elements`, cur?.sha, keepalive);
    return { sha, elements: local };
  } catch (e) {
    if (!String((e as Error).message).includes('409')) throw e;
  }
  // Conflict: someone else committed underneath us. 3-way rebase against the
  // last synced base: disjoint regions compose silently, same-id double-edits
  // go to the newer updatedAt, delete-vs-edit keeps the edit and reports the
  // id so the UI can let the user re-delete.
  const fresh = await readSceneFile(ref, token);
  const { merged, conflicts, added, updated } = threeWayMerge(
    opts.base || [], local, fresh?.elements || [],
  );
  const sha = await putSceneFile(
    ref, token, merged,
    `excalidrop: autosync ${local.length} elements (+${merged.length - local.length} merged)`,
    fresh?.sha, keepalive,
  );
  return { sha, elements: merged, conflicts, added, updated };
}


export async function loadStaticScene(ref?: RepoRef): Promise<{ elements: any[]; files?: Record<string, unknown> }> {
  // Prefer the raw git blob (live the moment a save commits, no Pages build
  // in between); fall back to the Pages-served copy.
  if (ref) {
    try {
      const r = await fetch(`${rawSceneUrl(ref)}?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        return { elements: j.elements || [], files: j.files || {} };
      }
    } catch { /* fall through to Pages copy */ }
  }
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
