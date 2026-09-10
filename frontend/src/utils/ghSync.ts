/**
 * Static-viewer GitHub sync. Zero config on *.github.io:
 * owner/repo are derived from the URL, token comes from
 * localStorage (pasted PAT or agent handoff via #token=...).
 * Device-flow login needs VITE_GITHUB_CLIENT_ID (one-time OAuth App setup).
 */

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
  // Agent handoff: https://<site>/#token=gho_...
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

/** Push scene JSON straight to the branch (viewer copy = source of truth for static mode). */
export async function pushScene(
  ref: RepoRef, token: string, scene: { elements: unknown[]; files?: Record<string, unknown> },
): Promise<string> {
  const path = 'canvas.excalidraw';
  let sha: string | undefined;
  try {
    const cur = await gh(`/repos/${ref.owner}/${ref.repo}/contents/${path}?ref=${ref.branch}`, token);
    sha = cur.sha;
  } catch { /* new file */ }
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

/** Load the static scene copy (no auth needed for public repos). */
export async function loadStaticScene(): Promise<{ elements: any[]; files?: Record<string, unknown> }> {
  const r = await fetch('./canvas.excalidraw', { cache: 'no-cache' });
  if (!r.ok) throw new Error(`scene fetch ${r.status}`);
  const j = await r.json();
  return { elements: j.elements || [], files: j.files || {} };
}

/** Device-flow login. Returns {userCode, verificationUri} — the token
 *  polling step may be CORS-blocked on static hosting, so the agent can
 *  complete it instead (github_login tool) and hand back a #token= link.
 *  NOTE: no `scope` — GitHub App user-tokens use fine-grained permissions
 *  (user ∩ app), never scopes. */
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

export type Access = 'editor' | 'viewer' | 'denied';

export type AccessDetail =
  | 'app-not-installed' // ghu_ token, but the user has no app installation reaching this repo
  | 'repo-not-covered' // installation(s) exist, but none of them include this repo
  | 'no-token-permissions' // classic token with no read access to the repo
  | null; // editor/viewer — no problem to report

/** What can this token do on this repo? Reads the user's app installations —
 *  the token only reaches repos both the user AND the app can access, so this
 *  mirrors GitHub's own enforcement (repo access == canvas access).
 *  `detail` tells the UI *why* access was denied so the login modal can
 *  point at the right fix (install the app vs. add this repo to the install). */
export async function checkAccess(ref: RepoRef, token: string): Promise<{ access: Access; login: string; detail: AccessDetail }> {
  const me = await gh('/user', token);
  const login = (me.login || '') as string;
  const wanted = `${ref.owner}/${ref.repo}`.toLowerCase();
  // Path 1: GitHub App user-token (ghu_) — installations list the repos it reaches.
  // Classic PATs/OAuth tokens get 403 here ("must authenticate with an access
  // token authorized to a GitHub App") and fall through to Path 2.
  // per_page=100: without it a user with many repos can miss the hit (p.30 default).
  const inst = await gh('/user/installations?per_page=100', token).catch(() => null);
  if (inst?.installations) {
    if ((inst.installations as unknown[]).length === 0) {
      return { access: 'denied', login, detail: 'app-not-installed' };
    }
    for (const i of inst.installations || []) {
      const repos = await gh(`/user/installations/${(i as any).id}/repositories?per_page=100`, token).catch(() => null);
      const hit = (repos?.repositories || []).find((r: any) => r.full_name.toLowerCase() === wanted);
      if (hit) {
        // Token reaches the repo. Resolve read vs write via the collaborator
        // permission endpoint; if that probe fails, start optimistic-editor —
        // the Contents API is the real enforcement and a 403 push demotes to
        // viewer (fail-open UI, fail-closed API).
        const perms = await gh(`/repos/${ref.owner}/${ref.repo}/collaborators/${login}/permission`, token).catch(() => null);
        const p = (perms?.permission || '') as string;
        if (p === 'read' || p === 'triage') return { access: 'viewer', login, detail: null };
        return { access: 'editor', login, detail: null };
      }
    }
    return { access: 'denied', login, detail: 'repo-not-covered' };
  }
  // Path 2: classic token — the repo endpoint echoes *this token's* permissions.
  const repo = await gh(`/repos/${ref.owner}/${ref.repo}`, token).catch(() => null);
  if (!repo?.permissions) return { access: 'denied', login, detail: 'no-token-permissions' };
  if (repo.permissions.push || repo.permissions.admin || repo.permissions.maintain) {
    return { access: 'editor', login, detail: null };
  }
  return { access: 'viewer', login, detail: null };
}

/**
 * Shared GitHub App (one app, many installs — any user installs it on their
 * own repo; the Client ID is public, not a secret). Overridable at publish
 * time via VITE_GITHUB_CLIENT_ID / VITE_GITHUB_APP_SLUG.
 */
export const CLIENT_ID =
  ((import.meta as any).env?.VITE_GITHUB_CLIENT_ID as string | undefined) ||
  'Iv23liuS2fx3QOEIoDmx'; // shared Excalidrop GitHub App (public ID, not a secret)
export const APP_SLUG =
  ((import.meta as any).env?.VITE_GITHUB_APP_SLUG as string | undefined) || 'excalidrop';
export const APP_INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;
/** True when a real Client ID is baked in (not the publish-time placeholder). */
export const HAS_CLIENT_ID = !!CLIENT_ID && !CLIENT_ID.includes('EXCALIDROP_APP');
