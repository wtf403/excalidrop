
import logger from './logger.js';
import { execSync } from 'node:child_process';

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

export const CANVAS_BRANCH = process.env.CANVAS_BRANCH || 'excalidrop';

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
  if (r.status === 409) throw new Error('CONFLICT: file changed upstream, refetch sha and retry');
  if (r.status === 422 && !sha) {

    const existing = await getFile(repo, path, branch).catch(() => null);
    if (!existing?.sha) throw new Error(`GitHub put 422: ${(await r.text()).slice(0, 200)}`);
    body.sha = existing.sha;
    r = await fetch(`${API}/repos/${repo}/contents/${path}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    if (r.status === 409) throw new Error('CONFLICT: file changed upstream, refetch sha and retry');
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

export async function syncPages(_repo: string, _scene: any): Promise<void> {

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
  if (!data.description || data.description.trim() === '') {
    await updateRepoMetadata(repo, { description: homepage, homepage });
  } else if (!data.homepage || data.homepage.trim() === '') {
    await updateRepoMetadata(repo, { homepage });
  }
}
