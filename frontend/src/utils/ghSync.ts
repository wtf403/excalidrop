

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

// Direct git-blob URL for the scene file. Raw serves CORS * but with a ~300s
// Fastly edge TTL keyed on the path — the query string is IGNORED for cache
// purposes, so `?t=...` cache-busters do NOT beat staleness (verified: same
// etag + `x-cache: HIT` + growing `source-age` with and without `?t=`).
// Branch-pinned raw can therefore lag a save by up to ~5min. Commit-pinned
// raw (`rawSceneUrlForCommit`) is immutable and never stale — resolve the
// branch head SHA via the API, then fetch raw at that SHA. Saves commit
// straight to this branch via the Contents API.
export function rawSceneUrl(ref: RepoRef): string {
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${ref.branch}/canvas.excalidraw`;
}

// Immutable, never-stale variant: a commit SHA in the path is a distinct CDN
// object, so a HIT is the correct bytes (unlike the branch path above).
export function rawSceneUrlForCommit(ref: RepoRef, commitSha: string): string {
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${commitSha}/canvas.excalidraw`;
}

// --- Anonymous fresh reads (no token, public repos only) -------------------
// Unauthenticated Contents API calls work (CORS *) but are limited to
// 60 req/hour/IP (vs 5000 with a token). A 20s poll alone burns 180/hr, so:
// - polls resolve the tiny branch-head ref first and skip the scene fetch
//   entirely when the commit SHA hasn't moved (plus ETag 304s, which don't
//   serve stale bytes);
// - on 403/429 we back off until the rate-limit window resets and fall back
//   to the (possibly stale) branch raw blob meanwhile instead of erroring.
const anonBackoffUntil = new Map<string, number>();
const lastHeadSha = new Map<string, string>();
const lastHeadEtag = new Map<string, string>();

function anonKey(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}/${ref.branch}`;
}

function anonBackoffMs(res: Response): number {
  try {
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      if (retryAfter > 0) return retryAfter * 1000 + 1000;
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
      if (remaining === '0' && reset > 0) return Math.max(0, reset * 1000 - Date.now()) + 5000;
      return 5 * 60 * 1000;
    }
  } catch { /* fall through */ }
  return 0;
}

/** Resolve the branch head commit SHA. Returns notModified when the caller
 *  already holds the latest commit (ETag 304 or same SHA) so it can skip the
 *  scene download. backedOff means the API quota is exhausted — use the
 *  branch raw fallback until the window resets. */
// Every network call in the viewer goes through here. api.github.com served
// from a cold keep-alive pool intermittently hangs at TCP level with no
// rejection — without a timeout a single stalled socket wedges boot
// ("Checking access…" forever) since checkAccess awaits gh() with no guard.
export async function timedFetch(url: string, init: RequestInit = {}, ms = 20000): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    // Older browsers lack AbortSignal.timeout — fall back to a manual race.
    if (typeof (AbortSignal as any).timeout !== 'function' && !(init as any).signal) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const gated = new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error(`fetch timed out after ${ms}ms: ${url}`)), ms);
        });
        return await Promise.race([fetch(url, init), gated]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw e;
  }
}

export async function fetchBranchHeadSha(
  ref: RepoRef,
): Promise<{ sha: string | null; notModified: boolean; backedOff: boolean }> {
  const key = anonKey(ref);
  const cached = lastHeadSha.get(key) || null;
  if (Date.now() < (anonBackoffUntil.get(key) || 0)) {
    return { sha: cached, notModified: true, backedOff: true };
  }
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    const etag = lastHeadEtag.get(key);
    if (etag) headers['If-None-Match'] = etag;
    const res = await timedFetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/ref/heads/${ref.branch}`,
      { cache: 'no-store', headers },
    );
    if (res.status === 304) return { sha: cached, notModified: true, backedOff: false };
    if (!res.ok) {
      const wait = anonBackoffMs(res);
      if (wait > 0) anonBackoffUntil.set(key, Date.now() + wait);
      return { sha: cached, notModified: true, backedOff: wait > 0 };
    }
    const et = res.headers.get('etag');
    if (et) lastHeadEtag.set(key, et);
    const j = await res.json().catch(() => null);
    const sha = j?.object?.sha as string | undefined;
    if (!sha) return { sha: cached, notModified: true, backedOff: false };
    const moved = sha !== cached;
    lastHeadSha.set(key, sha);
    return { sha, notModified: !moved, backedOff: false };
  } catch {
    return { sha: cached, notModified: true, backedOff: false };
  }
}

/** Fetch the scene at a pinned commit — immutable CDN object, never stale. */
export async function fetchPinnedScene(
  ref: RepoRef, commitSha: string,
): Promise<{ elements: any[]; files?: Record<string, unknown> }> {
  const r = await fetch(rawSceneUrlForCommit(ref, commitSha), { cache: 'no-store' });
  if (!r.ok) throw new Error(`pinned blob ${r.status}`);
  const j = await r.json();
  return { elements: j.elements || [], files: j.files || {} };
}

export type AnonPollResult =
  | { status: 'fresh'; elements: any[]; files?: Record<string, unknown> }
  | { status: 'not-modified' }
  | { status: 'backed-off' };

/** Anonymous poll tick: 1 tiny ref lookup + immutable CDN fetch only when the
 *  head moved. Never throws — callers fall back to the branch raw blob. */
export async function pollAnonymousScene(ref: RepoRef): Promise<AnonPollResult> {
  const head = await fetchBranchHeadSha(ref);
  if (head.backedOff) return { status: 'backed-off' };
  if (!head.sha || head.notModified) return { status: 'not-modified' };
  try {
    const doc = await fetchPinnedScene(ref, head.sha);
    return { status: 'fresh', elements: doc.elements, files: doc.files };
  } catch {
    return { status: 'backed-off' };
  }
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
  return getStoredToken()?.token ?? null;
}

export function setToken(t: string | null, refresh_token?: string | null, expires_in_sec?: number | null): void {
  try {
    if (!t) {
      localStorage.removeItem(TOKEN_KEY);
      return;
    }
    if (refresh_token || expires_in_sec) {
      const store: TokenStore = {
        token: t,
        ...(refresh_token ? { refresh_token } : {}),
        ...(expires_in_sec ? { expires_at: Date.now() + expires_in_sec * 1000 } : {}),
      };
      localStorage.setItem(TOKEN_KEY, JSON.stringify(store));
    } else {
      localStorage.setItem(TOKEN_KEY, t);
    }
  } catch { /* storage unavailable — session-only */ }
}

interface TokenStore {
  token: string;
  refresh_token?: string;
  expires_at?: number;
}

/** Read the stored credential, accepting both the legacy bare token string
 *  and the JSON store written by setToken with refresh data. */
export function getStoredToken(): TokenStore | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    if (raw.trimStart().startsWith('{')) {
      const s = JSON.parse(raw) as TokenStore;
      return s?.token ? s : null;
    }
    return { token: raw };
  } catch {
    return null;
  }
}

export interface DeviceToken {
  token: string;
  refresh_token?: string;
  expires_in?: number;
}

/** Exchange a refresh token for a fresh access-token pair. Returns null when
 *  the refresh token itself is dead (revoked / never used for 6 months). */
export async function refreshAccessToken(clientId: string, refreshToken: string): Promise<DeviceToken | null> {
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.access_token) return null;
    return {
      token: j.access_token as string,
      ...(j.refresh_token ? { refresh_token: j.refresh_token as string } : {}),
      ...(j.expires_in ? { expires_in: Number(j.expires_in) } : {}),
    };
  } catch {
    return null;
  }
}

/** Renew the stored credential when we have a refresh token and the access
 *  token is expired (or expiring within `marginMs`). Persists the new pair
 *  and returns the fresh access token, or null when renewal isn't possible. */
export async function tryRefreshToken(clientId: string, opts: { force?: boolean; marginMs?: number } = {}): Promise<string | null> {
  const stored = getStoredToken();
  if (!stored?.refresh_token) return null;
  const margin = opts.marginMs ?? 10 * 60 * 1000;
  const expiring = !stored.expires_at || stored.expires_at - Date.now() < margin;
  if (!opts.force && !expiring) return stored.token;
  const next = await refreshAccessToken(clientId, stored.refresh_token);
  if (!next) return null;
  setToken(next.token, next.refresh_token ?? stored.refresh_token, next.expires_in ?? null);
  return next.token;
}

async function gh(path: string, token: string, init?: RequestInit): Promise<any> {
  const r = await timedFetch(`https://api.github.com${path}`, {
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
// - Deleted on one side + untouched on the other → honor the delete.
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
      if (!be) merged.push(le); // created locally — keep
      else if (elementSig(be) !== elementSig(le)) {
        merged.push(le); // remote deleted, local edited → edit wins
        conflicts.push(id);
      }
      // else: deleted remotely, untouched locally → honor the delete
      continue;
    }
    if (!le && re) {
      if (!be) { merged.push(re); added++; } // created remotely — keep
      else if (elementSig(be) !== elementSig(re)) {
        merged.push(re); // local deleted, remote edited → edit wins
        conflicts.push(id);
      }
      // else: deleted locally, untouched remotely → honor the delete
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

function encodeSceneDoc(elements: unknown[], files?: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(
    { type: 'excalidraw', version: 2, source: 'excalidrop', elements, ...(files ? { files } : {}) },
    null, 2,
  ))));
}

function extForMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  };
  return map[mime] || 'png';
}

function assetPathFor(id: string, mime: string): string {
  return `assets/${id}.${extForMime(mime)}`;
}

// Ids already confirmed present upstream (via HEAD-check or successful PUT)
// within this session, plus a localStorage mirror across reloads. Prevents a
// `GET contents/assets/<id>.*` per image on every save when the canvas source
// hasn't changed.
const syncedAssetIds = new Set<string>();
try {
  for (const id of (localStorage.getItem('excalidrop_synced_assets') || '').split(',').filter(Boolean)) {
    syncedAssetIds.add(id);
  }
} catch { /* storage unavailable */ }
function markAssetSynced(id: string): void {
  if (syncedAssetIds.has(id)) return;
  syncedAssetIds.add(id);
  try {
    const arr = [...syncedAssetIds].slice(-200);
    localStorage.setItem('excalidrop_synced_assets', arr.join(','));
  } catch { /* non-fatal */ }
}

// Commit each image binary to assets/ on the canvas branch so pasted images
// exist as real files, not just base64 inside canvas.excalidraw. Skips files
// that already exist upstream (checked via a single GET per file, cached in
// `syncedAssetIds` so unchanged canvases never re-request).
async function syncAssets(
  ref: RepoRef, token: string, files: unknown, keepalive: boolean,
): Promise<void> {
  const list: any[] = Array.isArray(files) ? files : Object.values((files as any) || {});
  const withData = list.filter((f) => f?.id && typeof f?.dataURL === 'string' && f.dataURL.startsWith('data:'));
  if (withData.length === 0) return;
  await Promise.all(withData.map(async (f) => {
    try {
      if (syncedAssetIds.has(f.id)) return;
      // Binary images arrive base64-encoded; SVGs may arrive URL-encoded
      // (data:image/svg+xml,... without ;base64). Normalize both to base64.
      let mime: string, b64: string;
      const m = /^data:([^;]+);base64,(.+)$/s.exec(f.dataURL);
      if (m) {
        mime = f.mimeType || m[1];
        b64 = m[2];
      } else {
        const u = /^data:([^,]+),([\s\S]+)$/.exec(f.dataURL);
        if (!u) return;
        mime = f.mimeType || u[1].split(';')[0];
        try {
          b64 = btoa(unescape(encodeURIComponent(decodeURIComponent(u[2]))));
        } catch { return; }
      }
      const assetPath = assetPathFor(f.id, mime);
      // Skip if already committed.
      try {
        const head = await timedFetch(
          `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/${assetPath}?ref=${ref.branch}`,
          { cache: 'no-store', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
        );
        if (head.ok) { markAssetSynced(f.id); return; }
      } catch { /* fall through to PUT */ }
      await gh(`/repos/${ref.owner}/${ref.repo}/contents/${assetPath}`, token, {
        method: 'PUT',
        ...(keepalive ? { keepalive: true } : {}),
        body: JSON.stringify({
          message: `excalidrop: add image asset ${f.id}`,
          content: b64,
          branch: ref.branch,
        }),
      });
      markAssetSynced(f.id);
    } catch { /* asset commit is best-effort; scene PUT still carries the dataURL */ }
  }));
}

function decodeSceneDoc(b64: string): any | null {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(b64.replace(/\n/g, '')))));
  } catch {
    return null;
  }
}

async function readSceneFile(ref: RepoRef, token: string): Promise<{ sha: string; elements: any[]; files?: any } | null> {
  try {
    const cur = await gh(`/repos/${ref.owner}/${ref.repo}/contents/canvas.excalidraw?ref=${ref.branch}`, token);
    if (!cur || typeof cur.sha !== 'string') return null;
    // Small file: blob content is inline.
    if (typeof cur.content === 'string' && cur.content.length > 0) {
      const doc = decodeSceneDoc(cur.content);
      if (!doc) return { sha: cur.sha as string, elements: [] };
      return { sha: cur.sha as string, elements: Array.isArray(doc.elements) ? doc.elements : [], files: doc.files };
    }
    // Large file (>~1MB): the Contents API omits the blob (encoding 'none')
    // but still returns the sha — fetch the blob directly (up to 100MB).
    // Fall back to sha-only (elements unknown) so the caller's PUT still
    // supplies `sha` instead of failing with 422 `"sha" wasn't supplied`.
    // The 409 path re-reads before merging, so no data is lost.
    try {
      const blob = await gh(`/repos/${ref.owner}/${ref.repo}/git/blobs/${cur.sha}`, token);
      if (!blob?.content) return { sha: cur.sha as string, elements: [] };
      const doc = decodeSceneDoc(blob.content);
      if (!doc) return { sha: cur.sha as string, elements: [] };
      return { sha: cur.sha as string, elements: Array.isArray(doc.elements) ? doc.elements : [], files: doc.files };
    } catch {
      return { sha: cur.sha as string, elements: [] };
    }
  } catch {
    return null;
  }
}

// Contents API payload ceiling: reads already omit blobs past ~1MB, and
// writes of that size are rejected — route oversize scenes through the Git
// Data API (blobs up to 100MB) instead of failing every save with 422.
const CONTENTS_B64_LIMIT = 900_000;

// Write a scene file via the Git Data API: create blob → tree → commit →
// move the branch ref. Never force-pushes: a non-fast-forward update throws
// a 409-style error so the caller can merge and retry instead of clobbering.
async function putLargeFile(
  ref: RepoRef, token: string, b64: string, message: string,
  author: { name: string; email: string } | undefined,
): Promise<string> {
  const api = `/repos/${ref.owner}/${ref.repo}`;
  const blob = await gh(`${api}/git/blobs`, token, {
    method: 'POST',
    body: JSON.stringify({ content: b64, encoding: 'base64' }),
  });
  const refInfo = await gh(`${api}/git/ref/heads/${ref.branch}`, token);
  const head = refInfo?.object?.sha as string | undefined;
  if (!head) throw new Error('GitHub 422: branch ref not found');
  const commit = await gh(`${api}/git/commits/${head}`, token);
  const tree = await gh(`${api}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: commit?.tree?.sha,
      tree: [{ path: 'canvas.excalidraw', mode: '100644', type: 'blob', sha: blob.sha }],
    }),
  });
  const made = await gh(`${api}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [head],
      ...(author ? { author, committer: author } : {}),
    }),
  });
  try {
    await gh(`${api}/git/refs/heads/${ref.branch}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ sha: made.sha }),
    });
  } catch (e) {
    // Someone committed underneath us — not fast-forward. Report as a 409
    // so pushScene runs its merge-and-retry path.
    throw new Error(`GitHub 409: ${(e as Error).message}`);
  }
  return blob.sha as string;
}

async function putSceneFile(
  ref: RepoRef, token: string, elements: unknown[], message: string,
  sha: string | undefined, keepalive: boolean, files?: unknown,
): Promise<string> {
  // Close-flush (keepalive): single-flight PUT — skip the /user attribution
  // lookup so the save is ONE request that can survive page teardown.
  // The Contents API still attributes the commit to the token owner.
  let author: { name: string; email: string } | undefined;
  if (!keepalive) {
    try {
      const me = await gh('/user', token);
      if (me?.login) author = { name: me.login, email: `${me.login}@users.noreply.github.com` };
    } catch { /* fall back to token-owner default */ }
  }
  const content = encodeSceneDoc(elements, files);
  // Oversize payloads can't go through the Contents API — same ~1MB ceiling
  // as reads. The Data API chain can't survive page teardown either, but the
  // local journal (not this flush) is the close guarantee.
  if (content.length > CONTENTS_B64_LIMIT) {
    return putLargeFile(ref, token, content, author ? `${message} — ${author.name}` : message, author);
  }
  const out = await gh(`/repos/${ref.owner}/${ref.repo}/contents/canvas.excalidraw`, token, {
    method: 'PUT',
    ...(keepalive ? { keepalive: true } : {}),
    body: JSON.stringify({
      message: author ? `${message} — ${author.name}` : message,
      content,
      branch: ref.branch,
      ...(sha ? { sha } : {}),
      ...(author ? { author, committer: author } : {}),
    }),
  });
  return out.content.sha as string;
}


export async function pushScene(
  ref: RepoRef, token: string, scene: { elements: unknown[]; files?: Record<string, unknown> },
  opts: { keepalive?: boolean; base?: any[]; sha?: string | null } = {},
): Promise<{ sha: string; elements: any[]; conflicts?: string[]; added?: number; updated?: number }> {
  const local = (scene.elements || []) as any[];
  const files = (scene as any).files;
  const keepalive = opts.keepalive ?? false;
  // Commit image binaries to assets/ first (best-effort, skipped when
  // already present). The scene PUT still embeds dataURLs so the viewer
  // renders even before/without the asset files.
  // Close-flush: fire PUTs with the last-known sha — no prior GET.
  // A 3-request chain (GET + /user + PUT) never survives page teardown.
  if (keepalive && opts.sha) {
    await syncAssets(ref, token, files, true).catch(() => null);
    const sha = await putSceneFile(ref, token, local, `excalidrop: autosync ${local.length} elements`, opts.sha, true, files);
    return { sha, elements: local };
  }
  await syncAssets(ref, token, files, keepalive).catch(() => null);
  const cur = await readSceneFile(ref, token);
  try {
    const sha = await putSceneFile(ref, token, local, `excalidrop: autosync ${local.length} elements`, cur?.sha, keepalive, files);
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
    fresh?.sha, keepalive, files,
  );
  return { sha, elements: merged, conflicts, added, updated };
}


export async function loadStaticScene(ref?: RepoRef, token?: string | null): Promise<{ elements: any[]; files?: Record<string, unknown> }> {
  // Authenticated Contents API FIRST: raw.githubusercontent.com has a ~300s
  // edge TTL, so the branch raw blob serves stale data right after a save.
  // The API returns the live bytes on every read. NOTE: for files >~1MB the
  // default JSON envelope omits the blob (`encoding: 'none'`), so the
  // `Accept: application/vnd.github.raw` header is required to get bytes.
  if (ref && token) {
    try {
      const res = await timedFetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/canvas.excalidraw?ref=${ref.branch}`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw' },
      });
      if (res.ok) {
        const j = await res.json();
        if (j && Array.isArray(j.elements)) return { elements: j.elements, files: j.files || {} };
      }
    } catch { /* fall through to raw blob */ }
  }
  // Anonymous fresh path (public repos, no token): the Contents API works
  // without auth (60 req/hr/IP) when asked for raw bytes directly.
  if (ref && !token) {
    try {
      const res = await timedFetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/canvas.excalidraw?ref=${ref.branch}`, {
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github.raw' },
      });
      if (res.ok) {
        const j = await res.json();
        if (j && Array.isArray(j.elements)) return { elements: j.elements, files: j.files || {} };
      } else {
        const wait = anonBackoffMs(res);
        if (wait > 0) anonBackoffUntil.set(anonKey(ref), Date.now() + wait);
      }
    } catch { /* fall through to commit-pinned raw */ }
    // Commit-pinned raw: immutable CDN object, never stale, costs no API
    // quota for the bytes (only the tiny ref lookup above/below does).
    try {
      const head = await fetchBranchHeadSha(ref);
      if (head.sha && !head.backedOff) {
        const doc = await fetchPinnedScene(ref, head.sha);
        return { elements: doc.elements || [], files: doc.files || {} };
      }
    } catch { /* fall through to branch raw */ }
  }
  if (ref) {
    // Last-resort branch raw: may lag saves by up to ~5min (edge TTL keyed on
    // path — `?t=` does NOT bust it). Kept so viewers still render something
    // when the API quota is exhausted.
    try {
      const r = await fetch(rawSceneUrl(ref), { cache: 'no-store' });
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
): Promise<DeviceToken> {
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
    if (j.access_token) {
      return {
        token: j.access_token as string,
        ...(j.refresh_token ? { refresh_token: j.refresh_token as string } : {}),
        ...(j.expires_in ? { expires_in: Number(j.expires_in) } : {}),
      };
    }
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
  | 'expired' // the stored token is dead (401 on /user): re-login, don't re-explain install
  | null; // editor/viewer — no problem to report


export async function checkAccess(ref: RepoRef, token: string): Promise<{ access: Access; login: string; detail: AccessDetail }> {
  // Device-flow (ghu_) tokens expire after ~8h. A dead token 401s here — call
  // it 'expired' so the UI offers re-login instead of a misleading
  // install-the-app explanation. This throw previously surfaced as a bare
  // exception and the caller mapped EVERYTHING to denied.
  let me: any = null;
  try {
    me = await gh('/user', token);
  } catch (e) {
    if (String((e as Error).message).includes('401')) {
      return { access: 'denied', login: '', detail: 'expired' };
    }
    throw e;
  }
  const login = (me.login || '') as string;
  const wanted = `${ref.owner}/${ref.repo}`.toLowerCase();

  const inst = await gh('/user/installations?per_page=100', token).catch(() => null);
  const hasInstallations = !!inst?.installations && (inst.installations as unknown[]).length > 0;
  // App user tokens (ghu_) / installation tokens (ghs_) act THROUGH the
  // installation: /repos/*/permissions may report the user's own push, but
  // writes outside the installation 403 with "Resource not accessible by
  // integration". So installation coverage is authoritative for app tokens —
  // only classic OAuth/PAT tokens fall through to the repo permissions check.
  const isAppToken = /^(ghu_|ghs_)/.test(token.trim());
  if (hasInstallations) {
    // GitHub App token path: check installation-covered repos
    for (const i of inst.installations || []) {
      const repos = await gh(`/user/installations/${(i as any).id}/repositories?per_page=100`, token).catch(() => null);
      const hit = (repos?.repositories || []).find((r: any) => r.full_name.toLowerCase() === wanted);
      if (hit) {
        // collaborators/permission 403s for user tokens ("Resource not
        // accessible by integration") — fall back to the repo endpoint,
        // which reports this token's own permissions and never 403s here.
        const perms = await gh(`/repos/${ref.owner}/${ref.repo}/collaborators/${login}/permission`, token).catch(() => null);
        const p = (perms?.permission || '') as string;
        if (p === 'read' || p === 'triage') return { access: 'viewer', login, detail: null };
        if (p === 'admin' || p === 'maintain' || p === 'write') return { access: 'editor', login, detail: null };
        if (!p) {
          const repo = await gh(`/repos/${ref.owner}/${ref.repo}`, token).catch(() => null);
          if (repo?.permissions && !(repo.permissions.push || repo.permissions.admin || repo.permissions.maintain)) {
            return { access: 'viewer', login, detail: null };
          }
        }
        return { access: 'editor', login, detail: null };
      }
    }
    // No installation covers this repo — but the token itself may still have
    // push (owner/collaborator OAuth scope). Fall through to the repo
    // permissions check below instead of hard-denying; the caller keeps the
    // repo-not-covered hint via checkRepoCoverage when it needs the install URL.
    // Exception (see above): app-scoped tokens can't write outside their
    // installation at all, so for them uncovered means read-only, no fallback.
    if (isAppToken) return { access: 'denied', login, detail: 'repo-not-covered' };
  }

  const repo = await gh(`/repos/${ref.owner}/${ref.repo}`, token).catch(() => null);
  if (!repo?.permissions) return { access: 'denied', login, detail: hasInstallations ? 'repo-not-covered' : 'no-token-permissions' };
  if (repo.permissions.push || repo.permissions.admin || repo.permissions.maintain) {
    return { access: 'editor', login, detail: null };
  }
  return { access: 'viewer', login, detail: hasInstallations ? 'repo-not-covered' : null };
}


export const CLIENT_ID =
  ((import.meta as any).env?.VITE_GITHUB_CLIENT_ID as string | undefined) ||
  'Iv23liuS2fx3QOEIoDmx';
export const APP_SLUG =
  ((import.meta as any).env?.VITE_GITHUB_APP_SLUG as string | undefined) || 'excalidrop';
export const APP_INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;

export const HAS_CLIENT_ID = !!CLIENT_ID && !CLIENT_ID.includes('EXCALIDROP_APP');
