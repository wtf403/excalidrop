/** GitHub as source of truth. Scene = canvas.excalidraw on main; viewer copy on gh-pages. No Actions. */
import logger from './logger.js';
import { execSync } from 'node:child_process';

const API = 'https://api.github.com';
/** Zero-config: GITHUB_TOKEN env, else `gh auth token`, else '' (public reads still work). */
export function token(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
/** Zero-config: current repo from git remote. Empty allowlist = current repo only. */
export function currentRepo(): string {
  try {
    const url = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
    return (m?.[1] || '').toLowerCase();
  } catch { return ''; }
}
export const SCENE_PATH = process.env.SCENE_PATH || 'canvas.excalidraw';

export function allowedRepos(): string[] {
  const list = (process.env.ALLOWED_REPOS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (list.length) return list;
  const cur = currentRepo();
  return cur ? [cur] : [];
}
/** Legacy allowlist hook (hosted multi-tenant remote only). Local MCP paths do not
 *  gate on it: the user's own token + GitHub's API enforcement is the real
 *  gate, and any user must be able to work on any repo they can access. */
export function assertRepo(_repo: string): void {
  // intentionally no-op — see above
}
function headers(): Record<string, string> {
  return { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'excalidrop', 'Content-Type': 'application/json' };
}
export async function getFile(repo: string, path: string, ref = 'main'): Promise<{ sha: string; content: any } | null> {
  assertRepo(repo);
  const r = await fetch(`${API}/repos/${repo}/contents/${path}?ref=${ref}`, { headers: headers() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub get ${r.status}: ${await r.text()}`);
  const j = await r.json() as any;
  const text = Buffer.from(j.content, 'base64').toString('utf8');
  return { sha: j.sha, content: JSON.parse(text) };
}
export async function putFile(repo: string, path: string, data: any, message: string, branch = 'main', sha?: string): Promise<string> {
  assertRepo(repo);
  if (!token()) throw new Error('GITHUB_TOKEN missing');
  const body: any = { message, content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'), branch };
  if (sha) body.sha = sha;
  let r = await fetch(`${API}/repos/${repo}/contents/${path}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  if (r.status === 404 && branch === 'main') {
    // 404 on PUT usually means the branch doesn't exist yet (empty repo —
    // GitHub says plain "Not Found", not "branch missing"). Fork main off
    // gh-pages (or the default branch) then retry.
    const branchExists = await fetch(`${API}/repos/${repo}/git/ref/heads/main`, { headers: headers() });
    if (branchExists.ok) throw new Error(`GitHub put 404: ${await r.text()}`.slice(0, 200));
    const repoInfo = await (await fetch(`${API}/repos/${repo}`, { headers: headers() })).json() as any;
    const from = repoInfo.default_branch && repoInfo.default_branch !== 'main' ? repoInfo.default_branch : 'gh-pages';
    const ref = await (await fetch(`${API}/repos/${repo}/git/ref/heads/${from}`, { headers: headers() })).json() as any;
    if (!ref.object?.sha) throw new Error(`cannot bootstrap main: no ${from} branch`);
    const mkRef = await fetch(`${API}/repos/${repo}/git/refs`, { method: 'POST', headers: headers(), body: JSON.stringify({ ref: 'refs/heads/main', sha: ref.object.sha }) });
    if (!mkRef.ok) throw new Error(`cannot bootstrap main: ${(await mkRef.text()).slice(0, 200)}`);
    // main bootstrapped from another branch may already contain the file — attach its sha
    const existing = await (await fetch(`${API}/repos/${repo}/contents/${path}?ref=main`, { headers: headers() })).json() as any;
    if (existing.sha) body.sha = existing.sha;
    r = await fetch(`${API}/repos/${repo}/contents/${path}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  }
  if (r.status === 409) throw new Error('CONFLICT: file changed upstream, refetch sha and retry');
  if (!r.ok) throw new Error(`GitHub put ${r.status}: ${await r.text()}`);
  const j = await r.json() as any;
  logger.info(`Committed ${path}@${branch} in ${repo}`);
  return j.content.sha;
}
/** Load scene with sha for optimistic concurrency. */
export async function loadScene(repo: string): Promise<{ elements: any[]; files: any[]; sha: string | null }> {
  assertRepo(repo);
  const f = await getFile(repo, SCENE_PATH, 'main').catch(() => null);
  if (!f) return { elements: [], files: [], sha: null };
  return { elements: f.content.elements || [], files: f.content.files || [], sha: f.sha };
}
/** Save scene to main (1 commit per batch). Returns new sha. */
export async function saveScene(repo: string, elements: any[], files: any[], sha: string | null, msg: string): Promise<string> {
  return putFile(repo, SCENE_PATH, { type: 'excalidraw', version: 2, source: 'excalidrop', elements, files: {} , _files: files }, msg, 'main', sha || undefined);
}
/** Sync prebuilt viewer + scene copy straight to gh-pages branch (direct push via Contents API, no Actions). */
export async function syncPages(repo: string, scene: any): Promise<void> {
  assertRepo(repo);
  // scene copy (viewer reads same-branch file: instant, no raw cache)
  const cur = await getFile(repo, SCENE_PATH, 'gh-pages').catch(() => null);
  await putFile(repo, SCENE_PATH, scene, 'excalidrop: sync scene to gh-pages', 'gh-pages', cur?.sha);
}
