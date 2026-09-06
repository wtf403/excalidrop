#!/usr/bin/env node
/**
 * excalidrop — per-project Excalidraw canvas + MCP server setup.
 *
 * Modelled on the `chrome-devtools-mcp` install pattern (`npx -y <pkg>` +
 * `mcpServers` JSON), with one addition: per-project dynamic port selection
 * so multiple checkouts can run their own canvas concurrently.
 *
 * How the dynamic port works:
 *  - `excalidrop init` picks a free port (default scan from 3030) and writes
 *    it to `.excalidrop.json` in the project root.
 *  - `excalidrop mcp` (what the AI agent runs via stdio) resolves that same
 *    file by walking up from cwd, so each project transparently gets its own
 *    canvas URL with nothing hardcoded in the agent config.
 *
 * Commands:
 *  init   pick a port, write .excalidrop.json + .mcp.json, offer agent install
 *  up     start the canvas server on this project's port
 *  mcp    run the MCP stdio server pointed at this project's canvas (for agents)
 *  status show resolved port + canvas health
 *  add    print / run AI-agent install commands
 */

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
}

// ─── port utils ──────────────────────────────────────────────────────────────

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
  // Fallback: random high port
  for (let i = 0; i < 50; i++) {
    const port = 32000 + Math.floor(Math.random() * 2000);
    if (await isPortFree(port)) return port;
  }
  throw new Error('Could not find a free port for the excalidrop canvas server.');
}

// ─── config discovery ────────────────────────────────────────────────────────

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
        // corrupt config → ignore, treat as missing
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

/** Resolve this project's canvas port without side effects (used by `mcp`). */
function resolveSavedPort(cwd: string): number {
  const envPort = Number(process.env.EXCALIDROP_PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  const envUrlPort = portFromExpressUrl(process.env.EXPRESS_SERVER_URL);
  if (envUrlPort) return envUrlPort;
  const found = findDropConfig(cwd);
  if (found) return found.config.port;
  return DEFAULT_START_PORT;
}

// ─── agent config snippets (chrome-devtools-mcp style) ───────────────────────

function mcpServerJson(): Record<string, unknown> {
  // No hardcoded port: `excalidrop mcp` resolves `.excalidrop.json` at runtime,
  // so the same snippet works for every project, concurrently.
  return {
    mcpServers: {
      excalidrop: {
        command: 'npx',
        args: ['-y', 'excalidrop', 'mcp'],
      },
    },
  };
}

function agentCommands(): { name: string; command: string }[] {
  return [
    {
      name: 'Claude Code (project scope)',
      command: 'claude mcp add excalidrop --scope project -- npx -y excalidrop mcp',
    },
    {
      name: 'Claude Code (user scope)',
      command: 'claude mcp add excalidraw --scope user -- npx -y excalidrop mcp',
    },
    {
      name: 'Codex CLI',
      command: 'codex mcp add excalidrop -- npx -y excalidrop mcp',
    },
    {
      name: 'Gemini CLI',
      command: 'gemini mcp add excalidrop npx -y excalidrop mcp',
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
              command: ['npx', '-y', 'excalidrop', 'mcp'],
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

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdInit(args: string[]): Promise<void> {
  const portFlag = args.find((a) => a.startsWith('--port='));
  const preferred = portFlag ? Number(portFlag.split('=')[1]) : undefined;
  const noPrompt = args.includes('--no-prompt') || args.includes('-y');
  const root = findProjectRoot(process.cwd());

  const port = await findFreePort(preferred);
  const config: DropConfig = { port, canvasUrl: `http://127.0.0.1:${port}` };
  fs.writeFileSync(path.join(root, CONFIG_NAME), JSON.stringify(config, null, 2) + '\n');
  console.log(`\nexcalidrop: canvas port ${port} saved to ${path.join(root, CONFIG_NAME)}`);

  // Merge into .mcp.json (generic MCP clients + Claude Code project scope)
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
  mcp.mcpServers.excalidrop = { command: 'npx', args: ['-y', 'excalidrop', 'mcp'] };
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

  const answer = await prompt('Install the excalidrop MCP server into your AI agent now? [Y/n] ');
  if (answer && !/^(y|yes)$/i.test(answer)) {
    printAgentCommands();
    return;
  }

  // Try the CLIs that exist; fall back to printing snippets.
  let installed = false;
  if (commandExists('claude')) {
    const scopeAnswer = await prompt('Claude Code scope? [project/user] (default: project) ');
    const scope = /user/i.test(scopeAnswer) ? 'user' : 'project';
    const r = spawnSync('claude', ['mcp', 'add', 'excalidrop', '--scope', scope, '--', 'npx', '-y', 'excalidrop', 'mcp'], {
      stdio: 'inherit',
    });
    installed = r.status === 0;
  }
  if (!installed && commandExists('codex')) {
    const useIt = await prompt('Run `codex mcp add excalidrop`? [Y/n] ');
    if (!useIt || /^(y|yes)$/i.test(useIt)) {
      const r = spawnSync('codex', ['mcp', 'add', 'excalidrop', '--', 'npx', '-y', 'excalidrop', 'mcp'], {
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

  // Reuse the saved port if it's still free (stable URL per project),
  // otherwise claim a new one so concurrent projects never collide.
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
  // What the agent runs over stdio. Port resolves per-project at runtime.
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

function printHelp(): void {
  console.log(`excalidrop — drop an Excalidraw canvas + MCP server into any project

Usage:
  npx excalidrop init [--port=N] [--no-prompt]  pick a free port, write .excalidrop.json + .mcp.json
  npx excalidrop up [--port=N]                  start this project's canvas server
  npx excalidrop mcp                            run MCP stdio server (used by AI agents)
  npx excalidrop status                         show port + canvas health
  npx excalidrop add                            print AI-agent install commands

Install:
  npm i -D excalidrop && npx excalidrop init

Each project gets its own port (scanned free from ${DEFAULT_START_PORT}), so several
checkouts can run concurrently. Agent config needs no hardcoded port.`);
}

// ─── entry ───────────────────────────────────────────────────────────────────

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
