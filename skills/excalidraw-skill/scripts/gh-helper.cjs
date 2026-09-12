/* Shared helper for remote-only skill scripts: GitHub is the canvas. */
const { execSync } = require('node:child_process');

const BRANCH = process.env.CANVAS_BRANCH || 'excalidrop';
const SCENE_PATH = process.env.SCENE_PATH || 'canvas.excalidraw';

function repoFromArgs(args, envDefault) {
  const i = args.findIndex((a) => a === '--repo');
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const flag = args.find((a) => a.startsWith('--repo='));
  if (flag) return flag.split('=').slice(1).join('=');
  if (process.env.EXCALIDROP_REPO) return process.env.EXCALIDROP_REPO;
  if (envDefault) return envDefault;
  try {
    const url = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim().replace(/\.git$/, '');
    const m = url.match(/github\.com[:/](.+)/);
    if (m) return m[1].toLowerCase();
  } catch { /* ignore */ }
  return null;
}

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function headers() {
  return { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'excalidrop-skill', 'Content-Type': 'application/json' };
}

async function getScene(repo) {
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${SCENE_PATH}?ref=${BRANCH}`, { headers: headers() });
  if (r.status === 404) return { elements: [], files: [], sha: null };
  if (!r.ok) throw new Error(`GitHub get ${r.status}: ${await r.text()}`);
  const j = await r.json();
  // Contents API omits `content` for files >1MB — fall back to the blob API.
  let b64 = typeof j.content === 'string' && j.content.length ? j.content : null;
  if (!b64) {
    const blob = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${j.sha}`, { headers: headers() });
    if (!blob.ok) throw new Error(`GitHub blob ${blob.status}`);
    b64 = (await blob.json()).content || null;
  }
  if (!b64) return { elements: [], files: [], sha: j.sha || null };
  const doc = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  return { elements: doc.elements || [], files: doc.files || [], sha: j.sha };
}

async function putScene(repo, elements, files, sha, message) {
  const body = { message, content: Buffer.from(JSON.stringify({ type: 'excalidraw', version: 2, source: 'excalidrop', elements, files: files || {} }, null, 2)).toString('base64'), branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${SCENE_PATH}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub put ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).content.sha;
}

module.exports = { BRANCH, SCENE_PATH, repoFromArgs, token, getScene, putScene };
