
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import logger from './utils/logger.js';
import { generateId, ServerElement } from './types.js';

export type Target = { kind: 'local' } | { kind: 'remote'; repo: string };
let active: Target = { kind: 'local' };
export const getTarget = (): Target => active;


export const APP_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || 'Iv23liuS2fx3QOEIoDmx';

const CONFIG_NAME = '.excalidrop.json';

function findConfigDir(): string | null {
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (true) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_NAME), 'utf8'));
      if (raw && typeof raw === 'object') return dir;
    } catch { /* keep walking */ }
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

function persistTarget(repo: string | null): void {
  const dir = findConfigDir();
  if (!dir) return;
  try {
    const file = path.join(dir, CONFIG_NAME);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (repo) raw.remote = repo; else delete raw.remote;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  } catch (e) { logger.warn('could not persist remote target: ' + (e as Error).message); }
}

export function loadSavedTarget(): string | null {
  const dir = findConfigDir();
  if (!dir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_NAME), 'utf8'));
    return typeof raw.remote === 'string' ? raw.remote : null;
  } catch { return null; }
}

const TOKEN_FILE = path.join(os.homedir(), '.config', 'excalidrop', 'gh_token');
export function resolveToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const t = execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (t) return t;
  } catch { /* no gh */ }
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch { /* no stored token */ }
  return '';
}
export function storeToken(t: string): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
}


export function parseRepo(input: string): string {
  const s = input.trim().replace(/\/$/, '');
  const m = s.match(/^https?:\/\/([a-z0-9-]+)\.github\.io\/([a-z0-9_.-]+)/i);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(s)) return s.toLowerCase();
  throw new Error(`Cannot parse repo from "${input}" — use owner/repo or a *.github.io/<repo> URL`);
}


const scenes = new Map<string, { elements: Map<string, ServerElement>; files: any[]; sha: string | null; dirty: boolean }>();
let timer: ReturnType<typeof setTimeout> | null = null;
const SCENE_PATH = process.env.SCENE_PATH || 'canvas.excalidraw';

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${resolveToken()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'excalidrop', 'Content-Type': 'application/json' };
}

export async function switchRemote(input?: string): Promise<{ target: Target; elements: number }> {
  if (!input) { active = { kind: 'local' }; persistTarget(null); return { target: active, elements: 0 }; }
  const repo = parseRepo(input);
  active = { kind: 'remote', repo };
  const st = await ensureLoaded(repo);
  persistTarget(repo);
  return { target: active, elements: st.elements.size };
}

async function ensureLoaded(repo: string) {
  let st = scenes.get(repo);
  if (st) return st;
  const tok = resolveToken();
  if (!tok) throw new Error('No GitHub token. Run github_login or `gh auth login` first.');
  const gh = await import('./utils/github.js');
  
  // Ensure main branch exists first
  await gh.ensureMainBranch(repo);
  
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${SCENE_PATH}?ref=${gh.CANVAS_BRANCH}`, { headers: headers(), signal: AbortSignal.timeout(20000) });
  st = { elements: new Map(), files: [], sha: null, dirty: false };
  if (r.ok) {
    const j = await r.json() as any;
    const doc = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    for (const el of doc.elements || []) st.elements.set(el.id, el);
    st.files = Array.isArray(doc.files) ? doc.files : (doc.files ? [doc.files] : []);
    st.sha = j.sha;
  }
  scenes.set(repo, st);
  return st;
}

function current(): { elements: Map<string, ServerElement>; files: any[]; sha: string | null; dirty: boolean } {
  if (active.kind !== 'remote') throw new Error('not in remote mode');
  const st = scenes.get(active.repo);
  if (!st) throw new Error('call switch_remote first');
  return st;
}

function scheduleCommit(): void {
  if (active.kind !== 'remote') return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void commitNow('excalidrop: autosync from MCP'); }, 10000);
}

export async function commitNow(message?: string): Promise<{ sha: string; count: number }> {
  if (active.kind !== 'remote') throw new Error('not in remote mode');
  const repo = active.repo;
  const st = current();
  const gh = await import('./utils/github.js');
  // Hot path is a single Contents-API PUT — nothing else per save.
  // The viewer is deployed ONCE via the Actions workflow installed by
  // `setup`/`publish`, and reads canvas.excalidraw straight from the git
  // blob at runtime. Never trigger Pages builds or viewer redeploys here,
  // otherwise every autosync queues a "pages build and deployment" run.
  const buildDoc = () => ({
    type: 'excalidraw', version: 2, source: 'excalidrop',
    elements: Array.from(st.elements.values()),
    ...(st.files?.length ? { files: st.files } : {}),
  });
  const msg = () => message || `excalidrop: update ${st.elements.size} elements`;
  try {
    st.sha = await gh.putFile(repo, SCENE_PATH, buildDoc(), msg(), gh.CANVAS_BRANCH, st.sha || undefined);
  } catch (e) {
    // Someone else committed underneath us: fold their elements into the live
    // map (ours win per id) and retry once, so the save ADDS our changes to
    // canvas.excalidraw instead of wiping theirs.
    if (!(e instanceof gh.SceneConflictError)) throw e;
    gh.unionIntoMap(st.elements, e.freshElements);
    if ((!st.files || st.files.length === 0) && e.freshFiles) {
      st.files = Array.isArray(e.freshFiles) ? e.freshFiles : [e.freshFiles];
    }
    st.sha = e.freshSha;
    st.sha = await gh.putFile(repo, SCENE_PATH, buildDoc(), msg(), gh.CANVAS_BRANCH, st.sha || undefined);
  }
  st.dirty = false;
  logger.info(`Committed ${st.elements.size} elements to ${repo}`);
  return { sha: st.sha as string, count: st.elements.size };
}


export function rAddFile(file: any): any {
  const st = current();
  st.files.push(file); st.dirty = true; scheduleCommit();
  return file;
}
export function rCreate(el: ServerElement): ServerElement {
  const st = current();
  const full = { ...el, id: el.id || generateId() };
  st.elements.set(full.id, full); st.dirty = true; scheduleCommit();
  return full;
}
export function rBatch(els: ServerElement[]): ServerElement[] { return els.map(rCreate); }
export function rUpdate(id: string, updates: Partial<ServerElement>): ServerElement {
  const st = current();
  const cur = st.elements.get(id);
  if (!cur) throw new Error(`Element ${id} not found`);
  const u = { ...cur, ...updates };
  st.elements.set(id, u); st.dirty = true; scheduleCommit();
  return u;
}
export function rDelete(id: string): void { const st = current(); st.elements.delete(id); st.dirty = true; scheduleCommit(); }
export function rGet(id: string): ServerElement | null { return current().elements.get(id) || null; }
export function rList(type?: string): ServerElement[] {
  return Array.from(current().elements.values()).filter(e => !type || e.type === type);
}
export function rClear(): number { const st = current(); const n = st.elements.size; st.elements.clear(); st.dirty = true; scheduleCommit(); return n; }
export const isRemote = (): boolean => active.kind === 'remote';


export async function deviceStart(clientId: string): Promise<{ user_code: string; verification_uri: string; device_code: string; interval: number }> {
  const r = await fetch('https://github.com/login/device/code', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!r.ok) throw new Error('device flow start failed');
  return r.json() as any;
}
export async function repoId(owner: string, repo: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'excalidrop' } });
    if (!r.ok) return null;
    return ((await r.json()) as any).id ?? null;
  } catch { return null; }
}
export async function devicePoll(clientId: string, deviceCode: string, intervalSec: number, timeoutSec = 300, repositoryId?: number): Promise<string> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalSec * 1000));
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', ...(repositoryId ? { repository_id: repositoryId } : {}) }),
    });
    const j = await r.json() as any;
    if (j.access_token) { storeToken(j.access_token); return j.access_token; }
    if (j.error && j.error !== 'authorization_pending' && j.error !== 'slow_down') throw new Error(j.error_description || j.error);
  }
  throw new Error('device login timed out');
}
