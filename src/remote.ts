#!/usr/bin/env node
import express, { type Express } from 'express';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import { generateId } from './types.js';
import { loadScene, allowedRepos, currentRepo, SCENE_PATH } from './utils/github.js';

dotenv.config();
const app: Express = express();
app.use(express.json({ limit: '10mb' }));
const BEARER = process.env.MCP_BEARER || '';
if (!BEARER) logger.warn('MCP_BEARER not set — remote is open (set it in production)');

interface ProjectState { repo: string; elements: Map<string, any>; files: Map<string, any>; sha: string | null; dirty: boolean; }
const sessions = new Map<string, ProjectState>(); // session -> project state
let commitTimer: ReturnType<typeof setTimeout> | null = null;

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (BEARER && req.headers.authorization !== `Bearer ${BEARER}`) return res.status(401).json({ error: 'bad bearer' });
  next();
});
app.get('/health', (_req, res) => res.json({ ok: true, sessions: sessions.size }));
app.get('/mcp/projects', (_req, res) => res.json({ allowed: allowedRepos(), scenePath: SCENE_PATH }));

app.post('/mcp/use_project', async (req, res) => {
  try {
    let { session, repo } = req.body;
    if (!session) return res.status(400).json({ error: 'session required' });
    repo = repo || currentRepo();
    if (!repo) return res.status(400).json({ error: 'no repo given and none detected from git remote' });
    const { elements, files, sha } = await loadScene(repo);
    const st: ProjectState = { repo, elements: new Map(elements.map((e: any) => [e.id, e])), files: new Map(files.map((f: any) => [f.id, f])), sha, dirty: false };
    sessions.set(session, st);
    res.json({ ok: true, session, repo, elements: elements.length, sha });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

function need(req: any): ProjectState {
  const st = sessions.get(req.body.session);
  if (!st) throw new Error('call use_project first for this session');
  return st;
}

// Pure content save with merge-on-conflict: if someone else committed
// underneath us, fold their elements/files into the session map (ours win
// per id) and retry once — saves compose, never wipe.
async function saveMerged(st: ProjectState, msg: string): Promise<void> {
  const gh = await import('./utils/github.js');
  const els = () => Array.from(st.elements.values());
  const files = () => Array.from(st.files.values());
  try {
    st.sha = await gh.saveScene(st.repo, els(), files(), st.sha, msg);
  } catch (e) {
    if (!(e instanceof gh.SceneConflictError)) throw e;
    gh.unionIntoMap(st.elements, e.freshElements);
    const freshFiles = Array.isArray((e as any).freshFiles) ? (e as any).freshFiles as any[] : [];
    for (const f of freshFiles) if (f?.id && !st.files.has(f.id)) st.files.set(f.id, f);
    st.sha = (e as any).freshSha;
    st.sha = await gh.saveScene(st.repo, els(), files(), st.sha, msg);
  }
  st.dirty = false;
}
function scheduleCommit(st: ProjectState): void {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(async () => {
    if (!st.dirty) return;
    try {
      const els = Array.from(st.elements.values());
      const files = Array.from(st.files.values());
      await saveMerged(st, `excalidrop: update ${els.length} elements`);
    } catch (e) { logger.warn('commit failed: ' + (e as Error).message); }
  }, Number(process.env.COMMIT_DEBOUNCE_MS || 15000));
}

app.post('/mcp/commit', async (req, res) => {
  try {
    const st = need(req);
    const els = Array.from(st.elements.values());
    await saveMerged(st, req.body.message || `excalidrop: update ${els.length} elements`);
    res.json({ ok: true, sha: st.sha, count: els.length });
  } catch (e) { res.status(409).json({ error: (e as Error).message }); }
});

app.post('/mcp/:tool', async (req, res) => {
  try {
    const st = need(req);
    const { tool } = req.params;
    const a = req.body.args || {};
    let out: any = {};
    if (tool === 'describe_scene') out = { count: st.elements.size, elements: Array.from(st.elements.values()).slice(0, 200) };
    else if (tool === 'create_element') { const el = { id: a.id || generateId(), ...a, version: 1 }; st.elements.set(el.id, el); out = { element: el }; }
    else if (tool === 'batch_create_elements') { const made = (a.elements || []).map((e: any) => ({ id: e.id || generateId(), ...e, version: 1 })); made.forEach((e: any) => st.elements.set(e.id, e)); out = { elements: made }; }
    else if (tool === 'update_element') { const cur = st.elements.get(a.id); if (!cur) throw new Error('not found'); const u = { ...cur, ...a }; st.elements.set(a.id, u); out = { element: u }; }
    else if (tool === 'delete_element') { st.elements.delete(a.id); out = { deleted: a.id }; }
    else if (tool === 'clear_canvas') { st.elements.clear(); out = { cleared: true }; }
    else if (tool === 'add_image') {
      const dataURL = a.dataURL || a.source;
      if (!dataURL || typeof dataURL !== 'string' || !dataURL.startsWith('data:')) throw new Error('add_image requires dataURL or http(s) source resolving to a dataURL');
      const mm = /^data:([^;]+);base64,/.exec(dataURL);
      if (!mm) throw new Error('Invalid dataURL');
      const fileId = generateId();
      st.files.set(fileId, { id: fileId, dataURL, mimeType: a.mimeType || mm[1], created: Date.now() });
      const el = { id: generateId(), type: 'image', x: a.x ?? 0, y: a.y ?? 0, width: a.width ?? 400, height: a.height ?? 300, fileId, status: 'saved', scale: [1, 1], version: 1 };
      st.elements.set(el.id, el);
      out = { element: el, fileId };
    }
    else if (tool === 'query_elements') { out = { elements: Array.from(st.elements.values()).filter(e => !a.type || e.type === a.type) }; }
    else return res.status(404).json({ error: 'unknown tool' });
    st.dirty = true;
    scheduleCommit(st);
    res.json({ ok: true, session: req.body.session, repo: st.repo, ...out });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

const PORT = Number(process.env.MCP_PORT || 3100);
app.listen(PORT, '127.0.0.1', () => logger.info(`MCP-v2 remote on 127.0.0.1:${PORT}`));
export default app;
