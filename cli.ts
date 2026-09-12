#!/usr/bin/env node

import { spawn, spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_NAME = '.excalidrop.json';
const MCP_JSON = '.mcp.json';
const RELAY_DEFAULT = 'https://excalidrop.wtf403.workers.dev';
const GH_API = 'https://api.github.com';
const SCENE_PATH = process.env.SCENE_PATH || 'canvas.excalidraw';
const CANVAS_BRANCH = process.env.CANVAS_BRANCH || 'excalidrop';
const PAGES_BRANCH = process.env.PAGES_BRANCH || 'excalidrop';

function ghToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function ghHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ghToken()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'excalidrop-setup', 'Content-Type': 'application/json' };
}

async function ghGet(pathname: string): Promise<any> {
  const r = await fetch(`${GH_API}${pathname}`, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub GET ${pathname} → ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return r.json();
}

async function ghPut(pathname: string, body: unknown): Promise<any> {
  const r = await fetch(`${GH_API}${pathname}`, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub PUT ${pathname} → ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return r.json();
}

async function ghPatch(pathname: string, body: unknown): Promise<any> {
  const r = await fetch(`${GH_API}${pathname}`, { method: 'PATCH', headers: ghHeaders(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub PATCH ${pathname} → ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return r.json();
}

/** Set repo website (homepage) to the canvas viewer URL — only if empty. Best-effort. */
async function ensureRepoHomepage(repo: string, viewerUrl: string): Promise<void> {
  try {
    const info = await ghGet(`/repos/${repo}`);
    if (info.homepage && String(info.homepage).trim()) return;
    await ghPatch(`/repos/${repo}`, { homepage: viewerUrl });
    console.log(`Repo website set to canvas: ${viewerUrl}`);
  } catch (e) {
    console.warn(`Could not set repo website (non-fatal): ${(e as Error).message}`);
  }
}

async function ensureMainBranch(repo: string): Promise<void> {
  const main = await fetch(`${GH_API}/repos/${repo}/git/ref/heads/main`, { headers: ghHeaders() });
  if (main.ok) return;
  const branches = await (await fetch(`${GH_API}/repos/${repo}/branches`, { headers: ghHeaders() })).json() as any[];
  if (branches.length !== 0) return;
  await ghPut(`/repos/${repo}/contents/README.md`, {
    message: 'Initial commit',
    content: Buffer.from('').toString('base64'),
    branch: 'main',
  });
}

async function getScene(repo: string): Promise<{ elements: any[]; sha: string | null }> {
  const r = await fetch(`${GH_API}/repos/${repo}/contents/${SCENE_PATH}?ref=${CANVAS_BRANCH}`, { headers: ghHeaders() });
  if (r.status === 404) return { elements: [], sha: null };
  if (!r.ok) throw new Error(`scene read ${r.status}`);
  const j = await r.json() as any;
  let b64: string | null = typeof j.content === 'string' && j.content.length ? j.content : null;
  if (!b64) {
    const blob = await fetch(`${GH_API}/repos/${repo}/git/blobs/${j.sha}`, { headers: ghHeaders() });
    if (blob.ok) b64 = ((await blob.json()) as any).content || null;
  }
  if (!b64) return { elements: [], sha: j.sha || null };
  return { elements: (JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).elements || []) as any[], sha: j.sha };
}

async function putScene(repo: string, elements: any[], sha: string | null, message: string): Promise<void> {
  const body: any = {
    message,
    content: Buffer.from(JSON.stringify({ type: 'excalidraw', version: 2, source: 'excalidrop', elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} }, null, 2)).toString('base64'),
    branch: CANVAS_BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH_API}/repos/${repo}/contents/${SCENE_PATH}`, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
  if (r.status === 404) {
    // create the branch from default, then retry once
    const info = await ghGet(`/repos/${repo}`);
    const from = info.default_branch || 'main';
    const ref = await ghGet(`/repos/${repo}/git/ref/heads/${from}`);
    await fetch(`${GH_API}/repos/${repo}/git/refs`, { method: 'POST', headers: ghHeaders(), body: JSON.stringify({ ref: `refs/heads/${CANVAS_BRANCH}`, sha: ref.object.sha }) });
    const retry = await fetch(`${GH_API}/repos/${repo}/contents/${SCENE_PATH}`, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) });
    if (!retry.ok) throw new Error(`scene write ${retry.status}`);
    return;
  }
  if (!r.ok) throw new Error(`scene write ${r.status}: ${(await r.text()).slice(0, 150)}`);
}

function viewerDir(): string {
  // dist/cli.js → dist/frontend; fallback to checkout layout.
  const cands = [path.join(__dirname, 'frontend'), path.join(process.cwd(), 'dist', 'frontend')];
  for (const d of cands) {
    if (fs.existsSync(path.join(d, 'index.html')) && fs.existsSync(path.join(d, 'assets'))) return d;
  }
  throw new Error('Viewer build not found (dist/frontend). Reinstall excalidrop or run `npm run build:frontend` in the excalidrop checkout.');
}

function listFilesRecursive(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(full, base));
    else if (e.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

async function deployViewerPages(repo: string): Promise<void> {
  const dir = viewerDir();
  const files = listFilesRecursive(dir);
  const blob = async (content: string) => (await (await fetch(`${GH_API}/repos/${repo}/git/blobs`, { method: 'POST', headers: ghHeaders(), body: JSON.stringify({ content, encoding: 'base64' }) })).json() as any).sha as string;
  const tree: any[] = [];
  const pool = 8;
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(pool, files.length) }, async () => {
    while (i < files.length) {
      const rel = files[i++]!;
      tree.push({ path: rel.split(path.sep).join('/'), mode: '100644', type: 'blob', sha: await blob(fs.readFileSync(path.join(dir, rel)).toString('base64')) });
    }
  }));
  tree.push({ path: '.nojekyll', mode: '100644', type: 'blob', sha: await blob('') });
  let baseSha: string | null = null;
  let baseTree: string | null = null;
  try {
    const ref = await ghGet(`/repos/${repo}/git/ref/heads/${PAGES_BRANCH}`);
    baseSha = ref.object.sha;
    baseTree = (await ghGet(`/repos/${repo}/git/commits/${baseSha}`)).tree.sha;
  } catch { /* first deploy — root commit */ }
  const newTree = await (await fetch(`${GH_API}/repos/${repo}/git/trees`, { method: 'POST', headers: ghHeaders(), body: JSON.stringify({ ...(baseTree ? { base_tree: baseTree } : {}), tree }) })).json() as any;
  const commit = await (await fetch(`${GH_API}/repos/${repo}/git/commits`, { method: 'POST', headers: ghHeaders(), body: JSON.stringify({ message: 'excalidrop: publish viewer', tree: newTree.sha, ...(baseSha ? { parents: [baseSha] } : { parents: [] }) }) })).json() as any;
  if (baseSha) await fetch(`${GH_API}/repos/${repo}/git/refs/heads/${PAGES_BRANCH}`, { method: 'PATCH', headers: ghHeaders(), body: JSON.stringify({ sha: commit.sha, force: true }) });
  else await fetch(`${GH_API}/repos/${repo}/git/refs`, { method: 'POST', headers: ghHeaders(), body: JSON.stringify({ ref: `refs/heads/${PAGES_BRANCH}`, sha: commit.sha }) });
  // API commits don't reliably queue builds — request one explicitly.
  try {
    const cur = await fetch(`${GH_API}/repos/${repo}/pages`, { headers: ghHeaders() });
    if (!cur.ok || ((await cur.json()) as any)?.source?.branch !== PAGES_BRANCH) {
      const up = await fetch(`${GH_API}/repos/${repo}/pages`, { method: 'PUT', headers: ghHeaders(), body: JSON.stringify({ source: { branch: PAGES_BRANCH, path: '/' } }) });
      if (!up.ok) await fetch(`${GH_API}/repos/${repo}/pages`, { method: 'POST', headers: ghHeaders(), body: JSON.stringify({ source: { branch: PAGES_BRANCH, path: '/' } }) });
    }
    await fetch(`${GH_API}/repos/${repo}/pages/builds`, { method: 'POST', headers: ghHeaders() });
  } catch { /* Pages setup is best-effort */ }
}

type HostTarget = 'pages' | 'cloudflare';

function projectNameForRepo(repo: string): string {
  return `excalidrop-${repo.replace('/', '-').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 60);
}

function viewerUrlFor(repo: string, target: HostTarget): string {
  if (target === 'cloudflare') {
    // Generic viewer build can't infer the repo from a pages.dev host —
    // detectRepo() reads it from ?repo= instead.
    return `https://${projectNameForRepo(repo)}.pages.dev/?repo=${repo}`;
  }
  const [owner, name] = repo.split('/');
  return `https://${owner}.github.io/${name}/`;
}

async function isPrivateRepo(repo: string): Promise<boolean | null> {
  try {
    const r = spawnSync('gh', ['api', `repos/${repo}`, '--jq', '.private'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    if (r.stdout.trim() === 'true') return true;
    if (r.stdout.trim() === 'false') return false;
    return null;
  } catch { return null; }
}

async function resolveTarget(repo: string, explicit?: string): Promise<HostTarget> {
  if (explicit === 'pages' || explicit === 'cloudflare') return explicit;
  return (await isPrivateRepo(repo)) === true ? 'cloudflare' : 'pages';
}

function deployToCloudflarePages(project: string): void {
  // wrangler 4 doesn't auto-create Pages projects and its Workers delegation
  // misfires on explicit asset dirs — create once, then deploy classic with --force.
  const WRANGLER = ['-y', 'wrangler@4'];
  const create = spawnSync('npx', [...WRANGLER, 'pages', 'project', 'create', project, '--force', '--production-branch=main'], { stdio: 'pipe', encoding: 'utf8', env: process.env });
  const createOut = (create.stdout || '') + (create.stderr || '');
  if (create.status !== 0 && !/already exists/i.test(createOut)) {
    throw new Error(`wrangler pages project create failed:\n${createOut.slice(-800)}\nRun \`wrangler login\` first (or set CLOUDFLARE_API_TOKEN).`);
  }
  const r = spawnSync('npx', [...WRANGLER, 'pages', 'deploy', viewerDir(), '--project-name', project, '--force'], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) throw new Error('wrangler pages deploy failed. Run `wrangler login` first (or set CLOUDFLARE_API_TOKEN).');
}

function detectSlug(): string {
  try {
    const url = spawnSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).stdout.trim().replace(/\.git$/, '');
    return url.match(/github\.com[:/](.+)/)?.[1]?.toLowerCase() || '';
  } catch { return ''; }
}

function ghAuthed(): boolean {
  return spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
}

function commandExists(cmd: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'command', ['-v', cmd], { stdio: 'ignore', shell: process.platform === 'win32' });
  return probe.status === 0;
}

function findProjectRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  const home = process.env.HOME || process.env.USERPROFILE || '/';
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return path.resolve(cwd);
    dir = parent;
  }
}

function mcpArgs(repo: string): string[] {
  return ['-y', 'excalidrop@latest', 'mcp', '--repo', repo];
}

const EDITOR_IDS = ['claude-project', 'claude-user', 'codex', 'cursor', 'cursor-user', 'desktop', 'opencode', 'opencode-user'] as const;
type EditorId = (typeof EDITOR_IDS)[number];

function editorCommand(id: EditorId, repo: string): string {
  const a = mcpArgs(repo).join(' ');
  switch (id) {
    case 'claude-project': return `claude mcp add excalidrop --scope project -- npx ${a}`;
    case 'claude-user': return `claude mcp add excalidrop --scope user -- npx ${a}`;
    case 'codex': return `codex mcp add excalidrop -- npx ${a}`;
    case 'cursor':
    case 'cursor-user':
    case 'desktop': return JSON.stringify({ mcpServers: { excalidrop: { command: 'npx', args: mcpArgs(repo) } } }, null, 2);
    case 'opencode':
    case 'opencode-user': return JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { excalidrop: { type: 'local', command: ['npx', ...mcpArgs(repo)], enabled: true } } }, null, 2);
  }
}

function editorScope(id: EditorId): 'project' | 'user' {
  return id === 'claude-project' || id === 'cursor' || id === 'opencode' ? 'project' : 'user';
}

// Where each editor id reads its config from. File-based harnesses support
// both a project file and a user-global file; CLI-driven ones (claude, codex)
// are detected through the same files their CLIs write.
function editorFile(id: EditorId, root: string): { path: string; key: 'mcpServers' | 'mcp' } | null {
  const home = os.homedir();
  switch (id) {
    case 'claude-user': return { path: path.join(home, '.claude.json'), key: 'mcpServers' };
    case 'claude-project': return { path: path.join(root, MCP_JSON), key: 'mcpServers' };
    case 'cursor': return { path: path.join(root, '.cursor', 'mcp.json'), key: 'mcpServers' };
    case 'cursor-user': return { path: path.join(home, '.cursor', 'mcp.json'), key: 'mcpServers' };
    case 'desktop': return { path: desktopConfigPath(), key: 'mcpServers' };
    case 'opencode': return { path: path.join(root, 'opencode.json'), key: 'mcp' };
    case 'opencode-user': return { path: path.join(home, '.config', 'opencode', 'opencode.json'), key: 'mcp' };
    case 'codex': return null; // TOML (~/.codex/config.toml) — parsed separately
  }
}

function desktopConfigPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

function editorTarget(id: EditorId, root: string): string {
  const f = editorFile(id, root);
  if (id === 'codex') return 'user config (~/.codex/config.toml)';
  const scope = editorScope(id);
  const short = f ? shortenHome(f.path) : id;
  return `${scope} scope (${short})`;
}

function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function repoFromArgs(args: unknown): string | null {
  if (!Array.isArray(args)) return null;
  const i = args.findIndex((a) => a === '--repo');
  const v = i !== -1 ? args[i + 1] : null;
  return typeof v === 'string' && v.includes('/') ? v.toLowerCase() : null;
}

// {present, repo} for a JSON MCP config (claude/cursor/desktop/opencode shapes).
function jsonMcpRepo(file: string, key: 'mcpServers' | 'mcp'): { present: boolean; repo: string | null } {
  let j: any;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return { present: false, repo: null }; }
  const e = key === 'mcpServers' ? j?.mcpServers?.excalidrop : j?.mcp?.excalidrop;
  if (!e) return { present: false, repo: null };
  if (Array.isArray(e.command)) return { present: true, repo: repoFromArgs(e.command) };
  if (e.command === 'npx' && Array.isArray(e.args)) return { present: true, repo: repoFromArgs(e.args) };
  return { present: true, repo: null };
}

// {present, repo} for Codex's TOML config — crude section parse, no new deps.
function codexMcpRepo(): { present: boolean; repo: string | null } {
  let txt: string;
  try {
    txt = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
  } catch { return { present: false, repo: null }; }
  const sec = txt.match(/\[mcp_servers\.excalidrop\]([\s\S]*?)(?=^\[|\z)/m);
  if (!sec) return { present: false, repo: null };
  const m = (sec[1] ?? '').match(/--repo["'\s=,]+([A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+)/);
  return { present: true, repo: m?.[1]?.toLowerCase() ?? null };
}

export type EditorStatus = { status: 'current' | 'stale' | 'missing'; repo: string | null; where: string };

function detectEditorState(id: EditorId, repo: string, root: string): EditorStatus {
  const want = repo.toLowerCase();
  if (id === 'codex') {
    const s = codexMcpRepo();
    if (!s.present) return { status: 'missing', repo: null, where: '~/.codex/config.toml' };
    return s.repo === want
      ? { status: 'current', repo: s.repo, where: '~/.codex/config.toml' }
      : { status: 'stale', repo: s.repo, where: '~/.codex/config.toml' };
  }
  const f = editorFile(id, root)!;
  const where = shortenHome(f.path);
  const s = jsonMcpRepo(f.path, f.key);
  if (!s.present) return { status: 'missing', repo: null, where };
  return s.repo === want
    ? { status: 'current', repo: s.repo, where }
    : { status: 'stale', repo: s.repo, where };
}

function updateCommand(id: EditorId, repo: string): string {
  if (id === 'claude-project' || id === 'claude-user') {
    const scope = id === 'claude-project' ? 'project' : 'user';
    return `claude mcp remove excalidrop -s ${scope} && ${editorCommand(id, repo)}`;
  }
  return editorCommand(id, repo);
}

type InstallOutcome = 'added' | 'already-current' | 'stale' | 'failed';
interface InstallResult { id: EditorId; outcome: InstallOutcome; detail: string; }

function runCapture(cmd: string, args: string[]): { status: number | null; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
  } catch (e) { return { status: 1, out: (e as Error).message }; }
}

// Merge an MCP entry into a JSON config file (creates parent dirs). Returns
// false when the existing file isn't valid JSON — caller falls back to manual.
function upsertJsonMcp(file: string, key: 'mcpServers' | 'mcp', entry: unknown): boolean {
  let j: any = {};
  if (fs.existsSync(file)) {
    try {
      j = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return false; }
    if (!j || typeof j !== 'object') return false;
  } else {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch { return false; }
  }
  if (key === 'mcpServers') {
    if (!j.mcpServers || typeof j.mcpServers !== 'object') j.mcpServers = {};
    j.mcpServers.excalidrop = entry;
  } else {
    if (!j.mcp || typeof j.mcp !== 'object') j.mcp = {};
    j.mcp.excalidrop = entry;
    if (!j.$schema) j.$schema = 'https://opencode.ai/config.json';
  }
  try {
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
    return true;
  } catch { return false; }
}

function cursorEntry(repo: string): unknown {
  return { command: 'npx', args: mcpArgs(repo), env: { EXCALIDROP_RELAY_URL: process.env.EXCALIDROP_RELAY_URL || RELAY_DEFAULT } };
}

function opencodeEntry(repo: string): unknown {
  return { type: 'local', command: ['npx', ...mcpArgs(repo)], enabled: true, env: { EXCALIDROP_RELAY_URL: process.env.EXCALIDROP_RELAY_URL || RELAY_DEFAULT } };
}

function installEditor(id: EditorId, repo: string, root: string): InstallResult {
  const fail = (detail: string): InstallResult => ({ id, outcome: 'failed', detail });
  // Idempotent first: never reinstall over an identical entry, never silently
  // leave a stale one — report it with the exact update command.
  const st = detectEditorState(id, repo, root);
  if (st.status === 'current') return { id, outcome: 'already-current', detail: `${st.where} already points at ${repo}` };
  const staleNote = st.status === 'stale' ? ` (currently → ${st.repo ?? 'unknown'})` : '';

  if (id === 'claude-project' || id === 'claude-user' || id === 'codex') {
    const bin = id === 'codex' ? 'codex' : 'claude';
    if (!commandExists(bin)) return fail(`${bin} CLI not found — run manually:\n${editorCommand(id, repo)}`);
    const cargs = id === 'claude-project'
      ? ['mcp', 'add', 'excalidrop', '--scope', 'project', '--', 'npx', ...mcpArgs(repo)]
      : id === 'claude-user'
        ? ['mcp', 'add', 'excalidrop', '--scope', 'user', '--', 'npx', ...mcpArgs(repo)]
        : ['mcp', 'add', 'excalidrop', '--', 'npx', ...mcpArgs(repo)];
    const r = runCapture(bin, cargs);
    if (r.status === 0 && !/already exists/i.test(r.out)) {
      return { id, outcome: 'added', detail: editorCommand(id, repo) };
    }
    if (/already exists/i.test(r.out)) {
      // Exit code is 0 even when nothing changed — re-read the file to say
      // honestly whether the existing entry is current or stale.
      const now = detectEditorState(id, repo, root);
      if (now.status === 'current') return { id, outcome: 'already-current', detail: `${now.where} already points at ${repo}` };
      return { id, outcome: 'stale', detail: `already exists${now.repo ? ` → ${now.repo}` : ''} — not updated. Run:\n${updateCommand(id, repo)}` };
    }
    return fail((r.out.trim() || `${bin} exited ${r.status}`).slice(0, 300));
  }

  // File-based harnesses: JSON merge is safe to write for both add and update.
  const f = editorFile(id, root)!;
  const entry = id === 'cursor' || id === 'cursor-user' || id === 'desktop' ? cursorEntry(repo) : opencodeEntry(repo);
  if (upsertJsonMcp(f.path, f.key, entry)) {
    return { id, outcome: 'added', detail: `wrote ${shortenHome(f.path)}${staleNote} → ${repo}` };
  }
  return fail(`${shortenHome(f.path)} is not valid JSON — leaving it untouched. Add manually:\n${editorCommand(id, repo)}`);
}

const EDITOR_LABELS: Record<EditorId, string> = {
  'claude-project': 'Claude Code (project scope)',
  'claude-user': 'Claude Code (user scope)',
  codex: 'Codex CLI (user config)',
  cursor: 'Cursor (project file)',
  'cursor-user': 'Cursor (user file)',
  desktop: 'Claude Desktop (user config)',
  opencode: 'OpenCode (project file)',
  'opencode-user': 'OpenCode (user config)',
};

// One honest report for every editor install attempt — always shows the
// command/config that was (or should be) applied, so "installed" can never
// mean "already existed but points elsewhere".
function reportInstalls(results: InstallResult[], repo: string, root: string): void {
  for (const r of results) {
    const target = editorTarget(r.id, root);
    if (r.outcome === 'added') console.log(`ok   ${EDITOR_LABELS[r.id]} → ${target}:\n  ${editorCommand(r.id, repo).split('\n').join('\n  ')}\n  installed (${r.detail})`);
    else if (r.outcome === 'already-current') console.log(`skip ${EDITOR_LABELS[r.id]} → ${target}: ${r.detail}`);
    else if (r.outcome === 'stale') console.log(`warn ${EDITOR_LABELS[r.id]} → ${target}: ${r.detail}`);
    else console.log(`fail ${EDITOR_LABELS[r.id]} → ${target}: ${r.detail}`);
  }
}

/** Poll a viewer URL until it serves 200 (slow first builds take minutes). */
async function waitForLive(url: string, timeoutMs = 7 * 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return true;
      // 404 during initial propagation — keep waiting; anything else too.
    } catch { /* offline / DNS — keep waiting */ }
    await new Promise((r) => setTimeout(r, 10000));
  }
  return false;
}

function parseFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1]!.startsWith('-')) return args[i + 1];
  return undefined;
}

function parseEditorsFlag(args: string[]): EditorId[] | null {
  const raw = parseFlag(args, 'editor');
  if (!raw) return null;
  const ids = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const valid = ids.filter((s): s is EditorId => (EDITOR_IDS as readonly string[]).includes(s));
  if (!valid.length) {
    console.error(`Unknown --editor value. Use comma-separated: ${EDITOR_IDS.join(',')}`);
    process.exit(1);
  }
  return valid;
}

async function cmdSetup(args: string[], editorOverride?: EditorId[], opts: { fromTui?: boolean } = {}): Promise<{ repo: string; viewerUrl: string; live: boolean; installs: InstallResult[] }> {
  const positional = args.find((a) => !a.startsWith('-') && a.includes('/'));
  const slug = parseFlag(args, 'repo') || positional || detectSlug();
  if (!slug || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(slug)) {
    console.error('Usage: npx excalidrop setup owner/repo [--target pages|cloudflare] [--editor claude-project,codex] [--no-prompt]');
    process.exit(1);
  }
  if (!ghAuthed() && !process.env.GITHUB_TOKEN) {
    console.error('Not logged in to GitHub. Run `gh auth login` or `npx excalidrop login` first.');
    process.exit(1);
  }
  try {
    await ghGet(`/repos/${slug}`);
  } catch (e) {
    if (String((e as Error).message).includes('→ 404')) {
      console.error(`Repo "${slug}" not found (404). Check the slug for typos, or create it:\n\n  gh repo create ${slug} --private   # or --public\n`);
      process.exit(1);
    }
    throw e;
  }
  const explicitTarget = parseFlag(args, 'target');
  const target = await resolveTarget(slug, explicitTarget);
  console.log(`Repo: ${slug}\nHost: ${target}${explicitTarget ? (opts.fromTui ? ' (selected)' : ' (explicit)') : ' (auto: private→cloudflare, public→pages)'}\n`);

  await ensureMainBranch(slug);
  const scene = await getScene(slug).catch(() => ({ elements: [], sha: null }));
  if (!scene.sha) {
    await putScene(slug, [], null, 'excalidrop: init canvas');
    console.log('Empty canvas created on branch excalidrop.');
  }

  let viewerUrl: string;
  if (target === 'pages') {
    await deployViewerPages(slug);
    viewerUrl = viewerUrlFor(slug, 'pages');
  } else {
    deployToCloudflarePages(projectNameForRepo(slug));
    viewerUrl = viewerUrlFor(slug, 'cloudflare');
  }

  // Don't declare victory until the viewer actually serves — first Pages /
  // Cloudflare builds take minutes, and "Canvas live" on a 404 wastes a debug
  // session. Poll the URL (up to 7 min for slow first builds), then report
  // honestly with the Pages build state attached.
  const live = await waitForLive(viewerUrl);
  if (live) {
    console.log('Viewer is serving.');
  } else {
    console.log('Viewer not live yet (HTTP 404) — hosting may still be building; retry the URL in a minute.');
    const info = await pagesBuildInfo(slug, target).catch(() => null);
    if (info) console.log(info);
  }
  await ensureRepoHomepage(slug, viewerUrl);
  const appSlug = process.env.EXCALIDROP_APP_SLUG || 'excalidrop';
  console.log(`Note: browser login stays read-only until the Excalidrop app is installed on ${slug}:\n  https://github.com/apps/${appSlug}/installations/new`);

  const root = findProjectRoot(process.cwd());
  fs.writeFileSync(path.join(root, CONFIG_NAME), JSON.stringify({ remote: slug, target, viewerUrl }, null, 2) + '\n');
  const mcpPath = path.join(root, MCP_JSON);
  let mcp: Record<string, any> = {};
  if (fs.existsSync(mcpPath)) {
    try { mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8')); } catch { console.warn(`Existing ${MCP_JSON} is not valid JSON, leaving it untouched.`); }
  }
  if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object') mcp.mcpServers = {};
  mcp.mcpServers.excalidrop = { command: 'npx', args: mcpArgs(slug), env: { EXCALIDROP_RELAY_URL: process.env.EXCALIDROP_RELAY_URL || RELAY_DEFAULT } };
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  console.log(`MCP entry written to ${mcpPath}`);

  const editors = editorOverride || parseEditorsFlag(args) || [...EDITOR_IDS];
  const noPrompt = args.includes('--no-prompt') || args.includes('-y');
  const installs = editors.map((id) => installEditor(id, slug, root));
  // The TUI prints its own per-editor report (it owns the spinner); the plain
  // CLI prints here so `setup --no-prompt` shows exactly what ran.
  if (!opts.fromTui) reportInstalls(installs, slug, root);
  void noPrompt;
  return { repo: slug, viewerUrl, live, installs };
}

// Latest GitHub Pages build state for a repo — printed when the viewer URL
// still 404s after the wait so the user knows whether it's "still building"
// vs "build errored / Pages misconfigured".
async function pagesBuildInfo(repo: string, target: HostTarget): Promise<string | null> {
  if (target !== 'pages') return `Cloudflare deploy is async — check the Pages project dashboard; if still 404, rerun: npx excalidrop publish ${repo}`;
  try {
    const latest = await ghGet(`/repos/${repo}/pages/builds/latest`);
    const err = latest?.error?.message ? ` — ${latest.error.message}` : '';
    return `Pages latest build: ${latest.status}${err} (updated ${latest.updated_at || 'unknown'}). Check https://github.com/${repo}/settings/pages (source should be branch ${PAGES_BRANCH}) — first builds can take several minutes. If stuck, rerun: npx excalidrop publish ${repo}`;
  } catch {
    return `Pages build status unknown — check https://github.com/${repo}/settings/pages (source should be branch ${PAGES_BRANCH}).`;
  }
}

function cmdMcp(): void {
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp.js'), ...process.argv.slice(3)], { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdLogin(): Promise<void> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID || 'Iv23liuS2fx3QOEIoDmx';
  console.log('Starting GitHub device login…');
  const dev = await (await fetch('https://github.com/login/device/code', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  })).json() as any;
  console.log(`\nOpen ${dev.verification_uri} and enter code: ${dev.user_code}\n`);
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, (dev.interval || 5) * 1000));
    const j = await (await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, device_code: dev.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    })).json() as any;
    if (j.access_token) {
      const dir = path.join(os.homedir(), '.config', 'excalidrop');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'gh_token'), j.access_token + '\n', { mode: 0o600 });
      console.log('Logged in — token stored in ~/.config/excalidrop/gh_token');
      return;
    }
    if (j.error && j.error !== 'authorization_pending' && j.error !== 'slow_down') throw new Error(j.error_description || j.error);
  }
  throw new Error('device login timed out');
}

async function cmdStatus(): Promise<void> {
  const flag = process.argv.find((a) => a.startsWith('--repo='));
  const repo = flag ? flag.split('=').slice(1).join('=') : detectSlug();
  console.log(`repo: ${repo || '(none — run setup or pass --repo=owner/repo)'}`);
  console.log(`auth: ${ghToken() ? 'ok (env/gh CLI/stored)' : 'missing — run `gh auth login` or `npx excalidrop login`'}`);
  console.log(`relay: ${process.env.EXCALIDROP_RELAY_URL || RELAY_DEFAULT}`);
  if (!repo || !ghToken()) return;
  try {
    const scene = await getScene(repo);
    console.log(`scene: ${scene.elements.length} elements @${CANVAS_BRANCH}`);
  } catch (e) { console.log(`scene: unreachable (${(e as Error).message})`); }
}

async function runTui(): Promise<void> {
  let clack: typeof import('@clack/prompts');
  try {
    clack = await import('@clack/prompts');
  } catch {
    console.error('TUI needs @clack/prompts. Run instead: npx excalidrop setup owner/repo');
    process.exit(1);
  }
  clack.intro('excalidrop — remote canvas setup');

  const detected = detectSlug();
  const repoAnswer = await clack.text({
    message: 'Which repo holds the canvas?',
    placeholder: detected || 'owner/repo',
    initialValue: detected || '',
    validate: (v) => (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(v.trim()) ? undefined : 'Use owner/repo'),
  });
  if (clack.isCancel(repoAnswer)) { clack.cancel('Aborted.'); process.exit(0); }
  const slug = (repoAnswer as string).trim().toLowerCase();
  const priv = await isPrivateRepo(slug);
  if (priv !== null) clack.log.info(`Repo is ${priv ? 'private' : 'public'} — recommended host: ${priv ? 'Cloudflare Pages' : 'GitHub Pages'}.`);

  // Visibility drift: repo flipped public<->private since last setup, so the
  // stored target + viewer URL no longer match — nudge to re-pick below.
  try {
    const prevRaw = fs.readFileSync(path.join(findProjectRoot(process.cwd()), CONFIG_NAME), 'utf8');
    const prevTarget = (JSON.parse(prevRaw) as { target?: string }).target;
    const want = priv === true ? 'cloudflare' : 'pages';
    if (prevTarget && prevTarget !== want && priv !== null) {
      clack.log.warn(`Visibility changed since last setup (host: ${prevTarget}, repo now ${priv ? 'private' : 'public'}). Pick ${want} below to migrate — see README "Migrating public<->private".`);
    }
  } catch { /* first setup — nothing to compare */ }

  if (!ghAuthed() && !process.env.GITHUB_TOKEN) {
    const how = await clack.select({
      message: 'GitHub auth missing. How to log in?',
      options: [
        { value: 'retry', label: 'I ran `gh auth login` (re-check)' },
        { value: 'device', label: 'Device flow (code + browser, 2FA ok)' },
        { value: 'skip', label: 'Skip (I set GITHUB_TOKEN later)' },
      ],
    });
    if (clack.isCancel(how)) { clack.cancel('Aborted.'); process.exit(0); }
    if (how === 'device') {
      const s = clack.spinner();
      s.start('Waiting for browser approval…');
      try { await cmdLogin(); s.stop('Logged in.'); }
      catch (e) { s.stop('Login failed: ' + (e as Error).message); process.exit(1); }
    } else if (how === 'retry' && !ghAuthed() && !process.env.GITHUB_TOKEN) {
      clack.log.error('Still not logged in. Run `gh auth login` first.');
      process.exit(1);
    }
  }

  // No auto option: GitHub Pages can't serve private repos on free plans
  // and public repos need zero config, so visibility pre-selects the right
  // host — the user just confirms or flips. Non-interactive `--target` still
  // goes through resolveTarget() in cmdSetup.
  const recommended: HostTarget = priv === true ? 'cloudflare' : 'pages';
  const hostAnswer = await clack.select({
    message: 'Where to host the viewer?',
    initialValue: recommended,
    options: [
      { value: 'pages', label: 'GitHub Pages (public repo)', hint: 'zero config' },
      { value: 'cloudflare', label: 'Cloudflare Pages (private repo)', hint: 'needs wrangler login' },
    ],
  });
  if (clack.isCancel(hostAnswer)) { clack.cancel('Aborted.'); process.exit(0); }
  const target = hostAnswer as HostTarget;

  const projectRoot = findProjectRoot(process.cwd());
  const editorAnswer = await clack.multiselect({
    message: 'Install the MCP server into which editors? (already-current entries are skipped)',
    options: (Object.keys(EDITOR_LABELS) as EditorId[]).map((id) => {
      const st = detectEditorState(id, slug, projectRoot);
      const mark = st.status === 'current' ? ' [already installed]' : st.status === 'stale' ? ` [now → ${st.repo ?? 'unknown'}]` : '';
      return { value: id, label: `${EDITOR_LABELS[id]}${mark}` };
    }),
    initialValues: ['claude-project', 'codex'] as EditorId[],
    required: false,
  });
  if (clack.isCancel(editorAnswer)) { clack.cancel('Aborted.'); process.exit(0); }
  const editors = editorAnswer as EditorId[];

  const s = clack.spinner();
  s.start('Publishing viewer + wiring MCP…');
  let viewerUrl: string;
  let live = false;
  let installs: InstallResult[] = [];
  try {
    ({ viewerUrl, live, installs } = await cmdSetup(['--no-prompt', slug, `--target=${target}`], editors, { fromTui: true }));
    s.stop('Setup complete.');
  } catch (e) {
    s.stop('Setup failed: ' + (e as Error).message);
    process.exit(1);
  }

  // Always show what ran where: installing to user scope prints the command
  // itself; file writes print the path; stale entries print the update command.
  for (const r of installs) {
    const target = editorTarget(r.id, projectRoot);
    const cmd = editorCommand(r.id, slug).split('\n').join('\n  ');
    if (r.outcome === 'added') clack.log.success(`MCP → ${target}:\n  ${cmd}\n  ${r.detail}`);
    else if (r.outcome === 'already-current') clack.log.success(`MCP → ${target}: ${r.detail} — skipped.`);
    else if (r.outcome === 'stale') clack.log.warn(`MCP → ${target}: ${r.detail}`);
    else clack.log.warn(`MCP → ${target} failed: ${r.detail}`);
  }

  try {
    const scene = await getScene(slug);
    clack.log.success(`Scene readable: ${scene.elements.length} elements @${CANVAS_BRANCH}.`);
  } catch (e) {
    clack.log.warn(`Scene not readable yet: ${(e as Error).message} — draw once to create it.`);
  }
  if (live) clack.log.success('Viewer is serving.');
  else clack.log.warn('Viewer was not live after 7 minutes — check the Pages/Cloudflare build, then retry the URL.');

  clack.outro(live ? `Canvas live: ${viewerUrl}` : `Canvas pending: ${viewerUrl}`);
}

function printHelp(): void {
  console.log(`excalidrop — remote GitHub-backed canvas (no local server)

Usage:
  npx excalidrop                          interactive setup TUI
  npx excalidrop setup owner/repo [--target pages|cloudflare] [--editor claude-project,claude-user,codex,cursor,cursor-user,desktop,opencode,opencode-user] [--no-prompt]
  npx -y excalidrop@latest mcp --repo owner/repo   run MCP stdio server (editors use this)
  npx excalidrop login [--repo owner/repo]         GitHub device-flow login
  npx excalidrop publish owner/repo [--target ..]  redeploy viewer only
  npx excalidrop status                   show repo + auth + scene
  npx excalidrop add [owner/repo]         print editor install commands

No devDependency needed. Token: GITHUB_TOKEN → gh auth → ~/.config/excalidrop/gh_token.`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    if (!process.stdout.isTTY) { printHelp(); return; }
    await runTui();
    return;
  }
  switch (cmd) {
    case 'setup': await cmdSetup(rest); break;
    case 'mcp': cmdMcp(); break;
    case 'login': await cmdLogin(); break;
    case 'status': await cmdStatus(); break;
    case 'publish': await cmdSetup(['--no-prompt', ...rest]); break;
    case 'add': {
      const root = findProjectRoot(process.cwd());
      const ids = parseEditorsFlag(rest) || [...EDITOR_IDS];
      const repo = rest.find((a) => a.includes('/')) || detectSlug() || 'owner/repo';
      console.log('Add excalidrop to your AI agent (no install, always latest):\n');
      for (const id of ids) {
        const st = repo.includes('/') ? detectEditorState(id, repo, root) : null;
        const mark = st?.status === 'current' ? ' [already installed]' : st?.status === 'stale' ? ` [now → ${st.repo ?? 'unknown'}]` : '';
        console.log(`## ${EDITOR_LABELS[id]} → ${editorTarget(id, root)}${mark}\n${editorCommand(id, repo)}\n`);
      }
      break;
    }
    case 'init':
    case 'up':
    case 'remote':
      console.error(`\`excalidrop ${cmd}\` was removed (no local canvas). Run: npx excalidrop setup owner/repo`);
      process.exit(1);
      break;
    default: printHelp(); process.exitCode = 1;
  }
}

main().catch((err) => { console.error(`excalidrop: ${(err as Error).message}`); process.exit(1); });
