#!/usr/bin/env node

// excalidrop MCP server — single file, remote-only (GitHub is the canvas).
// Usage: npx -y excalidrop@latest mcp --repo owner/repo

process.env.NODE_DISABLE_COLORS = '1';
process.env.NO_COLOR = '1';

import { execSync } from 'node:child_process';
import { deflateSync } from 'zlib';
import { webcrypto } from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolRequest,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

// MCP must never write stdout — file + stderr only.
const LOG_FILE = process.env.LOG_FILE_PATH || path.join(os.tmpdir(), 'excalidrop-mcp.log');
function log(level: string, msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
  if (level === 'warn' || level === 'error') process.stderr.write(line);
}

type ExcalidrawElementType = 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'text' | 'line' | 'freedraw' | 'image';
const EXCALIDRAW_ELEMENT_TYPES = {
  RECTANGLE: 'rectangle', ELLIPSE: 'ellipse', DIAMOND: 'diamond', ARROW: 'arrow',
  TEXT: 'text', FREEDRAW: 'freedraw', LINE: 'line', IMAGE: 'image',
} as const;

interface ServerElement {
  id: string;
  type: ExcalidrawElementType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  [key: string]: any;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function normalizeFontFamily(ff: string | number | undefined): number | undefined {
  if (ff === undefined) return undefined;
  if (typeof ff === 'number') return ff;
  const map: Record<string, number> = {
    virgil: 1, hand: 1, handwritten: 1, helvetica: 2, sans: 2, 'sans-serif': 2,
    cascadia: 3, mono: 3, monospace: 3, excalifont: 5, nunito: 6,
    lilita: 7, 'lilita one': 7, 'comic shanns': 8, comic: 8,
    '1': 1, '2': 2, '3': 3, '5': 5, '6': 6, '7': 7, '8': 8,
  };
  return map[ff.toLowerCase()];
}

const APP_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || 'Iv23liuS2fx3QOEIoDmx';
const RELAY_URL = process.env.EXCALIDROP_RELAY_URL || 'https://excalidrop.wtf403.workers.dev';
const CONFIG_NAME = '.excalidrop.json';
const TOKEN_FILE = path.join(os.homedir(), '.config', 'excalidrop', 'gh_token');
const SCENE_PATH = process.env.SCENE_PATH || 'canvas.excalidraw';
const CANVAS_BRANCH = process.env.CANVAS_BRANCH || 'excalidrop';

function resolveToken(): string {
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

function storeToken(t: string): void {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
}

function detectSlug(): string {
  try {
    const url = execSync('git config --get remote.origin.url', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/\.git$/, '');
    return url.match(/github\.com[:/](.+)/)?.[1]?.toLowerCase() || '';
  } catch { return ''; }
}

function parseRepo(input: string): string {
  const s = input.trim().replace(/\/$/, '');
  const m = s.match(/^https?:\/\/([a-z0-9-]+)\.github\.io\/([a-z0-9_.-]+)/i);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(s)) return s.toLowerCase();
  throw new Error(`Cannot parse repo from "${input}" — use owner/repo`);
}

function parseRepoFlag(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--repo='));
  if (!arg) return null;
  try { return parseRepo(arg.split('=').slice(1).join('=')); } catch { return null; }
}

function readConfig(): { remote?: string } {
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (true) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_NAME), 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    } catch { /* keep walking */ }
    if (dir === root) return {};
    dir = path.dirname(dir);
  }
}

function loadSavedRepo(): string | null {
  const flag = parseRepoFlag();
  if (flag) return flag;
  if (process.env.EXCALIDROP_REPO) {
    try { return parseRepo(process.env.EXCALIDROP_REPO); } catch { /* fall through */ }
  }
  return readConfig().remote || detectSlug() || null;
}

function persistRepo(repo: string): void {
  let dir = process.cwd();
  const root = path.parse(dir).root;
  while (true) {
    try {
      const file = path.join(dir, CONFIG_NAME);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        fs.writeFileSync(file, JSON.stringify({ ...raw, remote: repo }, null, 2) + '\n');
        return;
      }
    } catch { /* keep walking */ }
    if (dir === root) return;
    dir = path.dirname(dir);
  }
}

const GH_API = 'https://api.github.com';

class SceneConflictError extends Error {
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

function ghHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${resolveToken()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'excalidrop', 'Content-Type': 'application/json' };
}

async function getFile(repo: string, filePath: string, ref = CANVAS_BRANCH): Promise<{ sha: string; content: any } | null> {
  const r = await fetch(`${GH_API}/repos/${repo}/contents/${filePath}?ref=${ref}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub get ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json() as any;
  // Contents API omits `content` for files >1MB — fall back to the blob API.
  let b64: string | null = typeof j.content === 'string' && j.content.length ? j.content : null;
  if (!b64) {
    const blob = await fetch(`${GH_API}/repos/${repo}/git/blobs/${j.sha}`, { headers: ghHeaders() });
    if (!blob.ok) throw new Error(`GitHub blob ${blob.status}: ${(await blob.text()).slice(0, 200)}`);
    b64 = ((await blob.json()) as any).content || null;
  }
  if (!b64) throw new Error(`GitHub get: ${filePath} returned no content`);
  return { sha: j.sha, content: JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) };
}

async function ensureBranch(repo: string, branch: string): Promise<void> {
  const has = await fetch(`${GH_API}/repos/${repo}/git/ref/heads/${branch}`, { headers: ghHeaders() });
  if (has.ok) return;
  const repoInfo = await (await fetch(`${GH_API}/repos/${repo}`, { headers: ghHeaders() })).json() as any;
  const from = repoInfo.default_branch || 'main';
  const ref = await (await fetch(`${GH_API}/repos/${repo}/git/ref/heads/${from}`, { headers: ghHeaders() })).json() as any;
  if (!ref.object?.sha) throw new Error(`cannot create ${branch}: no ${from} branch`);
  const mk = await fetch(`${GH_API}/repos/${repo}/git/refs`, { method: 'POST', headers: ghHeaders(), body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }) });
  if (!mk.ok) throw new Error(`cannot create ${branch}: ${(await mk.text()).slice(0, 200)}`);
}

async function putFile(repo: string, filePath: string, data: any, message: string, branch = CANVAS_BRANCH, sha?: string): Promise<string> {
  if (!resolveToken()) throw new Error('No GitHub token. Run `gh auth login` or `npx excalidrop login` first.');
  const body: any = { message, content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'), branch };
  if (sha) body.sha = sha;
  const attempt = () => fetch(`${GH_API}/repos/${repo}/contents/${filePath}`, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  let r = await attempt();
  if (r.status === 404) {
    await ensureBranch(repo, branch);
    const existing = await getFile(repo, filePath, branch).catch(() => null);
    if (existing?.sha) body.sha = existing.sha; else delete body.sha;
    r = await attempt();
  }
  if (r.status === 409 || (r.status === 422 && !sha)) {
    if (r.status === 422) {
      const existing = await getFile(repo, filePath, branch).catch(() => null);
      if (!existing?.sha) throw new Error(`GitHub put 422: ${(await r.text()).slice(0, 200)}`);
      body.sha = existing.sha;
      r = await attempt();
    }
    if (r.status === 409) {
      const fresh = await getFile(repo, filePath, branch).catch(() => null);
      const doc = fresh?.content as any;
      throw new SceneConflictError(fresh?.sha || null, Array.isArray(doc?.elements) ? doc.elements : null, doc?.files);
    }
  }
  if (!r.ok) throw new Error(`GitHub put ${r.status}: ${(await r.text()).slice(0, 200)}`);
  log('info', `Committed ${filePath}@${branch} in ${repo}`);
  return ((await r.json()) as any).content.sha;
}

function unionIntoMap(map: Map<string, any>, fresh: any[] | null | undefined): void {
  if (!fresh) return;
  for (const el of fresh) if (el?.id && !map.has(el.id)) map.set(el.id, el);
}

const syncedAssetIds = new Set<string>();
async function syncAssets(repo: string, files: any): Promise<void> {
  if (!resolveToken()) return;
  const list: any[] = Array.isArray(files) ? files : Object.values((files as any) || {});
  const withData = list.filter((f) => f?.id && typeof f?.dataURL === 'string' && f.dataURL.startsWith('data:'));
  if (!withData.length) return;
  await Promise.all(withData.map(async (f) => {
    try {
      if (syncedAssetIds.has(f.id)) return;
      const m = /^data:([^;]+);base64,(.+)$/s.exec(f.dataURL);
      if (!m) return;
      const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' } as Record<string, string>)[f.mimeType || m[1]] || 'png';
      const assetPath = `assets/${f.id}.${ext}`;
      const head = await fetch(`${GH_API}/repos/${repo}/contents/${assetPath}?ref=${CANVAS_BRANCH}`, { headers: ghHeaders() });
      if (head.ok) { syncedAssetIds.add(f.id); return; }
      if (head.status !== 404) throw new Error(`asset check ${head.status}`);
      const r = await fetch(`${GH_API}/repos/${repo}/contents/${assetPath}`, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify({ message: `excalidrop: add image asset ${f.id}`, content: m[2], branch: CANVAS_BRANCH }) });
      if (!r.ok) throw new Error(`asset put ${r.status}`);
      syncedAssetIds.add(f.id);
    } catch (e) { log('warn', 'asset sync failed: ' + (e as Error).message); }
  }));
}

async function ensureMainBranch(repo: string): Promise<void> {
  if (!resolveToken()) throw new Error('GITHUB_TOKEN missing');
  const main = await fetch(`${GH_API}/repos/${repo}/git/ref/heads/main`, { headers: ghHeaders() });
  if (main.ok) return;
  const branches = await (await fetch(`${GH_API}/repos/${repo}/branches`, { headers: ghHeaders() })).json() as any[];
  if (branches.length !== 0) return;
  const r = await fetch(`${GH_API}/repos/${repo}/contents/README.md`, {
    method: 'PUT', headers: ghHeaders(),
    body: JSON.stringify({ message: 'Initial commit', content: Buffer.from('').toString('base64'), branch: 'main' }),
  });
  if (!r.ok) throw new Error(`Failed to create main branch: ${await r.text()}`);
}

const scenes = new Map<string, { elements: Map<string, ServerElement>; files: any[]; sha: string | null }>();
let activeRepo: string | null = null;
let commitTimer: ReturnType<typeof setTimeout> | null = null;

async function ensureLoaded(repo: string) {
  let st = scenes.get(repo);
  if (st) return st;
  if (!resolveToken()) throw new Error('No GitHub token. Run github_login or `gh auth login` first.');
  await ensureMainBranch(repo);
  st = { elements: new Map(), files: [], sha: null };
  const f = await getFile(repo, SCENE_PATH, CANVAS_BRANCH).catch(() => null);
  if (f) {
    const doc = f.content as any;
    for (const el of doc.elements || []) st.elements.set(el.id, el);
    st.files = Array.isArray(doc.files) ? doc.files : (doc.files ? [doc.files] : []);
    st.sha = f.sha;
  }
  scenes.set(repo, st);
  activeRepo = repo;
  return st;
}

async function ensureActiveRepo(): Promise<string> {
  const repo = activeRepo || loadSavedRepo();
  if (!repo) throw new Error('No repo selected. Run `npx excalidrop setup owner/repo` or pass --repo=owner/repo.');
  await ensureLoaded(repo);
  return repo;
}

function current() {
  const repo = activeRepo || loadSavedRepo();
  if (!repo) throw new Error('call switch_remote first (or pass --repo=owner/repo)');
  const st = scenes.get(repo);
  if (!st) throw new Error('call switch_remote first');
  return { repo, st };
}

function scheduleCommit(): void {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => { void commitNow('excalidrop: autosync from MCP'); }, 10000);
}

async function commitNow(message?: string): Promise<{ sha: string; count: number }> {
  const { repo, st } = current();
  const doc = () => ({
    type: 'excalidraw', version: 2, source: 'excalidrop',
    elements: Array.from(st.elements.values()),
    ...(st.files?.length ? { files: st.files } : {}),
  });
  const msg = message || `excalidrop: update ${st.elements.size} elements`;
  try {
    st.sha = await putFile(repo, SCENE_PATH, doc(), msg, CANVAS_BRANCH, st.sha || undefined);
  } catch (e) {
    if (!(e instanceof SceneConflictError)) throw e;
    unionIntoMap(st.elements, e.freshElements);
    if ((!st.files || st.files.length === 0) && e.freshFiles) {
      st.files = Array.isArray(e.freshFiles) ? e.freshFiles : [e.freshFiles];
    }
    st.sha = e.freshSha;
    st.sha = await putFile(repo, SCENE_PATH, doc(), msg, CANVAS_BRANCH, st.sha || undefined);
  }
  try { await syncAssets(repo, st.files); } catch (e) { log('warn', 'asset sync failed: ' + (e as Error).message); }
  log('info', `Committed ${st.elements.size} elements to ${repo}`);
  return { sha: st.sha as string, count: st.elements.size };
}

function rAddFile(file: any): any { const { st } = current(); st.files.push(file); scheduleCommit(); return file; }
function rCreate(el: ServerElement): ServerElement {
  const { st } = current();
  const full = { ...el, id: el.id || generateId() };
  st.elements.set(full.id, full); scheduleCommit();
  return full;
}
function rBatch(els: ServerElement[]): ServerElement[] { return els.map(rCreate); }
function rUpdate(id: string, updates: Partial<ServerElement>): ServerElement {
  const { st } = current();
  const cur = st.elements.get(id);
  if (!cur) throw new Error(`Element ${id} not found`);
  const u = { ...cur, ...updates };
  st.elements.set(id, u); scheduleCommit();
  return u;
}
function rDelete(id: string): void { const { st } = current(); st.elements.delete(id); scheduleCommit(); }
function rGet(id: string): ServerElement | null { return current().st.elements.get(id) || null; }
function rList(type?: string): ServerElement[] {
  return Array.from(current().st.elements.values()).filter((e) => !type || e.type === type);
}
function rClear(): number { const { st } = current(); const n = st.elements.size; st.elements.clear(); scheduleCommit(); return n; }

const RELAY_BUDGET_PER_DAY = Number(process.env.EXCALIDROP_RELAY_BUDGET || 1000);
let relayCalls = 0;
let relayDay = new Date().toISOString().slice(0, 10);

async function relayRpc(repo: string, method: string, args: any, timeoutMs = 30000): Promise<any> {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== relayDay) { relayDay = day; relayCalls = 0; }
  if (relayCalls >= RELAY_BUDGET_PER_DAY) throw new Error(`Relay daily budget exceeded (${RELAY_BUDGET_PER_DAY}). Use describe_scene first, or raise EXCALIDROP_RELAY_BUDGET.`);
  const token = resolveToken();
  if (!token) throw new Error('No GitHub token. Run `gh auth login` or `npx excalidrop login` first.');
  relayCalls += 1;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${RELAY_URL}/rpc/${repo}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'excalidrop' },
      body: JSON.stringify(args || {}),
      signal: ctl.signal,
    });
    if (r.status === 503) throw new Error(`No viewer connected for ${repo} — open the canvas URL in a browser first.`);
    if (r.status === 403) throw new Error(`No access to ${repo} with this GitHub token.`);
    if (r.status === 429) throw new Error('Relay rate-limited. Wait a minute and retry (use describe_scene first).');
    if (!r.ok) throw new Error(`Relay ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`Relay timed out after ${timeoutMs / 1000}s (is a viewer tab open?)`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function queueRpc(repo: string, method: string, args: any, timeoutMs = 60000): Promise<any> {
  const reqId = generateId();
  await putFile(repo, `commands/${reqId}.json`, { reqId, method, args, createdAt: new Date().toISOString() }, `excalidrop: queue ${method} ${reqId}`, CANVAS_BRANCH);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const res = await getFile(repo, `results/${reqId}.json`, CANVAS_BRANCH).catch(() => null);
    if (res?.content) return res.content;
  }
  throw new Error(`Command ${method} timed out — is a viewer tab open on this repo?`);
}

function useRelay(): boolean {
  return !process.argv.includes('--no-relay') && process.env.EXCALIDROP_NO_RELAY !== '1';
}

async function screenshotRepo(repo: string, opts: { background?: boolean; format?: 'png' | 'svg' } = {}): Promise<{ format: string; data: string }> {
  const args = { background: opts.background ?? true, format: opts.format || 'png' };
  if (useRelay()) {
    try {
      const out = await relayRpc(repo, 'screenshot', args) as any;
      return { format: out.format || 'png', data: out.data };
    } catch (e) { log('warn', 'relay screenshot failed, queue fallback: ' + (e as Error).message); }
  }
  const out = await queueRpc(repo, 'screenshot', args) as any;
  return { format: out.format || 'png', data: out.data };
}

async function viewportRepo(repo: string, args: Record<string, unknown>): Promise<{ success: boolean; message: string }> {
  if (useRelay()) {
    try {
      return await relayRpc(repo, 'viewport', args) as any;
    } catch (e) { log('warn', 'relay viewport failed, queue fallback: ' + (e as Error).message); }
  }
  return queueRpc(repo, 'viewport', args) as any;
}

async function deviceStart(clientId: string) {
  const r = await fetch('https://github.com/login/device/code', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (!r.ok) throw new Error('device flow start failed');
  return r.json() as any;
}

async function repoId(owner: string, repo: string): Promise<number | null> {
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'excalidrop' } });
    if (!r.ok) return null;
    return ((await r.json()) as any).id ?? null;
  } catch { return null; }
}

async function devicePoll(clientId: string, deviceCode: string, intervalSec: number, timeoutSec = 300, repositoryId?: number): Promise<string> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
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

const ALLOWED_EXPORT_DIR = process.env.EXCALIDRAW_EXPORT_DIR || process.cwd();
function sanitizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const allowedDir = path.resolve(ALLOWED_EXPORT_DIR);
  if (!resolved.startsWith(allowedDir + path.sep) && resolved !== allowedDir) {
    throw new Error(`Path traversal blocked: "${filePath}" resolves outside "${allowedDir}". Set EXCALIDRAW_EXPORT_DIR to change it.`);
  }
  return resolved;
}

const groups = new Map<string, string[]>();

const PointSchema = z.union([z.object({ x: z.number(), y: z.number() }), z.tuple([z.number(), z.number()])]);
function normalizePoints(points: Array<{ x: number; y: number } | [number, number]>): [number, number][] {
  return points.map((p) => (Array.isArray(p) ? (p as [number, number]) : ([p.x, p.y] as [number, number])));
}

const ElementSchema = z.object({
  id: z.string().optional(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(), y: z.number(),
  width: z.number().optional(), height: z.number().optional(),
  points: z.array(PointSchema).optional(),
  backgroundColor: z.string().optional(), strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(), roughness: z.number().optional(), opacity: z.number().optional(),
  text: z.string().optional(), fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(), locked: z.boolean().optional(),
  strokeStyle: z.string().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(), elbowed: z.boolean().optional(),
  startElementId: z.string().optional(), endElementId: z.string().optional(),
  endArrowhead: z.string().optional(), startArrowhead: z.string().optional(),
});

const DIAGRAM_DESIGN_GUIDE = `# Excalidraw Diagram Design Guide

## Color Palette

### Stroke Colors (use for borders & text)
| Name    | Hex       | Use for                     |
|---------|-----------|-----------------------------|
| Black   | #1e1e1e   | Default text & borders      |
| Red     | #e03131   | Errors, warnings, critical  |
| Green   | #2f9e44   | Success, approved, healthy  |
| Blue    | #1971c2   | Primary actions, links      |
| Purple  | #9c36b5   | Services, middleware        |
| Orange  | #e8590c   | Async, queues, events       |
| Cyan    | #0c8599   | Data stores, databases      |
| Gray    | #868e96   | Annotations, secondary      |

### Fill Colors (use for backgroundColor — pastel fills)
| Name         | Hex       | Pairs with stroke |
|--------------|-----------|-------------------|
| Light Red    | #ffc9c9   | #e03131           |
| Light Green  | #b2f2bb   | #2f9e44           |
| Light Blue   | #a5d8ff   | #1971c2           |
| Light Purple | #eebefa   | #9c36b5           |
| Light Orange | #ffd8a8   | #e8590c           |
| Light Cyan   | #99e9f2   | #0c8599           |
| Light Gray   | #e9ecef   | #868e96           |
| White        | #ffffff   | #1e1e1e           |

## Sizing Rules

- **Minimum shape size**: width >= 120px, height >= 60px
- **Font sizes**: body text >= 16, titles/headers >= 20, small labels >= 14
- **Padding**: leave at least 20px inside shapes for text breathing room
- **Arrow length**: minimum 80px between connected shapes
- **Consistent sizing**: keep same-role shapes identical dimensions

## Layout Patterns

- **Grid snap**: align to 20px grid for clean layouts
- **Spacing**: 40–80px gap between adjacent shapes
- **Flow direction**: top-to-bottom (vertical) or left-to-right (horizontal)
- **Hierarchy**: important nodes larger or higher; left-to-right = temporal order
- **Grouping**: cluster related elements visually; use background rectangles as zones

## Arrow Binding Best Practices

- **Always bind**: use \`startElementId\` / \`endElementId\` to connect arrows to shapes
- **Dashed arrows**: use \`strokeStyle: "dashed"\` for async, optional, or event flows
- **Dotted arrows**: use \`strokeStyle: "dotted"\` for weak dependencies or annotations
- **Arrowheads**: default "arrow" for directed flow; "dot" for data stores; null for lines
- **Label arrows**: set \`text\` on arrows to describe the relationship (e.g., "HTTP", "publishes")

## Anti-Patterns to Avoid

1. **Overlapping elements** — always leave gaps; use distribute_elements
2. **Cramped spacing** — minimum 40px between shapes
3. **Tiny fonts** — never below 14px; prefer 16+
4. **Manual arrow coordinates** — always use startElementId/endElementId binding
5. **Too many colors** — limit to 3–4 fill colors per diagram
6. **Inconsistent sizes** — same-role shapes should be same width/height
7. **No labels** — every shape and meaningful arrow should have text
8. **Flat layouts** — use zones/groups to create visual hierarchy

## Drawing Order (Recommended)

1. **Background zones** — large rectangles with light fill, low opacity
2. **Primary shapes** — services, entities, steps (with labels via \`text\`)
3. **Arrows** — connect shapes using binding IDs
4. **Annotations** — standalone text elements for notes, titles
5. **Refinement** — align, distribute, adjust spacing, screenshot to verify
`;

const TYPES = Object.values(EXCALIDRAW_ELEMENT_TYPES);
const tools: Tool[] = [
  { name: 'create_element', description: 'Create a new element on the remote canvas. For arrows, use startElementId/endElementId to bind to shapes.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: TYPES }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, backgroundColor: { type: 'string' }, strokeColor: { type: 'string' }, strokeWidth: { type: 'number' }, strokeStyle: { type: 'string' }, roughness: { type: 'number' }, opacity: { type: 'number' }, text: { type: 'string' }, fontSize: { type: 'number' }, fontFamily: { type: ['string', 'number'] }, startElementId: { type: 'string' }, endElementId: { type: 'string' }, endArrowhead: { type: 'string' }, startArrowhead: { type: 'string' } }, required: ['type', 'x', 'y'] } },
  { name: 'update_element', description: 'Update an existing element on the remote canvas', inputSchema: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: TYPES }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, backgroundColor: { type: 'string' }, strokeColor: { type: 'string' }, strokeWidth: { type: 'number' }, strokeStyle: { type: 'string' }, roughness: { type: 'number' }, opacity: { type: 'number' }, text: { type: 'string' }, fontSize: { type: 'number' }, fontFamily: { type: ['string', 'number'] } }, required: ['id'] } },
  { name: 'delete_element', description: 'Delete an element from the remote canvas', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'query_elements', description: 'Query elements with optional filters', inputSchema: { type: 'object', properties: { type: { type: 'string', enum: TYPES }, filter: { type: 'object', additionalProperties: true }, bbox: { type: 'object', properties: { x_min: { type: 'number' }, x_max: { type: 'number' }, y_min: { type: 'number' }, y_max: { type: 'number' } } } } } },
  { name: 'get_resource', description: 'Get a canvas resource (scene, elements, library, theme)', inputSchema: { type: 'object', properties: { resource: { type: 'string', enum: ['scene', 'library', 'theme', 'elements'] } }, required: ['resource'] } },
  { name: 'group_elements', description: 'Group multiple elements together', inputSchema: { type: 'object', properties: { elementIds: { type: 'array', items: { type: 'string' } } }, required: ['elementIds'] } },
  { name: 'ungroup_elements', description: 'Ungroup a group of elements', inputSchema: { type: 'object', properties: { groupId: { type: 'string' } }, required: ['groupId'] } },
  { name: 'align_elements', description: 'Align elements to a specific position', inputSchema: { type: 'object', properties: { elementIds: { type: 'array', items: { type: 'string' } }, alignment: { type: 'string', enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'] } }, required: ['elementIds', 'alignment'] } },
  { name: 'distribute_elements', description: 'Distribute elements evenly', inputSchema: { type: 'object', properties: { elementIds: { type: 'array', items: { type: 'string' } }, direction: { type: 'string', enum: ['horizontal', 'vertical'] } }, required: ['elementIds', 'direction'] } },
  { name: 'lock_elements', description: 'Lock elements to prevent modification', inputSchema: { type: 'object', properties: { elementIds: { type: 'array', items: { type: 'string' } } }, required: ['elementIds'] } },
  { name: 'unlock_elements', description: 'Unlock elements to allow modification', inputSchema: { type: 'object', properties: { elementIds: { type: 'array', items: { type: 'string' } } }, required: ['elementIds'] } },
  { name: 'create_from_mermaid', description: 'Convert a Mermaid diagram to elements via the connected viewer (viewer tab must be open).', inputSchema: { type: 'object', properties: { mermaidDiagram: { type: 'string' }, config: { type: 'object' } }, required: ['mermaidDiagram'] } },
  { name: 'batch_create_elements', description: 'Create multiple elements at once. Assign custom id to shapes so arrows can reference them via startElementId/endElementId.', inputSchema: { type: 'object', properties: { elements: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: TYPES }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, backgroundColor: { type: 'string' }, strokeColor: { type: 'string' }, strokeWidth: { type: 'number' }, strokeStyle: { type: 'string' }, roughness: { type: 'number' }, opacity: { type: 'number' }, text: { type: 'string' }, fontSize: { type: 'number' }, fontFamily: { type: ['string', 'number'] }, startElementId: { type: 'string' }, endElementId: { type: 'string' }, endArrowhead: { type: 'string' }, startArrowhead: { type: 'string' } }, required: ['type', 'x', 'y'] } } }, required: ['elements'] } },
  { name: 'get_element', description: 'Get a single element by ID', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'clear_canvas', description: 'Clear all elements from the remote canvas (commits to GitHub)', inputSchema: { type: 'object', properties: {} } },
  { name: 'export_scene', description: 'Export the remote canvas to .excalidraw JSON. Optionally write to a file.', inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } } },
  { name: 'import_scene', description: 'Import elements from a .excalidraw JSON file or raw JSON data', inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, data: { type: 'string' }, mode: { type: 'string', enum: ['replace', 'merge'] } }, required: ['mode'] } },
  { name: 'export_to_image', description: 'Export the remote canvas to PNG/SVG via the connected viewer (viewer tab must be open).', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['png', 'svg'] }, filePath: { type: 'string' }, background: { type: 'boolean' } }, required: ['format'] } },
  { name: 'duplicate_elements', description: 'Duplicate elements with a configurable offset', inputSchema: { type: 'object', properties: { elementIds: { type: 'array', items: { type: 'string' } }, offsetX: { type: 'number' }, offsetY: { type: 'number' } }, required: ['elementIds'] } },
  { name: 'add_image', description: 'Add an image to the remote canvas from a local file path, URL, or dataURL.', inputSchema: { type: 'object', properties: { source: { type: 'string' }, dataURL: { type: 'string' }, filename: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } } },
  { name: 'snapshot_scene', description: 'Save a named snapshot of the remote canvas (stored on the excalidrop branch under snapshots/)', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'restore_snapshot', description: 'Restore the remote canvas from a named snapshot', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'describe_scene', description: 'AI-readable description of the remote canvas: types, positions, connections, layout, bounding box.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_canvas_screenshot', description: 'Screenshot of the remote canvas via the connected viewer (viewer tab must be open; ~10s).', inputSchema: { type: 'object', properties: { background: { type: 'boolean' } } } },
  { name: 'read_diagram_guide', description: 'Design guide for beautiful diagrams: colors, sizing, layout, arrows, anti-patterns.', inputSchema: { type: 'object', properties: {} } },
  { name: 'export_to_excalidraw_url', description: 'Export the remote canvas to a shareable excalidraw.com URL (encrypted upload).', inputSchema: { type: 'object', properties: {} } },
  { name: 'switch_remote', description: 'Switch this MCP session to a different repo canvas (owner/repo). Commits land on GitHub.', inputSchema: { type: 'object', properties: { target: { type: 'string' } } } },
  { name: 'current_canvas', description: 'Show which remote repo canvas this session points at.', inputSchema: { type: 'object', properties: {} } },
  { name: 'github_login', description: 'GitHub device-flow login (2FA via GitHub). Step 1 (no args): returns code + URL. Step 2 (device_code): polls, stores token.', inputSchema: { type: 'object', properties: { device_code: { type: 'string' }, interval: { type: 'number' }, site: { type: 'string' }, repo: { type: 'string' } } } },
  { name: 'commit_scene', description: 'Immediately commit the remote scene to GitHub (otherwise autosyncs ~10s after last edit).', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
  { name: 'set_viewport', description: 'Control the viewer viewport via the connected viewer (viewer tab must be open).', inputSchema: { type: 'object', properties: { scrollToContent: { type: 'boolean' }, scrollToElementId: { type: 'string' }, zoom: { type: 'number' }, offsetX: { type: 'number' }, offsetY: { type: 'number' } } } },
];

const server = new Server(
  { name: 'excalidrop', version: '2.0.0', description: 'Remote GitHub-backed Excalidraw canvas' },
  { capabilities: { tools: Object.fromEntries(tools.map((t) => [t.name, { description: t.description, inputSchema: t.inputSchema }])) } },
);

function toLabel(el: ServerElement): ServerElement {
  const { text, ...rest } = el;
  if (text && el.type !== 'text') return { ...rest, label: { text } } as ServerElement;
  return el;
}

function buildElement(d: z.infer<typeof ElementSchema>): ServerElement {
  const { startElementId, endElementId, id: customId, ...rest } = d;
  const el: ServerElement = {
    id: customId || generateId(), ...rest,
    points: rest.points ? normalizePoints(rest.points) : undefined,
    ...(startElementId ? { start: { id: startElementId } } : {}),
    ...(endElementId ? { end: { id: endElementId } } : {}),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1,
  };
  if (el.fontFamily !== undefined) el.fontFamily = normalizeFontFamily(el.fontFamily);
  if ((startElementId || endElementId) && !rest.points) (el as any).points = [[0, 0], [100, 0]];
  return toLabel(el);
}

let toolQueue: Promise<void> = Promise.resolve();

async function handleToolCall(request: CallToolRequest) {
  try {
    const { name, arguments: args } = request.params;
    log('info', `tool: ${name}`);

    switch (name) {
      case 'create_element': {
        await ensureActiveRepo();
        const el = rCreate(buildElement(ElementSchema.parse(args)));
        return { content: [{ type: 'text', text: `Element created on remote canvas!\n\n${JSON.stringify(el, null, 2)}\n\n✅ Will commit to GitHub (~10s, or commit_scene now)` }] };
      }

      case 'update_element': {
        await ensureActiveRepo();
        const { id, points: rawPoints, ...updates } = z.object({ id: z.string() }).merge(ElementSchema.partial()).parse(args);
        if (!id) throw new Error('Element ID is required');
        const payload = toLabel({ id, ...updates, points: rawPoints ? normalizePoints(rawPoints) : undefined, updatedAt: new Date().toISOString() } as ServerElement);
        if ((payload as any).fontFamily !== undefined) (payload as any).fontFamily = normalizeFontFamily((payload as any).fontFamily);
        const el = rUpdate(id, payload as Partial<ServerElement>);
        return { content: [{ type: 'text', text: `Element updated on remote canvas!\n\n${JSON.stringify(el, null, 2)}` }] };
      }

      case 'delete_element': {
        await ensureActiveRepo();
        const { id } = z.object({ id: z.string() }).parse(args);
        rDelete(id);
        return { content: [{ type: 'text', text: `Element ${id} deleted (will commit to GitHub).` }] };
      }

      case 'query_elements': {
        await ensureActiveRepo();
        const { type, filter, bbox } = z.object({
          type: z.enum(TYPES as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
          filter: z.record(z.any()).optional(),
          bbox: z.object({ x_min: z.number().optional(), x_max: z.number().optional(), y_min: z.number().optional(), y_max: z.number().optional() }).optional(),
        }).parse(args || {});
        let results = rList(type);
        if (bbox) {
          results = results.filter((el) =>
            (bbox.x_min === undefined || el.x >= bbox.x_min) &&
            (bbox.x_max === undefined || el.x <= bbox.x_max) &&
            (bbox.y_min === undefined || el.y >= bbox.y_min) &&
            (bbox.y_max === undefined || el.y <= bbox.y_max));
        }
        if (filter) results = results.filter((el) => Object.entries(filter).every(([k, v]) => (el as any)[k] === v));
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      }

      case 'get_resource': {
        await ensureActiveRepo();
        const { resource } = z.object({ resource: z.enum(['scene', 'library', 'theme', 'elements']) }).parse(args);
        if (resource === 'theme') return { content: [{ type: 'text', text: JSON.stringify({ theme: 'light' }, null, 2) }] };
        if (resource === 'scene') {
          const els = rList();
          return { content: [{ type: 'text', text: JSON.stringify({ count: els.length }, null, 2) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ elements: rList() }, null, 2) }] };
      }

      case 'group_elements': {
        await ensureActiveRepo();
        const { elementIds } = z.object({ elementIds: z.array(z.string()) }).parse(args);
        const groupId = generateId();
        groups.set(groupId, elementIds);
        let n = 0;
        for (const id of elementIds) {
          const el = rGet(id);
          if (!el) continue;
          rUpdate(id, { groupIds: [...(el.groupIds || []), groupId] });
          n += 1;
        }
        if (!n) { groups.delete(groupId); throw new Error('No elements grouped (ids not found)'); }
        return { content: [{ type: 'text', text: JSON.stringify({ groupId, elementIds, successCount: n }, null, 2) }] };
      }

      case 'ungroup_elements': {
        await ensureActiveRepo();
        const { groupId } = z.object({ groupId: z.string() }).parse(args);
        const ids = groups.get(groupId) || rList().filter((e) => e.groupIds?.includes(groupId)).map((e) => e.id);
        if (!ids.length) throw new Error(`Group ${groupId} not found`);
        groups.delete(groupId);
        let n = 0;
        for (const id of ids) {
          const el = rGet(id);
          if (!el) continue;
          rUpdate(id, { groupIds: (el.groupIds || []).filter((g: string) => g !== groupId) });
          n += 1;
        }
        return { content: [{ type: 'text', text: JSON.stringify({ groupId, ungrouped: true, elementIds: ids, successCount: n }, null, 2) }] };
      }

      case 'align_elements': {
        await ensureActiveRepo();
        const { elementIds, alignment } = z.object({ elementIds: z.array(z.string()), alignment: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']) }).parse(args);
        const els = elementIds.map((id) => rGet(id)).filter(Boolean) as ServerElement[];
        if (els.length < 2) throw new Error('Need at least 2 elements to align');
        let fn: (el: ServerElement) => { x?: number; y?: number };
        switch (alignment) {
          case 'left': { const v = Math.min(...els.map((e) => e.x)); fn = () => ({ x: v }); break; }
          case 'right': { const v = Math.max(...els.map((e) => e.x + (e.width || 0))); fn = (e) => ({ x: v - (e.width || 0) }); break; }
          case 'center': { const cs = els.map((e) => e.x + (e.width || 0) / 2); const a = cs.reduce((x, y) => x + y, 0) / cs.length; fn = (e) => ({ x: a - (e.width || 0) / 2 }); break; }
          case 'top': { const v = Math.min(...els.map((e) => e.y)); fn = () => ({ y: v }); break; }
          case 'bottom': { const v = Math.max(...els.map((e) => e.y + (e.height || 0))); fn = (e) => ({ y: v - (e.height || 0) }); break; }
          case 'middle': { const ms = els.map((e) => e.y + (e.height || 0) / 2); const a = ms.reduce((x, y) => x + y, 0) / ms.length; fn = (e) => ({ y: a - (e.height || 0) / 2 }); break; }
        }
        for (const el of els) rUpdate(el.id, fn(el));
        return { content: [{ type: 'text', text: JSON.stringify({ aligned: true, elementIds, alignment, successCount: els.length }, null, 2) }] };
      }

      case 'distribute_elements': {
        await ensureActiveRepo();
        const { elementIds, direction } = z.object({ elementIds: z.array(z.string()), direction: z.enum(['horizontal', 'vertical']) }).parse(args);
        const els = elementIds.map((id) => rGet(id)).filter(Boolean) as ServerElement[];
        if (els.length < 3) throw new Error('Need at least 3 elements to distribute');
        if (direction === 'horizontal') {
          els.sort((a, b) => a.x - b.x);
          const first = els[0]!; const last = els[els.length - 1]!;
          const gap = (last.x + (last.width || 0) - first.x - els.reduce((s, e) => s + (e.width || 0), 0)) / (els.length - 1);
          let x = first.x;
          for (const el of els) { rUpdate(el.id, { x }); x += (el.width || 0) + gap; }
        } else {
          els.sort((a, b) => a.y - b.y);
          const first = els[0]!; const last = els[els.length - 1]!;
          const gap = (last.y + (last.height || 0) - first.y - els.reduce((s, e) => s + (e.height || 0), 0)) / (els.length - 1);
          let y = first.y;
          for (const el of els) { rUpdate(el.id, { y }); y += (el.height || 0) + gap; }
        }
        return { content: [{ type: 'text', text: JSON.stringify({ distributed: true, elementIds, direction, count: els.length }, null, 2) }] };
      }

      case 'lock_elements':
      case 'unlock_elements': {
        await ensureActiveRepo();
        const { elementIds } = z.object({ elementIds: z.array(z.string()) }).parse(args);
        const locked = name === 'lock_elements';
        for (const id of elementIds) rUpdate(id, { locked });
        return { content: [{ type: 'text', text: JSON.stringify({ [locked ? 'locked' : 'unlocked']: true, elementIds }, null, 2) }] };
      }

      case 'batch_create_elements': {
        await ensureActiveRepo();
        const { elements } = z.object({ elements: z.array(ElementSchema) }).parse(args);
        const out = rBatch(elements.map(buildElement));
        return { content: [{ type: 'text', text: `${out.length} elements created on remote canvas!\n\n${JSON.stringify(out, null, 2)}` }] };
      }

      case 'get_element': {
        await ensureActiveRepo();
        const { id } = z.object({ id: z.string() }).parse(args);
        const el = rGet(id);
        if (!el) throw new Error(`Element ${id} not found`);
        return { content: [{ type: 'text', text: JSON.stringify(el, null, 2) }] };
      }

      case 'clear_canvas': {
        await ensureActiveRepo();
        const n = rClear();
        return { content: [{ type: 'text', text: `Canvas cleared (${n} elements removed, will commit to GitHub).` }] };
      }

      case 'export_scene': {
        await ensureActiveRepo();
        const { filePath } = z.object({ filePath: z.string().optional() }).parse(args || {});
        const els = rList();
        const json = JSON.stringify({ type: 'excalidraw', version: 2, source: 'excalidrop', elements: els, appState: { viewBackgroundColor: '#ffffff', gridSize: null } }, null, 2);
        if (filePath) {
          const p = sanitizeFilePath(filePath);
          fs.writeFileSync(p, json, 'utf-8');
          return { content: [{ type: 'text', text: `Scene exported to ${p} (${els.length} elements)` }] };
        }
        return { content: [{ type: 'text', text: json }] };
      }

      case 'import_scene': {
        await ensureActiveRepo();
        const { filePath, data, mode } = z.object({ filePath: z.string().optional(), data: z.string().optional(), mode: z.enum(['replace', 'merge']) }).parse(args);
        let doc: any;
        if (filePath) doc = JSON.parse(fs.readFileSync(sanitizeFilePath(filePath), 'utf-8'));
        else if (data) doc = JSON.parse(data);
        else throw new Error('Either filePath or data must be provided');
        const incoming: ServerElement[] = (Array.isArray(doc) ? doc : doc.elements || []).map((el: any) => ({ ...el, id: el.id || generateId(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 }));
        if (!incoming.length) throw new Error('No elements found in the import data');
        if (mode === 'replace') rClear();
        if (doc.files && typeof doc.files === 'object') {
          for (const f of Object.values(doc.files) as any[]) if ((f as any)?.id) rAddFile(f);
        }
        const out = rBatch(incoming);
        return { content: [{ type: 'text', text: `Imported ${out.length} elements (mode: ${mode})\n\n✅ Will commit to GitHub` }] };
      }

      case 'add_image': {
        await ensureActiveRepo();
        const p = z.object({ source: z.string().optional(), dataURL: z.string().optional(), filename: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional() }).parse(args);
        const raw = p.dataURL || p.source;
        if (!raw) throw new Error('add_image requires "source" or "dataURL"');
        let finalDataURL: string; let mimeHint: string | undefined;
        if (raw.startsWith('data:')) {
          finalDataURL = raw;
          mimeHint = /^data:([^;]+);base64,/.exec(raw)?.[1];
        } else if (/^https?:\/\//.test(raw)) {
          const r = await fetch(raw);
          if (!r.ok) throw new Error(`Failed to download image: ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 10 * 1024 * 1024) throw new Error('Image too large (max 10MB)');
          mimeHint = r.headers.get('content-type') || 'image/png';
          finalDataURL = `data:${mimeHint};base64,${buf.toString('base64')}`;
        } else {
          const abs = path.resolve(raw);
          if (!fs.existsSync(abs)) throw new Error(`Image file not found: ${raw}`);
          const buf = fs.readFileSync(abs);
          if (buf.length > 10 * 1024 * 1024) throw new Error('Image too large (max 10MB)');
          const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
          mimeHint = mimeMap[path.extname(abs).toLowerCase()];
          if (!mimeHint) throw new Error('Unsupported image type (use png/jpg/gif/webp/svg)');
          finalDataURL = `data:${mimeHint};base64,${buf.toString('base64')}`;
        }
        const mm = /^data:([^;]+);base64,(.+)$/s.exec(finalDataURL);
        if (!mm) throw new Error('Invalid image data');
        const fileId = generateId();
        rAddFile({ id: fileId, dataURL: finalDataURL, mimeType: mimeHint || mm[1], created: Date.now() });
        const now = new Date().toISOString();
        const el = rCreate({ id: generateId(), type: 'image', x: p.x ?? 0, y: p.y ?? 0, width: p.width ?? 400, height: p.height ?? 300, fileId, status: 'saved', scale: [1, 1], createdAt: now, updatedAt: now, version: 1 } as ServerElement);
        return { content: [{ type: 'text', text: `Image saved to remote scene (fileId ${fileId})\n\n${JSON.stringify(el, null, 2)}` }] };
      }

      case 'snapshot_scene': {
        const repo = await ensureActiveRepo();
        const { name: snapName } = z.object({ name: z.string() }).parse(args);
        const els = rList();
        await putFile(repo, `snapshots/${snapName}.json`, { name: snapName, elements: els, createdAt: new Date().toISOString() }, `excalidrop: snapshot ${snapName} (${els.length} elements)`, CANVAS_BRANCH);
        return { content: [{ type: 'text', text: `Snapshot "${snapName}" saved (${els.length} elements) on branch ${CANVAS_BRANCH}.` }] };
      }

      case 'restore_snapshot': {
        const repo = await ensureActiveRepo();
        const { name: snapName } = z.object({ name: z.string() }).parse(args);
        const snap = await getFile(repo, `snapshots/${snapName}.json`, CANVAS_BRANCH);
        if (!snap) throw new Error(`Snapshot "${snapName}" not found`);
        const els: ServerElement[] = (snap.content as any).elements || [];
        rClear();
        rBatch(els.map((e) => ({ ...e, id: e.id || generateId() })));
        return { content: [{ type: 'text', text: `Snapshot "${snapName}" restored (${els.length} elements). Will commit to GitHub.` }] };
      }

      case 'describe_scene': {
        await ensureActiveRepo();
        const els = rList();
        if (!els.length) return { content: [{ type: 'text', text: 'The canvas is empty. No elements to describe.' }] };
        const counts: Record<string, number> = {};
        for (const el of els) counts[el.type] = (counts[el.type] || 0) + 1;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const el of els) { minX = Math.min(minX, el.x); minY = Math.min(minY, el.y); maxX = Math.max(maxX, el.x + (el.width || 0)); maxY = Math.max(maxY, el.y + (el.height || 0)); }
        const lines = [`## Canvas Description`, `Total elements: ${els.length}`, `Types: ${Object.entries(counts).map(([t, c]) => `${t}(${c})`).join(', ')}`, `Bounding box: (${Math.round(minX)}, ${Math.round(minY)}) to (${Math.round(maxX)}, ${Math.round(maxY)})`, '', '### Elements:'];
        for (const el of [...els].sort((a, b) => Math.floor(a.y / 50) - Math.floor(b.y / 50) || a.x - b.x)) {
          const parts = [`[${el.id}] ${el.type}`, `at (${Math.round(el.x)}, ${Math.round(el.y)})`];
          if (el.width || el.height) parts.push(`size ${Math.round(el.width || 0)}x${Math.round(el.height || 0)}`);
          if (el.text) parts.push(`text: "${el.text}"`);
          if (el.label?.text) parts.push(`label: "${el.label.text}"`);
          lines.push('  ' + parts.join(' | '));
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'get_canvas_screenshot':
      case 'export_to_image': {
        const repo = await ensureActiveRepo();
        const isShot = name === 'get_canvas_screenshot';
        const p = isShot
          ? z.object({ background: z.boolean().optional() }).parse(args || {})
          : z.object({ format: z.enum(['png', 'svg']), filePath: z.string().optional(), background: z.boolean().optional() }).parse(args);
        const format = isShot ? 'png' : (p as any).format;
        const out = await screenshotRepo(repo, { background: (p as any).background ?? true, format });
        if (!isShot && (p as any).filePath) {
          const fp = sanitizeFilePath((p as any).filePath);
          if (format === 'svg') fs.writeFileSync(fp, out.data, 'utf-8');
          else fs.writeFileSync(fp, Buffer.from(out.data, 'base64'));
          return { content: [{ type: 'text', text: `Image exported to ${fp} (format: ${format})` }] };
        }
        if (format === 'svg') return { content: [{ type: 'text', text: out.data }] };
        return { content: [{ type: 'image' as const, data: out.data, mimeType: 'image/png' }, { type: 'text', text: 'Remote canvas screenshot (viewer render).' }] };
      }

      case 'create_from_mermaid': {
        const repo = await ensureActiveRepo();
        const { mermaidDiagram } = z.object({ mermaidDiagram: z.string(), config: z.any().optional() }).parse(args);
        try {
          const out = await queueRpc(repo, 'mermaid', { mermaidDiagram }) as any;
          if (Array.isArray(out?.elements) && out.elements.length) {
            rBatch(out.elements.map((e: any) => ({ ...e, id: e.id || generateId() })));
          }
          return { content: [{ type: 'text', text: `Mermaid converted via viewer (${out?.count || out?.elements?.length || 0} elements).` }] };
        } catch (e) {
          throw new Error(`Mermaid needs a connected viewer tab: ${(e as Error).message}`);
        }
      }

      case 'read_diagram_guide': {
        return { content: [{ type: 'text', text: DIAGRAM_DESIGN_GUIDE }] };
      }

      case 'export_to_excalidraw_url': {
        await ensureActiveRepo();
        const els = rList();
        if (!els.length) throw new Error('Canvas is empty — nothing to export');
        const cleaned: Record<string, any>[] = [];
        const boundTexts: Record<string, any>[] = [];
        let idx = 0;
        for (const el of els) {
          const { createdAt, updatedAt, syncedAt, source, syncTimestamp, label, start, end, text, version: _v, ...rest } = el as any;
          const base: Record<string, any> = { ...rest, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: `a${idx++}`, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false };
          if (el.type === 'text') { base.text = text ?? ''; base.originalText = text ?? ''; base.fontSize = 20; base.fontFamily = 1; cleaned.push(base); continue; }
          const labelText = label?.text || text;
          if (labelText) {
            const textId = `${base.id}-label`;
            base.boundElements = [...(Array.isArray(base.boundElements) ? base.boundElements : []), { type: 'text', id: textId }];
            boundTexts.push({ id: textId, type: 'text', x: base.x + 10, y: base.y + 10, width: 100, height: 24, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: `a${idx++}`, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, text: labelText, originalText: labelText, fontSize: 16, fontFamily: 1, textAlign: 'center', verticalAlign: 'middle', autoResize: true, lineHeight: 1.25, containerId: base.id });
          }
          cleaned.push(base);
        }
        cleaned.push(...boundTexts);
        const enc = new TextEncoder();
        const concat = (...bufs: Uint8Array[]): Uint8Array => {
          let total = 4;
          for (const b of bufs) total += 4 + b.length;
          const out = new Uint8Array(total);
          const dv = new DataView(out.buffer);
          dv.setUint32(0, 1);
          let off = 4;
          for (const b of bufs) { dv.setUint32(off, b.length); off += 4; out.set(b, off); off += b.length; }
          return out;
        };
        const inner = concat(enc.encode('{}'), enc.encode(JSON.stringify({ type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements: cleaned, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} })));
        const compressed = deflateSync(Buffer.from(inner));
        const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt']);
        const iv = webcrypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed));
        const payload = concat(enc.encode(JSON.stringify({ version: 2, compression: 'pako@1', encryption: 'AES-GCM' })), iv, ct);
        const up = await fetch('https://json.excalidraw.com/api/v2/post/', { method: 'POST', body: Buffer.from(payload) });
        if (!up.ok) throw new Error(`Upload failed: ${up.status}`);
        const { id } = await up.json() as { id: string };
        const jwk = await webcrypto.subtle.exportKey('jwk', key);
        return { content: [{ type: 'text', text: `Diagram exported!\n\nShareable URL: https://excalidraw.com/#json=${id},${jwk.k}` }] };
      }

      case 'switch_remote': {
        const { target: input } = z.object({ target: z.string().optional() }).parse(args || {});
        if (!input) throw new Error('Remote-only mode: pass { target: "owner/repo" }.');
        const repo = parseRepo(input);
        activeRepo = repo;
        const st = await ensureLoaded(repo);
        persistRepo(repo);
        return { content: [{ type: 'text', text: `Switched to remote canvas ${repo} (${st.elements.size} elements). Edits commit to GitHub.` }] };
      }

      case 'current_canvas': {
        const repo = activeRepo || loadSavedRepo();
        return { content: [{ type: 'text', text: repo ? `remote:${repo}` : 'no canvas selected — pass --repo=owner/repo' }] };
      }

      case 'github_login': {
        const { device_code, interval, site, repo } = z.object({ device_code: z.string().optional(), interval: z.number().optional(), site: z.string().optional(), repo: z.string().optional() }).parse(args || {});
        if (!device_code) {
          if (resolveToken()) return { content: [{ type: 'text', text: 'Already logged in to GitHub (token from env/gh CLI/stored).' }] };
          const dev = await deviceStart(APP_CLIENT_ID);
          return { content: [{ type: 'text', text: `Open ${dev.verification_uri}, enter code ${dev.user_code}, then call github_login with { device_code: "${dev.device_code}", interval: ${dev.interval} }` }] };
        }
        let repositoryId: number | undefined;
        const ref = repo || site;
        if (ref) {
          try { const [o, r] = parseRepo(ref).split('/'); repositoryId = (await repoId(o!, r!)) || undefined; } catch { /* unrestricted */ }
        }
        const token = await devicePoll(APP_CLIENT_ID, device_code, interval || 5, 300, repositoryId);
        const link = site ? `\nBrowser login link: ${site.replace(/\/$/, '')}/#token=${token}` : '';
        return { content: [{ type: 'text', text: `Logged in to GitHub (token stored).${link}` }] };
      }

      case 'commit_scene': {
        const { message } = z.object({ message: z.string().optional() }).parse(args || {});
        const out = await commitNow(message);
        return { content: [{ type: 'text', text: `Committed ${out.count} elements (${out.sha.slice(0, 7)}).` }] };
      }

      case 'set_viewport': {
        const repo = await ensureActiveRepo();
        const p = z.object({ scrollToContent: z.boolean().optional(), scrollToElementId: z.string().optional(), zoom: z.number().min(0.1).max(10).optional(), offsetX: z.number().optional(), offsetY: z.number().optional() }).parse(args || {});
        const out = await viewportRepo(repo, p);
        return { content: [{ type: 'text', text: `Viewport updated.\n\n${JSON.stringify(out, null, 2)}` }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    log('error', `tool failed: ${(error as Error).message}`);
    return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true };
  }
}

server.setRequestHandler(CallToolRequestSchema, (request: CallToolRequest) => {
  const task = toolQueue.then(() => handleToolCall(request));
  toolQueue = task.then(() => undefined, () => undefined);
  return task;
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

async function runServer(): Promise<void> {
  const repo = loadSavedRepo();
  if (repo) {
    try {
      const st = await ensureLoaded(repo);
      activeRepo = repo;
      log('info', `Remote canvas ${repo} (${st.elements.size} elements)`);
    } catch (e) { log('warn', 'Remote preload failed: ' + (e as Error).message); }
  } else {
    log('warn', 'No repo selected — pass --repo=owner/repo.');
  }
  await server.connect(new StdioServerTransport());
  log('info', 'excalidrop MCP (remote-only) running on stdio');
  process.stdin.resume();
}

process.on('uncaughtException', (e: Error) => { log('error', 'uncaught: ' + e.message); setTimeout(() => process.exit(1), 1000); });
process.on('unhandledRejection', (r: any) => { log('error', 'unhandled: ' + String(r)); setTimeout(() => process.exit(1), 1000); });

function entryPath(p: string | undefined): string | null {
  if (!p) return null;
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

if (entryPath(fileURLToPath(import.meta.url)) === entryPath(process.argv[1])) {
  runServer().catch((e) => { log('error', 'start failed: ' + (e as Error).message); process.exit(1); });
}

export default runServer;
