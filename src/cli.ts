#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_NAME = '.excalidrop.json';
const MCP_JSON = '.mcp.json';
const SERVER_ENTRY = path.join(__dirname, 'server.js');
const MCP_ENTRY = path.join(__dirname, 'index.js');
const DEFAULT_START_PORT = 3030;
const PORT_SCAN_SIZE = 200;

interface DropConfig {
  port: number;
  canvasUrl: string;

  remote?: string;
}



function isPortFree(port: number, host = '127.0.0.1', timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host, port });
    const done = (free: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(false)); // something listens → taken
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true)); // ECONNREFUSED → free
  });
}

async function findFreePort(preferred?: number, start = DEFAULT_START_PORT): Promise<number> {
  if (preferred && preferred > 0 && preferred < 65536 && (await isPortFree(preferred))) {
    return preferred;
  }
  for (let port = start; port < start + PORT_SCAN_SIZE; port++) {
    if (await isPortFree(port)) return port;
  }
  for (let i = 0; i < 50; i++) {
    const port = 32000 + Math.floor(Math.random() * 2000);
    if (await isPortFree(port)) return port;
  }
  throw new Error('Could not find a free port for the excalidrop canvas server.');
}



function findProjectRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  const home = process.env.HOME || process.env.USERPROFILE || '/';
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return path.resolve(cwd);
    dir = parent;
  }
}

function findDropConfig(cwd: string): { dir: string; config: DropConfig } | null {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  while (true) {
    const file = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DropConfig>;
        if (typeof raw.port === 'number') {
          return {
            dir,
            config: {
              port: raw.port,
              canvasUrl: raw.canvasUrl || `http://127.0.0.1:${raw.port}`,
            },
          };
        }
      } catch {

      }
    }
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

function portFromExpressUrl(url: string | undefined): number | undefined {
  if (!url) return undefined;
  try {
    const port = Number(new URL(url).port);
    return Number.isFinite(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}


function resolveSavedPort(cwd: string): number {
  const envPort = Number(process.env.EXCALIDROP_PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  const envUrlPort = portFromExpressUrl(process.env.EXPRESS_SERVER_URL);
  if (envUrlPort) return envUrlPort;
  const found = findDropConfig(cwd);
  if (found) return found.config.port;
  return DEFAULT_START_PORT;
}



function mcpServerJson(): Record<string, unknown> {

  return {
    mcpServers: {
      excalidrop: {
        command: 'npx',
        args: ['excalidrop', 'mcp'],
      },
    },
  };
}

function agentCommands(): { name: string; command: string }[] {
  return [
    {
      name: 'Claude Code (project scope)',
      command: 'claude mcp add excalidrop --scope project -- npx excalidrop mcp',
    },
    {
      name: 'Claude Code (user scope)',
      command: 'claude mcp add excalidraw --scope user -- npx excalidrop mcp',
    },
    {
      name: 'Codex CLI',
      command: 'codex mcp add excalidrop -- npx excalidrop mcp',
    },
    {
      name: 'Gemini CLI',
      command: 'gemini mcp add excalidrop npx excalidrop mcp',
    },
    {
      name: 'Cursor (.cursor/mcp.json) / Claude Desktop / Antigravity',
      command: JSON.stringify(mcpServerJson(), null, 2),
    },
    {
      name: 'OpenCode (opencode.json)',
      command: JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: {
            excalidrop: {
              type: 'local',
              command: ['npx', 'excalidrop', 'mcp'],
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
    },
  ];
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function commandExists(cmd: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'command', ['-v', cmd], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  return probe.status === 0;
}



function detectSlug(): string {
  try {
    const url = spawnSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).stdout.trim().replace(/\.git$/, '');
    return url.match(/github\.com[:/](.+)/)?.[1] || '';
  } catch { return ''; }
}

function ghAuthed(): boolean {
  return spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
}

async function cmdInit(args: string[]): Promise<void> {
  const portFlag = args.find((a) => a.startsWith('--port='));
  const preferred = portFlag ? Number(portFlag.split('=')[1]) : undefined;
  const noPrompt = args.includes('--no-prompt') || args.includes('-y');
  const root = findProjectRoot(process.cwd());
  const slug = detectSlug();

  const port = await findFreePort(preferred);
  const config: DropConfig = { port, canvasUrl: `http://127.0.0.1:${port}`, ...(slug ? { remote: slug } : {}) };
  fs.writeFileSync(path.join(root, CONFIG_NAME), JSON.stringify(config, null, 2) + '\n');
  console.log(`\nexcalidrop: canvas port ${port} saved to ${path.join(root, CONFIG_NAME)}`);
  if (slug) console.log(`excalidrop: remote canvas preselected: ${slug} (agent uses it automatically)`);


  const scenePath = path.join(root, 'canvas.excalidraw');
  if (!fs.existsSync(scenePath)) {
    fs.writeFileSync(
      scenePath,
      JSON.stringify({ type: 'excalidraw', version: 2, source: 'excalidrop', elements: [], appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} }, null, 2) + '\n',
    );
    console.log(`excalidrop: empty scene written to ${scenePath}`);
  }


  const mcpPath = path.join(root, MCP_JSON);
  let mcp: Record<string, any> = {};
  if (fs.existsSync(mcpPath)) {
    try {
      mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    } catch {
      console.warn(`excalidrop: existing ${MCP_JSON} is not valid JSON, leaving it untouched.`);
    }
  }
  if (!mcp.mcpServers || typeof mcp.mcpServers !== 'object') mcp.mcpServers = {};
  mcp.mcpServers.excalidrop = { command: 'npx', args: ['excalidrop', 'mcp'] };
  if (Object.keys(mcp).length > 0) {
    fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
    console.log(`excalidrop: MCP server entry written to ${mcpPath}`);
  }

  console.log('\nStart the canvas for this project with:');
  console.log(`  npx excalidrop up   # ${config.canvasUrl}\n`);

  if (noPrompt) {
    printAgentCommands();
    return;
  }


  if (slug) {
    if (!ghAuthed()) {
      console.log('GitHub: not logged in. Run `gh auth login` first (2FA via GitHub), then re-run init.\n');
    } else {
      const pub = await prompt(`Publish an empty canvas to ${slug} (creates gh-pages + enables Pages)? [Y/n] `);
      if (!pub || /^(y|yes)$/i.test(pub)) {
        const r = spawnSync('bash', [path.join(__dirname, '../scripts/publish-pages.sh')], {
          stdio: 'inherit', env: { ...process.env, REPO_SLUG: slug },
        });
        if (r.status === 0) {
          const [owner, repo] = slug.split('/');
          console.log(`\nCanvas live at https://${owner}.github.io/${repo}/`);
          const appSlug = process.env.EXCALIDROP_APP_SLUG || 'excalidrop';
          console.log(`Install the app once per repo: https://github.com/apps/${appSlug}/installations/new`);
        }
      }
    }
  }

  const answer = await prompt('Install the excalidrop MCP server into your AI agent now? [Y/n] ');
  if (answer && !/^(y|yes)$/i.test(answer)) {
    printAgentCommands();
    return;
  }


  let installed = false;
  if (commandExists('claude')) {
    const scopeAnswer = await prompt('Claude Code scope? [project/user] (default: project) ');
    const scope = /user/i.test(scopeAnswer) ? 'user' : 'project';
    const r = spawnSync('claude', ['mcp', 'add', 'excalidrop', '--scope', scope, '--', 'npx', 'excalidrop', 'mcp'], {
      stdio: 'inherit',
    });
    installed = r.status === 0;
  }
  if (!installed && commandExists('codex')) {
    const useIt = await prompt('Run `codex mcp add excalidrop`? [Y/n] ');
    if (!useIt || /^(y|yes)$/i.test(useIt)) {
      const r = spawnSync('codex', ['mcp', 'add', 'excalidrop', '--', 'npx', 'excalidrop', 'mcp'], {
        stdio: 'inherit',
      });
      installed = r.status === 0;
    }
  }
  if (!installed) printAgentCommands();
}

function printAgentCommands(): void {
  console.log('Add excalidrop to your AI agent (same pattern as chrome-devtools-mcp):\n');
  for (const c of agentCommands()) {
    console.log(`## ${c.name}\n${c.command}\n`);
  }
}

async function cmdUp(args: string[]): Promise<void> {
  const portFlag = args.find((a) => a.startsWith('--port='));
  const preferred = portFlag ? Number(portFlag.split('=')[1]) : undefined;
  const root = findProjectRoot(process.cwd());
  const existing = findDropConfig(process.cwd());


  let port: number;
  if (preferred) {
    port = await findFreePort(preferred);
  } else if (existing && (await isPortFree(existing.config.port))) {
    port = existing.config.port;
  } else {
    port = await findFreePort(existing?.config.port ?? DEFAULT_START_PORT);
  }
  fs.writeFileSync(
    path.join(existing?.dir ?? root, CONFIG_NAME),
    JSON.stringify({ port, canvasUrl: `http://127.0.0.1:${port}` } satisfies DropConfig, null, 2) + '\n',
  );

  const host = process.env.HOST || '127.0.0.1';
  console.log(`excalidrop: starting canvas on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port), HOST: host },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

function cmdMcp(): void {

  const port = resolveSavedPort(process.cwd());
  const canvasUrl = process.env.EXPRESS_SERVER_URL || `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [MCP_ENTRY], {
    stdio: 'inherit',
    env: { ...process.env, EXPRESS_SERVER_URL: canvasUrl },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdStatus(): Promise<void> {
  const found = findDropConfig(process.cwd());
  const port = found?.config.port ?? resolveSavedPort(process.cwd());
  const url = process.env.EXPRESS_SERVER_URL || `http://127.0.0.1:${port}`;
  console.log(`config: ${found ? path.join(found.dir, CONFIG_NAME) : '(none — using defaults)'}`);
  console.log(`canvas: ${url}`);
  try {
    const res = await fetch(`${url}/health`);
    console.log(`health: ${res.ok ? 'ok' : `HTTP ${res.status}`} ${res.ok ? '' : await res.text()}`);
    if (res.ok) console.log(await res.text());
  } catch (err) {
    console.log(`health: unreachable (${(err as Error).message}) — start it with \`npx excalidrop up\``);
  }
}

async function cmdPages(_args: string[]): Promise<void> {
  console.log(`excalidrop pages (GitHub as source of truth, no Actions, no setup)\n`);
  console.log('1. Publish viewer: npx excalidrop publish');
  console.log('   (uses `gh auth` — repo auto-detected, Pages auto-enabled.)\n');
  console.log('2. In your agent: switch_remote { target: "<owner>.github.io/<repo>" }');
  console.log('   Draw as usual — commits land on GitHub, viewer updates on gh-pages.\n');
  console.log('3. Login: click Login with GitHub on the canvas (installs the app on the repo),');
  console.log('   or ask the agent to run github_login (device flow, 2FA via GitHub).\n');
  console.log('Rule: never edit the canvas locally — the Pages site + GitHub repo are the canvas.');
}

function cmdRemote(): void {
  const child = spawn(process.execPath, [path.join(__dirname, 'remote.js')], { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdSetup(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npx excalidrop setup\n\nChecks `gh auth`, publishes the viewer to this repo\'s gh-pages\n(enabling Pages if needed), then prints the app-install link and next steps.');
    return;
  }
  console.log('excalidrop setup — works on any repo you own or can access\n');
  // 1. gh auth (the only prerequisite; 2FA enforced by GitHub itself)
  const auth = spawnSync('gh', ['auth', 'status'], { stdio: 'pipe', encoding: 'utf8' });
  if (auth.status !== 0) {
    console.error('Not logged in to GitHub. Run this first:\n\n  gh auth login\n');
    process.exit(1);
  }
  const slug = (() => {
    try {
      const url = spawnSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).stdout.trim().replace(/\.git$/, '');
      const m = url.match(/github\.com[:/](.+)/);
      return m?.[1] || '';
    } catch { return ''; }
  })();
  if (!slug) {
    console.error('No GitHub remote detected. Run setup inside a cloned repo.\n');
    process.exit(1);
  }
  console.log(`Repo: ${slug} (detected from git remote)\n`);
  // 2. publish viewer (auto-enables Pages, auto-syncs scene)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', [path.join(__dirname, '../scripts/publish-pages.sh')], { stdio: 'inherit', env: { ...process.env, REPO_SLUG: slug } });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`publish failed (exit ${code})`))));
  });
  // 3. remember the target: agent auto-loads it, no switch_remote needed
  try {
    const cfgFile = path.join(process.cwd(), CONFIG_NAME);
    const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
    fs.writeFileSync(cfgFile, JSON.stringify({ port: cfg.port || 3030, canvasUrl: cfg.canvasUrl || 'http://127.0.0.1:3030', ...cfg, remote: slug }, null, 2) + '\n');
    console.log(`Remote target remembered in ${CONFIG_NAME} (agent uses it automatically).`);
  } catch { /* non-fatal */ }
  // 4. verify: Pages serves the viewer AND the scene file
  const [sOwner, sRepo] = slug.split('/');
  let verified = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const res = await fetch(`https://${sOwner}.github.io/${sRepo}/canvas.excalidraw`, { signal: AbortSignal.timeout(15000) });
      if (res.ok) { verified = true; break; }
    } catch { /* Pages build still running */ }
  }
  console.log(verified ? 'Verified: viewer + scene live.' : 'Note: Pages still building — check back in a minute.');
  // 4. next steps: install the shared app + draw
  const appSlug = process.env.EXCALIDROP_APP_SLUG || 'excalidrop';
  console.log(`\nDone. Your canvas: https://${sOwner}.github.io/${sRepo}/\n`);
  console.log('Two remaining clicks (one time per repo):');
  console.log(`  1. Install the Excalidrop app on this repo:\n     https://github.com/apps/${appSlug}/installations/new\n`);
  console.log('  2. In your agent: switch_remote { target: "<that canvas URL>" }');
  console.log('     then draw — commits land on GitHub, the viewer updates itself.');
  console.log('\nLogin on the page: Login with GitHub button → install the app on the repo (2FA via GitHub).');
}

async function cmdLogin(): Promise<void> {
  const { APP_CLIENT_ID } = await import('./target.js');
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID || APP_CLIENT_ID;
  if (!clientId) {
    console.error('No GitHub App Client ID configured yet.');
    console.error('Set GITHUB_OAUTH_CLIENT_ID (or wait for the shared excalidrop app),');
    console.error('or just run `gh auth login` — the MCP picks that token up automatically.');
    process.exit(1);
  }
  // Dynamic import to avoid loading MCP deps in CLI path
  const mod = await import('./target.js');
  console.log('Starting GitHub device login…');
  const dev = await mod.deviceStart(clientId);
  console.log(`\nOpen ${dev.verification_uri} and enter code: ${dev.user_code}\n`);
  const repoId = undefined; // unrestricted; pass --repo owner/repo? (future: parse argv)
  const token = await mod.devicePoll(clientId, dev.device_code, dev.interval || 5, 300, repoId);
  console.log('Logged in — token stored in ~/.config/excalidrop/gh_token');
  void token;
}

function printHelp(): void {
  console.log(`excalidrop — drop an Excalidraw canvas + MCP server into any project

Usage:
  npx excalidrop init [--port=N] [--no-prompt]  pick a free port, write .excalidrop.json + .mcp.json
  npx excalidrop up [--port=N]                  start this project's canvas server
  npx excalidrop setup                        one-command setup on any repo (gh auth + publish + guide)
  npx excalidrop login                        GitHub device-flow login from the terminal
  npx excalidrop pages                        GitHub-truth + gh-pages publish guide
  npx excalidrop remote                       run remote MCP-v2 (GitHub-backed, multi-project)
  npx excalidrop publish                      publish viewer straight to gh-pages (no Actions)
  npx excalidrop mcp                            run MCP stdio server (used by AI agents)
  npx excalidrop status                         show port + canvas health
  npx excalidrop add                            print AI-agent install commands

Install:
  npm i -D excalidrop && npx excalidrop init

Each project gets its own port (scanned free from ${DEFAULT_START_PORT}), so several
checkouts can run concurrently. Agent config needs no hardcoded port.`);
}



async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'init':
      await cmdInit(rest);
      break;
    case 'up':
      await cmdUp(rest);
      break;
    case 'mcp':
      cmdMcp();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'pages':
      await cmdPages(rest);
      break;
    case 'remote':
      cmdRemote();
      break;
    case 'setup':
      await cmdSetup(rest);
      break;
    case 'login':
      await cmdLogin();
      break;
    case 'publish': {
      const child = spawn('bash', [path.join(__dirname, '../scripts/publish-pages.sh')], { stdio: 'inherit', env: process.env });
      child.on('exit', (code) => process.exit(code ?? 0));
      break;
    }
    case 'add':
      printAgentCommands();
      break;
    default:
      printHelp();
      if (cmd && cmd !== '--help' && cmd !== '-h') process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`excalidrop: ${(err as Error).message}`);
  process.exit(1);
});
