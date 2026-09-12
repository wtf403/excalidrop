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

async function ensureMainBranch(repo: string): Promise<void> {
  const main = await fetch(`${GH_API}/repos/${repo}/git/ref/heads/main`, { headers: ghHeaders() });
  if (main.ok) return;
  const branches = await (await fetch(`${GH_API}/repos/${repo}/branches`, { headers: ghHeaders() })).json() as any[];
  if (branches.length !== 0) return;
  await ghPut(`/repos/${repo}/contents/README.md`, {
    message: 'Initial commit',
    content: Buffer.from(`# ${repo.split('/')[1]}\n\nExcalidraw canvas powered by [excalidrop](https://github.com/wtf403/excalidrop).\n`).toString('base64'),
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

const EDITOR_IDS = ['claude-project', 'claude-user', 'codex', 'cursor', 'desktop', 'opencode'] as const;
type EditorId = (typeof EDITOR_IDS)[number];

function editorCommand(id: EditorId, repo: string): string {
  const a = mcpArgs(repo).join(' ');
  switch (id) {
    case 'claude-project': return `claude mcp add excalidrop --scope project -- npx ${a}`;
    case 'claude-user': return `claude mcp add excalidrop --scope user -- npx ${a}`;
    case 'codex': return `codex mcp add excalidrop -- npx ${a}`;
    case 'cursor': return JSON.stringify({ mcpServers: { excalidrop: { command: 'npx', args: mcpArgs(repo) } } }, null, 2);
    case 'desktop': return JSON.stringify({ mcpServers: { excalidrop: { command: 'npx', args: mcpArgs(repo) } } }, null, 2);
    case 'opencode': return JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { excalidrop: { type: 'local', command: ['npx', ...mcpArgs(repo)], enabled: true } } }, null, 2);
  }
}

function installEditor(id: EditorId, repo: string): boolean {
  try {
    if (id === 'claude-project' && commandExists('claude')) {
      return spawnSync('claude', ['mcp', 'add', 'excalidrop', '--scope', 'project', '--', 'npx', ...mcpArgs(repo)], { stdio: 'ignore' }).status === 0;
    }
    if (id === 'claude-user' && commandExists('claude')) {
      return spawnSync('claude', ['mcp', 'add', 'excalidrop', '--scope', 'user', '--', 'npx', ...mcpArgs(repo)], { stdio: 'ignore' }).status === 0;
    }
    if (id === 'codex' && commandExists('codex')) {
      return spawnSync('codex', ['mcp', 'add', 'excalidrop', '--', 'npx', ...mcpArgs(repo)], { stdio: 'ignore' }).status === 0;
    }
  } catch { /* fall through to manual */ }
  return false;
}

const EDITOR_LABELS: Record<EditorId, string> = {
  'claude-project': 'Claude Code (project scope)',
  'claude-user': 'Claude Code (user scope)',
  codex: 'Codex CLI',
  cursor: 'Cursor (.cursor/mcp.json)',
  desktop: 'Claude Desktop',
  opencode: 'OpenCode (opencode.json)',
};

function printEditorCommands(ids: EditorId[], repo: string): void {
  console.log('Add excalidrop to your AI agent (no install, always latest):\n');
  for (const id of ids) console.log(`## ${EDITOR_LABELS[id]}\n${editorCommand(id, repo)}\n`);
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

async function cmdSetup(args: string[], editorOverride?: EditorId[]): Promise<{ repo: string; viewerUrl: string }> {
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
  console.log(`Repo: ${slug}\nHost: ${target}${explicitTarget ? ' (explicit)' : ' (auto: private→cloudflare, public→pages)'}\n`);

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
  if (noPrompt) {
    const installed: EditorId[] = [];
    const manual: EditorId[] = [];
    for (const id of editors) (installEditor(id, slug) ? installed : manual).push(id);
    if (installed.length) console.log(`Installed into: ${installed.map((i) => EDITOR_LABELS[i]).join(', ')}`);
    if (manual.length) printEditorCommands(manual, slug);
    return { repo: slug, viewerUrl };
  }
  return { repo: slug, viewerUrl };
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

  const auto = await resolveTarget(slug);
  const hostAnswer = await clack.select({
    message: `Where to host the viewer? (auto: ${auto})`,
    options: [
      { value: 'auto', label: `Auto — ${auto === 'pages' ? 'GitHub Pages (public repo)' : 'Cloudflare Pages (private repo)'}`, hint: 'recommended' },
      { value: 'pages', label: 'GitHub Pages', hint: 'public repos, zero config' },
      { value: 'cloudflare', label: 'Cloudflare Pages', hint: 'private repos' },
    ],
  });
  if (clack.isCancel(hostAnswer)) { clack.cancel('Aborted.'); process.exit(0); }
  const target = (hostAnswer === 'auto' ? auto : hostAnswer) as 'pages' | 'cloudflare';

  const editorAnswer = await clack.multiselect({
    message: 'Install the MCP server into which editors?',
    options: (Object.keys(EDITOR_LABELS) as EditorId[]).map((id) => ({ value: id, label: EDITOR_LABELS[id] })),
    initialValues: ['claude-project', 'codex'] as EditorId[],
    required: false,
  });
  if (clack.isCancel(editorAnswer)) { clack.cancel('Aborted.'); process.exit(0); }
  const editors = editorAnswer as EditorId[];

  const s = clack.spinner();
  s.start('Publishing viewer + wiring MCP…');
  let viewerUrl: string;
  try {
    ({ viewerUrl } = await cmdSetup(['--no-prompt', slug, `--target=${target}`], editors));
    s.stop('Setup complete.');
  } catch (e) {
    s.stop('Setup failed: ' + (e as Error).message);
    process.exit(1);
  }

  for (const id of editors) {
    if (id === 'claude-project' || id === 'claude-user' || id === 'codex') {
      clack.log.success(`${EDITOR_LABELS[id]}: installed (or already present).`);
    } else {
      clack.log.info(`${EDITOR_LABELS[id]} config:\n${editorCommand(id, slug)}`);
    }
  }

  try {
    const scene = await getScene(slug);
    clack.log.success(`Scene readable: ${scene.elements.length} elements @${CANVAS_BRANCH}.`);
  } catch (e) {
    clack.log.warn(`Scene not readable yet: ${(e as Error).message} — draw once to create it.`);
  }
  try {
    const r = await fetch(viewerUrl, { signal: AbortSignal.timeout(15000) });
    if (r.ok) clack.log.success('Viewer is serving.');
    else clack.log.warn(`Viewer returned HTTP ${r.status} — Pages/Cloudflare may still be building; retry in a minute.`);
  } catch {
    clack.log.warn('Viewer not reachable yet — hosting may still be building; retry in a minute.');
  }

  clack.outro(`Canvas live: ${viewerUrl}`);
}

function printHelp(): void {
  console.log(`excalidrop — remote GitHub-backed canvas (no local server)

Usage:
  npx excalidrop                          interactive setup TUI
  npx excalidrop setup owner/repo [--target pages|cloudflare] [--editor claude-project,codex,cursor,desktop,opencode] [--no-prompt]
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
    case 'add': printEditorCommands(parseEditorsFlag(rest) || [...EDITOR_IDS], rest.find((a) => a.includes('/')) || detectSlug() || 'owner/repo'); break;
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
