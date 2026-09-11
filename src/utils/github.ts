
import logger from './logger.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';

export function token(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

export function currentRepo(): string {
  try {
    const url = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
    return (m?.[1] || '').toLowerCase();
  } catch { return ''; }
}
export const SCENE_PATH = process.env.SCENE_PATH || 'canvas.excalidraw';

// The branch that serves the Pages site AND holds the scene file.
// Must match the frontend's detectRepo() (ghSync.ts) and scripts/publish-pages.sh.
export const CANVAS_BRANCH = process.env.CANVAS_BRANCH || 'excalidrop';

// Branch GitHub Pages serves. Same as CANVAS_BRANCH by default so the viewer
// and canvas.excalidraw live together. The viewer reads the scene straight
// from the git blob (raw.githubusercontent.com), so it never waits on a
// Pages build; saves are a single Contents-API PUT, no per-save side calls.
export const PAGES_BRANCH = process.env.PAGES_BRANCH || 'excalidrop';

export class SceneConflictError extends Error {
  freshSha: string | null;
  freshElements: any[] | null;
  freshFiles: unknown;
  constructor(freshSha: string | null, freshElements: any[] | null, freshFiles?: unknown) {
    super('CONFLICT: scene changed upstream, merged retry required');
    this.name = 'SceneConflictError';
    this.freshSha = freshSha;
    this.freshElements = freshElements;
    this.freshFiles = freshFiles;
  }
}

// Union of two element lists by id. `incoming` (local) wins per id; ids only
// upstream are preserved. Same contract as the frontend's mergeSceneElements:
// concurrent saves compose instead of last-writer-wins wiping creations.
// Limitation: a locally deleted element is resurrected if still upstream at
// conflict time — re-delete afterwards; creations are never lost.
export function mergeSceneElements(base: any[], incoming: any[]): any[] {
  const byId = new Map<string, any>();
  for (const el of base) if (el?.id) byId.set(el.id, el);
  for (const el of incoming) if (el?.id) byId.set(el.id, el);
  return Array.from(byId.values());
}

// Fold upstream-only elements into a live element map (local wins per id).
// Call after catching SceneConflictError, then retry the save with freshSha.
export function unionIntoMap(map: Map<string, any>, freshElements: any[] | null | undefined): void {
  if (!freshElements) return;
  for (const el of freshElements) {
    if (el?.id && !map.has(el.id)) map.set(el.id, el);
  }
}

export function allowedRepos(): string[] {
  const list = (process.env.ALLOWED_REPOS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (list.length) return list;
  const cur = currentRepo();
  return cur ? [cur] : [];
}

export function assertRepo(_repo: string): void {

}
function headers(): Record<string, string> {
  return { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'excalidrop', 'Content-Type': 'application/json' };
}
export async function getFile(repo: string, path: string, ref = CANVAS_BRANCH): Promise<{ sha: string; content: any } | null> {
  assertRepo(repo);
  const r = await fetch(`${API}/repos/${repo}/contents/${path}?ref=${ref}`, { headers: headers() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub get ${r.status}: ${await r.text()}`);
  const j = await r.json() as any;
  const text = Buffer.from(j.content, 'base64').toString('utf8');
  return { sha: j.sha, content: JSON.parse(text) };
}

async function ensureBranch(repo: string, branch: string): Promise<void> {
  const has = await fetch(`${API}/repos/${repo}/git/ref/heads/${branch}`, { headers: headers() });
  if (has.ok) return;
  const repoInfo = await (await fetch(`${API}/repos/${repo}`, { headers: headers() })).json() as any;
  const from = repoInfo.default_branch || 'main';
  const ref = await (await fetch(`${API}/repos/${repo}/git/ref/heads/${from}`, { headers: headers() })).json() as any;
  if (!ref.object?.sha) throw new Error(`cannot create ${branch}: no ${from} branch`);
  const mkRef = await fetch(`${API}/repos/${repo}/git/refs`, { method: 'POST', headers: headers(), body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }) });
  if (!mkRef.ok) throw new Error(`cannot create ${branch}: ${(await mkRef.text()).slice(0, 200)}`);
}
export async function putFile(repo: string, path: string, data: any, message: string, branch = CANVAS_BRANCH, sha?: string): Promise<string> {
  assertRepo(repo);
  if (!token()) throw new Error('GITHUB_TOKEN missing');
  const body: any = { message, content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'), branch };
  if (sha) body.sha = sha;
  let r = await fetch(`${API}/repos/${repo}/contents/${path}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  if (r.status === 404) {

    await ensureBranch(repo, branch);
    const existing = await getFile(repo, path, branch).catch(() => null);
    if (existing?.sha) body.sha = existing.sha;
    else delete body.sha;
    r = await fetch(`${API}/repos/${repo}/contents/${path}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  }
  if (r.status === 409) {
    // Someone else committed underneath us. NEVER blindly overwrite with a
    // fresh sha — that silently wipes their work (the 60→1→0 scene wipes).
    // Throw so the caller merges upstream into its live map and retries.
    const fresh = await getFile(repo, path, branch).catch(() => null);
    const freshDoc = fresh?.content as any;
    throw new SceneConflictError(
      fresh?.sha || null,
      Array.isArray(freshDoc?.elements) ? freshDoc.elements : null,
      freshDoc?.files,
    );
  }
  if (r.status === 422 && !sha) {

    const existing = await getFile(repo, path, branch).catch(() => null);
    if (!existing?.sha) throw new Error(`GitHub put 422: ${(await r.text()).slice(0, 200)}`);
    body.sha = existing.sha;
    r = await fetch(`${API}/repos/${repo}/contents/${path}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    if (r.status === 409) {
      const fresh = await getFile(repo, path, branch).catch(() => null);
      const freshDoc = fresh?.content as any;
      throw new SceneConflictError(
        fresh?.sha || null,
        Array.isArray(freshDoc?.elements) ? freshDoc.elements : null,
        freshDoc?.files,
      );
    }
  }
  if (!r.ok) throw new Error(`GitHub put ${r.status}: ${await r.text()}`);
  const j = await r.json() as any;
  logger.info(`Committed ${path}@${branch} in ${repo}`);
  return j.content.sha;
}

export async function loadScene(repo: string): Promise<{ elements: any[]; files: any[]; sha: string | null }> {
  assertRepo(repo);
  const f = await getFile(repo, SCENE_PATH, CANVAS_BRANCH).catch(() => null);
  if (!f) return { elements: [], files: [], sha: null };
  return { elements: f.content.elements || [], files: f.content.files || [], sha: f.sha };
}

export async function saveScene(repo: string, elements: any[], files: any[], sha: string | null, msg: string): Promise<string> {
  return putFile(repo, SCENE_PATH, { type: 'excalidraw', version: 2, source: 'excalidrop', elements, files: files || {} }, msg, CANVAS_BRANCH, sha || undefined);
}

export async function syncPages(repo: string, scene: any): Promise<void> {
  // SETUP-TIME ONLY — never call from autosync/commit hot paths.
  // Saves are pure Contents-API PUTs; the viewer is deployed ONCE by the
  // Actions workflow and reads the scene from the git blob at runtime.
  assertRepo(repo);
  if (!token()) throw new Error('GITHUB_TOKEN missing');
  // The scene file is written to CANVAS_BRANCH by saveScene/putFile and the
  // viewer reads it straight from the git blob — no per-save mirroring, no
  // Pages config, no build requests on the hot path (setup covers those once).
  // Only make sure the Pages branch actually serves the viewer. Without
  // index.html GitHub falls back to Jekyll-rendering the README.
  await ensureViewer(repo, scene);
}

function normalizeSceneDoc(scene: any): { type: string; version: number; source: string; elements: any[]; files?: unknown } {
  const elements = Array.isArray(scene) ? scene : (scene?.elements || []);
  return { type: 'excalidraw', version: 2, source: 'excalidrop', ...(Array.isArray(scene) ? {} : scene), elements };
}

async function branchFileSha(repo: string, branch: string, filePath: string): Promise<string | null> {
  const r = await fetch(`${API}/repos/${repo}/contents/${filePath}?ref=${branch}`, { headers: headers() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub get ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as any).sha as string;
}

// Create or update a single JSON/text file via the Contents API.
async function putContentsFile(repo: string, branch: string, filePath: string, data: unknown, message: string): Promise<void> {
  const content = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2)).toString('base64');
  const body: any = { message, content, branch };
  const sha = await branchFileSha(repo, branch, filePath).catch(() => null);
  if (sha) body.sha = sha;
  const r = await fetch(`${API}/repos/${repo}/contents/${filePath}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  if (r.status === 404) {
    await ensureBranch(repo, branch);
    const retry = await fetch(`${API}/repos/${repo}/contents/${filePath}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    if (!retry.ok) throw new Error(`GitHub put ${retry.status}: ${(await retry.text()).slice(0, 200)}`);
    return;
  }
  if (!r.ok) throw new Error(`GitHub put ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

function resolveFrontendDir(): string | null {
  if (process.env.FRONTEND_DIST && fs.existsSync(path.join(process.env.FRONTEND_DIST, 'index.html'))) {
    return process.env.FRONTEND_DIST;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const cand of [path.join(here, '../frontend'), path.join(here, '../../dist/frontend')]) {
    if (fs.existsSync(path.join(cand, 'index.html'))) return cand;
  }
  return null;
}

function listFilesRecursive(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

async function mapPool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  }));
  return out;
}

async function gitApi(pathname: string, method: string, body?: unknown): Promise<any> {
  const r = await fetch(`${API}${pathname}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${pathname} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  if (r.status === 204) return null;
  return r.json();
}

// Deploy the viewer (local dist/frontend + .nojekyll + scene) to the Pages
// branch as a single commit via the Git Data API. One-time per repo; callers
// only reach this when index.html is absent there. Exported so existing repos
// can pick up viewer upgrades (e.g. after `npm update excalidrop`).
export async function deployViewer(repo: string, scene: unknown): Promise<void> {
  const dir = resolveFrontendDir();
  if (!dir) throw new Error('Viewer not published and no local dist/frontend found — run `npx excalidrop publish` (or `setup`) in the excalidrop checkout first.');
  // The Git Data API rejects blob creation on repos with zero commits.
  await ensureMainBranch(repo);
  const files = listFilesRecursive(dir);
  logger.info(`Deploying viewer to ${repo}@${PAGES_BRANCH} (${files.length} files)…`);
  const blobs = await mapPool(files, 8, async (rel) => {
    const content = fs.readFileSync(path.join(dir, rel)).toString('base64');
    const b = await gitApi(`/repos/${repo}/git/blobs`, 'POST', { content, encoding: 'base64' });
    return { path: rel.split(path.sep).join('/'), mode: '100644', type: 'blob', sha: b.sha };
  });
  // .nojekyll disables Jekyll so Pages serves the Vite SPA as-is.
  const empty = await gitApi(`/repos/${repo}/git/blobs`, 'POST', { content: '', encoding: 'base64' }).catch(() => null);
  const sceneDoc = normalizeSceneDoc(scene);
  const sceneBlob = await gitApi(`/repos/${repo}/git/blobs`, 'POST', {
    content: Buffer.from(JSON.stringify(sceneDoc, null, 2)).toString('base64'),
    encoding: 'base64',
  });
  const tree: any[] = [
    ...blobs,
    ...(empty ? [{ path: '.nojekyll', mode: '100644', type: 'blob', sha: empty.sha }] : []),
    { path: SCENE_PATH, mode: '100644', type: 'blob', sha: sceneBlob.sha },
  ];
  let baseSha: string | null = null;
  let baseTree: string | null = null;
  try {
    const ref = await gitApi(`/repos/${repo}/git/ref/heads/${PAGES_BRANCH}`, 'GET');
    baseSha = ref.object.sha;
    baseTree = (await gitApi(`/repos/${repo}/git/commits/${baseSha}`, 'GET')).tree.sha;
  } catch { /* branch does not exist yet — root commit */ }
  const newTree = await gitApi(`/repos/${repo}/git/trees`, 'POST', {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree,
  });
  const commit = await gitApi(`/repos/${repo}/git/commits`, 'POST', {
    message: 'excalidrop: publish viewer',
    tree: newTree.sha,
    ...(baseSha ? { parents: [baseSha] } : { parents: [] }),
  });
  if (baseSha) {
    await gitApi(`/repos/${repo}/git/refs/heads/${PAGES_BRANCH}`, 'PATCH', { sha: commit.sha, force: true });
  } else {
    await gitApi(`/repos/${repo}/git/refs`, 'POST', { ref: `refs/heads/${PAGES_BRANCH}`, sha: commit.sha });
  }
  await requestPagesBuild(repo);
  logger.info(`Viewer live (pending Pages build): https://${repo.replace('/', '.github.io/')}/`);
}

async function ensureViewer(repo: string, scene: unknown): Promise<void> {
  const hasIndex = await branchFileSha(repo, PAGES_BRANCH, 'index.html').catch(() => null);
  if (hasIndex) {
    // Viewer present — just make sure Jekyll stays off.
    const hasNoJekyll = await branchFileSha(repo, PAGES_BRANCH, '.nojekyll').catch(() => null);
    if (!hasNoJekyll) {
      try {
        await putContentsFile(repo, PAGES_BRANCH, '.nojekyll', '', 'excalidrop: disable Jekyll for SPA');
      } catch (e) { logger.warn('could not add .nojekyll: ' + (e as Error).message); }
    }
    return;
  }
  // No viewer on the Pages branch — deploy it now (one-time per repo),
  // including the current scene so the canvas is never empty.
  await deployViewer(repo, scene);
}

export async function ensureMainBranch(repo: string): Promise<void> {
  assertRepo(repo);
  if (!token()) throw new Error('GITHUB_TOKEN missing');
  
  // Check if main branch exists
  const mainCheck = await fetch(`${API}/repos/${repo}/git/ref/heads/main`, { headers: headers() });
  if (mainCheck.ok) return; // main branch already exists
  
  // Check if repository is completely empty (no branches at all)
  const branches = await fetch(`${API}/repos/${repo}/branches`, { headers: headers() });
  const branchList = await branches.json() as any[];
  
  if (branchList.length === 0) {
    // Repository is empty, create initial commit with README using Contents API
    const readme = `# ${repo.split('/')[1]}\n\nExcalidraw canvas powered by [excalidrop](https://github.com/wtf403/excalidrop).\n\nView canvas: https://${repo.replace('/', '.github.io/')}/\n`;
    
    const createRes = await fetch(`${API}/repos/${repo}/contents/README.md`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        message: 'Initial commit',
        content: Buffer.from(readme).toString('base64'),
        branch: 'main'
      })
    });
    
    if (!createRes.ok) {
      const error = await createRes.text();
      throw new Error(`Failed to create main branch: ${error}`);
    }
    logger.info(`Created main branch with README.md for ${repo}`);
  }
}

export async function configureGitHubPages(repo: string, branch: string = PAGES_BRANCH): Promise<void> {
  assertRepo(repo);
  if (!token()) throw new Error('GITHUB_TOKEN missing');

  try {
    const cur = await fetch(`${API}/repos/${repo}/pages`, { headers: headers() });
    if (cur.ok && ((await cur.json()) as any)?.source?.branch === branch) return; // already serving it — pushes trigger builds
  } catch { /* fall through to update/create */ }

  // Try to update existing GitHub Pages config
  const update = await fetch(`${API}/repos/${repo}/pages`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ source: { branch, path: '/' } })
  });

  if (update.ok) {
    logger.info(`GitHub Pages configured to use ${branch} branch`);
    await requestPagesBuild(repo); // source switches don't reliably queue a build on their own
    return;
  }

  // If update fails, try to create
  const create = await fetch(`${API}/repos/${repo}/pages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ source: { branch, path: '/' } })
  });

  if (create.ok || create.status === 409) {
    logger.info(`GitHub Pages enabled on ${branch} branch`);
  } else {
    logger.warn(`Could not configure GitHub Pages: ${create.status}`);
  }
}

// Commits created via the API don't reliably queue a Pages build (unlike pushes),
// so request one explicitly after operations that change what Pages should serve.
// Best effort: a 409 (build already queued) or missing Pages is fine.
async function requestPagesBuild(repo: string): Promise<void> {
  try {
    const r = await fetch(`${API}/repos/${repo}/pages/builds`, { method: 'POST', headers: headers() });
    if (!r.ok && r.status !== 409) logger.warn(`Pages build request → ${r.status}`);
  } catch (e) { logger.warn('Pages build request failed: ' + (e as Error).message); }
}

export async function updateRepoMetadata(repo: string, updates: { description?: string; homepage?: string }): Promise<void> {
  assertRepo(repo);
  if (!token()) throw new Error('GITHUB_TOKEN missing');
  const r = await fetch(`${API}/repos/${repo}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(updates) });
  if (!r.ok) throw new Error(`GitHub PATCH ${r.status}: ${await r.text()}`);
  logger.info(`Updated metadata for ${repo}`);
}

export async function ensureRepoMetadata(repo: string, homepage: string): Promise<void> {
  assertRepo(repo);
  if (!token()) throw new Error('GITHUB_TOKEN missing');
  const r = await fetch(`${API}/repos/${repo}`, { headers: headers() });
  if (!r.ok) throw new Error(`GitHub GET ${r.status}: ${await r.text()}`);
  const data = await r.json() as any;
  if (!data.homepage || data.homepage.trim() === '') {
    await updateRepoMetadata(repo, { homepage });
  }
}
