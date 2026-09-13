// Stateless MCP route (spec 2026-07-28) — single universal endpoint.
// POST /mcp with JSON-RPC body. No initialize handshake, no session ids.
// Every canvas tool takes an explicit `repo` arg (owner/name); the caller's
// GitHub token arrives per request as `Authorization: Bearer ...`.
// Pure-GitHub tools run here directly; viewer-live tools (screenshot,
// viewport, export, mermaid) fan out to the per-repo RelayRoom DO.

const MCP_VERSION = '2026-07-28';
const SERVER_NAME = 'excalidrop';
const SERVER_VERSION = '2.0.0';
const SCENE_PATH = 'canvas.excalidraw';
const CANVAS_BRANCH = 'excalidrop';
const GH_API = 'https://api.github.com';
const TOOL_LIST_TTL_MS = 3600000;

// --- base64 helpers (Workers have no Node Buffer)
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(String(b64).replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// --- best-effort quotas (per isolate; resets on evict — honest 429 either way)
const DAY = () => new Date().toISOString().slice(0, 10);
let dailyCount = 0;
let dailyDay = DAY();
const DAILY_BUDGET = 90000; // below the 100k plan cap so headroom remains for /relay + /exchange
const rate = new Map(); // key -> {count, reset}
function rateOk(key, limit, windowMs) {
  const now = Date.now();
  const cur = rate.get(key);
  if (!cur || now > cur.reset) { rate.set(key, { count: 1, reset: now + windowMs }); return true; }
  cur.count += 1;
  return cur.count <= limit;
}
function quotaError() {
  return {
    error: 'shared relay daily budget exhausted (resets 00:00 UTC). ' +
      'Re-run `npx excalidrop setup --relay self` to deploy a relay into your own Cloudflare account (free 100k/day) and use its /mcp URL instead.',
    quota: 'daily', reset: '00:00 UTC',
  };
}

// --- per-token default repo (switch_remote). In-memory per isolate, 24h TTL.
const defaults = new Map(); // tokenHash -> {repo, at}
function hashToken(t) {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
function defaultRepo(token) {
  const d = defaults.get(hashToken(token));
  if (!d || Date.now() - d.at > 86400000) return null;
  return d.repo;
}

// --- auth cache: pull-only 10min, push 60s (mirrors relay.js)
const authCache = new Map();
async function verifyAccess(token, repo, needPush) {
  const key = `${hashToken(token)}:${repo.toLowerCase()}`;
  const cached = authCache.get(key);
  if (cached) {
    const ttl = cached.push ? 60000 : 600000;
    if (Date.now() - cached.at < ttl) {
      if (needPush && !cached.push) return { ok: false, status: 403 };
      if (!cached.pull) return { ok: false, status: 403 };
      return { ok: true, login: cached.login };
    }
  }
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'excalidrop-mcp' };
  const r = await fetch(`${GH_API}/repos/${repo}`, { headers }).catch(() => null);
  if (!r || r.status === 404) return { ok: false, status: 404 };
  if (r.status === 401) return { ok: false, status: 403 };
  if (!r.ok) return { ok: false, status: 403 };
  const j = await r.json().catch(() => ({}));
  const pull = !!(j.permissions?.pull ?? true);
  const push = !!j.permissions?.push;
  if (!pull || (needPush && !push)) return { ok: false, status: 403 };
  const me = await fetch(`${GH_API}/user`, { headers }).then((x) => x.json()).catch(() => ({}));
  authCache.set(key, { at: Date.now(), login: me.login || '?', pull, push });
  return { ok: true, login: me.login || '?' };
}

// --- GitHub scene IO (stateless: read-modify-write per call, sha-guarded)
function ghHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'excalidrop-mcp', 'Content-Type': 'application/json' };
}
async function getScene(repo, token) {
  const r = await fetch(`${GH_API}/repos/${repo}/contents/${SCENE_PATH}?ref=${CANVAS_BRANCH}`, { headers: ghHeaders(token) });
  if (r.status === 404) return { doc: null, sha: null };
  if (!r.ok) throw new Error(`scene read ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const j = await r.json();
  let b64 = typeof j.content === 'string' && j.content.length ? j.content : null;
  if (!b64) {
    const blob = await fetch(`${GH_API}/repos/${repo}/git/blobs/${j.sha}`, { headers: ghHeaders(token) });
    if (!blob.ok) throw new Error(`scene blob ${blob.status}`);
    b64 = (await blob.json()).content || null;
  }
  if (!b64) throw new Error('scene returned no content');
  return { doc: JSON.parse(b64decode(b64)), sha: j.sha };
}
async function putScene(repo, token, doc, message, sha) {
  const body = { message, content: b64encode(JSON.stringify(doc, null, 2)), branch: CANVAS_BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(`${GH_API}/repos/${repo}/contents/${SCENE_PATH}`, { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(body) });
  if (r.status === 404) throw new Error(`branch ${CANVAS_BRANCH} missing — open the canvas viewer once to initialize it`);
  if (r.status === 409 || r.status === 422) return { conflict: true, status: r.status };
  if (!r.ok) throw new Error(`scene write ${r.status}: ${(await r.text()).slice(0, 150)}`);
  return { sha: (await r.json()).content.sha };
}
function sceneDoc(elements, files) {
  return {
    type: 'excalidraw', version: 2, source: 'excalidrop',
    elements: elements || [],
    ...(files?.length ? { files } : {}),
  };
}
// Read → mutate → write with one conflict retry (union-merge fresh elements).
async function mutateScene(repo, token, message, fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { doc, sha } = await getScene(repo, token);
    const elements = [...(doc?.elements || [])];
    const filesMap = new Map();
    const rawFiles = doc?.files;
    for (const f of (Array.isArray(rawFiles) ? rawFiles : (rawFiles ? [rawFiles] : []))) if (f?.id) filesMap.set(f.id, f);
    const out = fn(elements, filesMap) || {};
    const res = await putScene(repo, token, sceneDoc(elements, [...filesMap.values()]), message || out.message || `excalidrop: update ${elements.length} elements`, sha || undefined);
    if (!res.conflict) return { elements, count: elements.length, sha: res.sha, extra: out };
    // conflict: merge upstream newcomers, retry once
    const fresh = await getScene(repo, token).catch(() => null);
    if (fresh?.doc?.elements) {
      const ids = new Set(elements.map((e) => e.id));
      for (const el of fresh.doc.elements) if (el?.id && !ids.has(el.id)) elements.push(el);
    }
  }
  throw new Error('scene conflict: retry the call');
}

// --- element helpers (mirrors mcp.ts buildElement)
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}
function normalizeFontFamily(ff) {
  if (ff === undefined) return undefined;
  if (typeof ff === 'number') return ff;
  const map = {
    virgil: 1, hand: 1, handwritten: 1, helvetica: 2, sans: 2, 'sans-serif': 2,
    cascadia: 3, mono: 3, monospace: 3, excalifont: 5, nunito: 6,
    lilita: 7, 'lilita one': 7, 'comic shanns': 8, comic: 8,
    1: 1, 2: 2, 3: 3, 5: 5, 6: 6, 7: 7, 8: 8,
  };
  return map[String(ff).toLowerCase()];
}
function toLabel(el) {
  const { text, ...rest } = el;
  if (text && el.type !== 'text') return { ...rest, label: { text } };
  return el;
}
function buildElement(d) {
  const { startElementId, endElementId, id: customId, points, ...rest } = d;
  const normPoints = points ? points.map((p) => (Array.isArray(p) ? p : [p.x, p.y])) : undefined;
  const now = new Date().toISOString();
  const el = {
    id: customId || generateId(), ...rest,
    ...(normPoints ? { points: normPoints } : {}),
    ...(startElementId ? { start: { id: startElementId } } : {}),
    ...(endElementId ? { end: { id: endElementId } } : {}),
    createdAt: now, updatedAt: now, version: 1,
  };
  if (el.fontFamily !== undefined) el.fontFamily = normalizeFontFamily(el.fontFamily);
  if ((startElementId || endElementId) && !normPoints) el.points = [[0, 0], [100, 0]];
  return toLabel(el);
}
function parseRepo(input) {
  const s = String(input || '').trim().replace(/\/$/, '');
  const m = s.match(/^https?:\/\/([a-z0-9-]+)\.github\.io\/([a-z0-9_.-]+)/i);
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(s)) return s.toLowerCase();
  throw new Error(`Cannot parse repo from "${input}" — use owner/repo`);
}
function needRepo(args, token) {
  const raw = args?.repo || defaultRepo(token);
  if (!raw) throw new Error('no repo: pass { repo: "owner/name" } or call switch_remote first');
  return parseRepo(raw);
}

// --- viewer-live fan-out via the per-repo DO (same room viewers dial)
async function viaDo(env, repo, token, method, args) {
  if (!env.RELAY) throw new Error('relay not configured on this deployment');
  const id = env.RELAY.idFromName(`repo:${repo.toLowerCase()}`);
  const stub = env.RELAY.get(id);
  const r = await stub.fetch(new Request(`https://internal/rpc?repo=${encodeURIComponent(repo.toLowerCase())}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args: args || {} }),
  }));
  const j = await r.json().catch(() => null);
  if (r.status === 503) throw new Error(`No viewer connected for ${repo} — open the canvas URL in a browser first.`);
  if (!r.ok) throw new Error(j?.error || `viewer rpc ${r.status}`);
  return j;
}

// --- tool catalog (schemas mirror mcp.ts stdio tools + required repo)
const TYPES = ['rectangle', 'ellipse', 'diamond', 'arrow', 'text', 'line', 'freedraw', 'image'];
const EL_PROPS = {
  id: { type: 'string' }, type: { type: 'string', enum: TYPES },
  x: { type: 'number' }, y: { type: 'number' },
  width: { type: 'number' }, height: { type: 'number' },
  backgroundColor: { type: 'string' }, strokeColor: { type: 'string' },
  strokeWidth: { type: 'number' }, strokeStyle: { type: 'string' },
  roughness: { type: 'number' }, opacity: { type: 'number' },
  text: { type: 'string' }, fontSize: { type: 'number' },
  fontFamily: { type: ['string', 'number'] },
  startElementId: { type: 'string' }, endElementId: { type: 'string' },
  endArrowhead: { type: 'string' }, startArrowhead: { type: 'string' },
};
const REPO_PROP = { repo: { type: 'string', description: 'Canvas repo as owner/name. Omit only after switch_remote.' } };
const TOOLS = [
  { name: 'create_element', description: 'Create a new element on the canvas. For arrows, use startElementId/endElementId to bind to shapes.', inputSchema: { type: 'object', properties: { ...REPO_PROP, ...EL_PROPS }, required: ['type', 'x', 'y'] } },
  { name: 'batch_create_elements', description: 'Create multiple elements at once. Assign custom id to shapes so arrows can reference them via startElementId/endElementId.', inputSchema: { type: 'object', properties: { ...REPO_PROP, elements: { type: 'array', items: { type: 'object', properties: EL_PROPS, required: ['type', 'x', 'y'] } } }, required: ['elements'] } },
  { name: 'update_element', description: 'Update an existing element', inputSchema: { type: 'object', properties: { ...REPO_PROP, ...EL_PROPS }, required: ['id'] } },
  { name: 'delete_element', description: 'Delete an element', inputSchema: { type: 'object', properties: { ...REPO_PROP, id: { type: 'string' } }, required: ['id'] } },
  { name: 'get_element', description: 'Get a single element by ID', inputSchema: { type: 'object', properties: { ...REPO_PROP, id: { type: 'string' } }, required: ['id'] } },
  { name: 'query_elements', description: 'Query elements with optional filters', inputSchema: { type: 'object', properties: { ...REPO_PROP, type: { type: 'string', enum: TYPES }, filter: { type: 'object', additionalProperties: true }, bbox: { type: 'object', properties: { x_min: { type: 'number' }, x_max: { type: 'number' }, y_min: { type: 'number' }, y_max: { type: 'number' } } } } } },
  { name: 'describe_scene', description: 'AI-readable description of the canvas: types, positions, connections, layout, bounding box.', inputSchema: { type: 'object', properties: { ...REPO_PROP } } },
  { name: 'export_scene', description: 'Export the canvas to .excalidraw JSON.', inputSchema: { type: 'object', properties: { ...REPO_PROP } } },
  { name: 'import_scene', description: 'Import elements from raw .excalidraw JSON data (replace or merge).', inputSchema: { type: 'object', properties: { ...REPO_PROP, data: { type: 'string' }, mode: { type: 'string', enum: ['replace', 'merge'] } }, required: ['data', 'mode'] } },
  { name: 'clear_canvas', description: 'Clear all elements (commits to GitHub).', inputSchema: { type: 'object', properties: { ...REPO_PROP } } },
  { name: 'group_elements', description: 'Group multiple elements together', inputSchema: { type: 'object', properties: { ...REPO_PROP, elementIds: { type: 'array', items: { type: 'string' } } }, required: ['elementIds'] } },
  { name: 'ungroup_elements', description: 'Ungroup a group of elements', inputSchema: { type: 'object', properties: { ...REPO_PROP, groupId: { type: 'string' } }, required: ['groupId'] } },
  { name: 'align_elements', description: 'Align elements to a specific position', inputSchema: { type: 'object', properties: { ...REPO_PROP, elementIds: { type: 'array', items: { type: 'string' } }, alignment: { type: 'string', enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'] } }, required: ['elementIds', 'alignment'] } },
  { name: 'distribute_elements', description: 'Distribute elements evenly', inputSchema: { type: 'object', properties: { ...REPO_PROP, elementIds: { type: 'array', items: { type: 'string' } }, direction: { type: 'string', enum: ['horizontal', 'vertical'] } }, required: ['elementIds', 'direction'] } },
  { name: 'lock_elements', description: 'Lock elements to prevent modification', inputSchema: { type: 'object', properties: { ...REPO_PROP, elementIds: { type: 'array', items: { type: 'string' } } }, required: ['elementIds'] } },
  { name: 'unlock_elements', description: 'Unlock elements to allow modification', inputSchema: { type: 'object', properties: { ...REPO_PROP, elementIds: { type: 'array', items: { type: 'string' } } }, required: ['elementIds'] } },
  { name: 'duplicate_elements', description: 'Duplicate elements with a configurable offset', inputSchema: { type: 'object', properties: { ...REPO_PROP, elementIds: { type: 'array', items: { type: 'string' } }, offsetX: { type: 'number' }, offsetY: { type: 'number' } }, required: ['elementIds'] } },
  { name: 'add_image', description: 'Add an image from a dataURL (data:...;base64,...).', inputSchema: { type: 'object', properties: { ...REPO_PROP, dataURL: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['dataURL'] } },
  { name: 'snapshot_scene', description: 'Save a named snapshot (stored on the excalidrop branch under snapshots/)', inputSchema: { type: 'object', properties: { ...REPO_PROP, name: { type: 'string' } }, required: ['name'] } },
  { name: 'restore_snapshot', description: 'Restore the canvas from a named snapshot', inputSchema: { type: 'object', properties: { ...REPO_PROP, name: { type: 'string' } }, required: ['name'] } },
  { name: 'commit_scene', description: 'Remote commits every call immediately; this returns the current element count (no-op for compatibility).', inputSchema: { type: 'object', properties: { ...REPO_PROP } } },
  { name: 'switch_remote', description: 'Set the default repo for later calls without an explicit repo arg (per-token, 24h).', inputSchema: { type: 'object', properties: { target: { type: 'string' } } } },
  { name: 'current_canvas', description: 'Show the default repo for this token, if set.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_canvases', description: 'List repos you can access (candidates for canvases).', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_diagram_guide', description: 'Design guide for beautiful diagrams: colors, sizing, layout, arrows, anti-patterns.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_canvas_screenshot', description: 'Screenshot via a connected viewer (viewer tab must be open).', inputSchema: { type: 'object', properties: { ...REPO_PROP, background: { type: 'boolean' } } } },
  { name: 'export_to_image', description: 'Export to PNG/SVG via a connected viewer (viewer tab must be open).', inputSchema: { type: 'object', properties: { ...REPO_PROP, format: { type: 'string', enum: ['png', 'svg'] }, background: { type: 'boolean' } }, required: ['format'] } },
  { name: 'set_viewport', description: 'Control the viewer viewport via a connected viewer.', inputSchema: { type: 'object', properties: { ...REPO_PROP, scrollToContent: { type: 'boolean' }, scrollToElementId: { type: 'string' }, zoom: { type: 'number' }, offsetX: { type: 'number' }, offsetY: { type: 'number' } } } },
  { name: 'create_from_mermaid', description: 'Convert a Mermaid diagram to elements via a connected viewer, then commit them.', inputSchema: { type: 'object', properties: { ...REPO_PROP, mermaidDiagram: { type: 'string' } }, required: ['mermaidDiagram'] } },
  { name: 'export_to_excalidraw_url', description: 'Export to a shareable excalidraw.com URL (not supported on remote — use export_scene).', inputSchema: { type: 'object', properties: { ...REPO_PROP } } },
  { name: 'github_login', description: 'Remote uses per-request Bearer tokens (OAuth via your chat client). No device flow here — connect with a GitHub token.', inputSchema: { type: 'object', properties: {} } },
];

const DIAGRAM_GUIDE = `# Excalidraw Diagram Design Guide
## Stroke Colors — Black #1e1e1e (default), Red #e03131 (errors), Green #2f9e44 (success), Blue #1971c2 (primary), Purple #9c36b5 (services), Orange #e8590c (async), Cyan #0c8599 (data), Gray #868e96 (annotations)
## Fills (backgroundColor) — #ffc9c9/#b2f2bb/#a5d8ff/#eebefa/#ffd8a8/#99e9f2/#e9ecef/#ffffff paired with matching strokes
## Rules — shapes >= 120x60, fonts >= 16 (titles >= 20), 40-80px gaps, 20px grid, bind arrows via startElementId/endElementId, dashed = async, max 3-4 fill colors, every shape labeled.
`;

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}
function byId(elements, id) {
  return elements.find((e) => e.id === id) || null;
}

async function callTool(env, name, args, token) {
  const a = args || {};
  switch (name) {
    case 'read_diagram_guide': return textResult(DIAGRAM_GUIDE);
    case 'github_login':
      return textResult('Remote MCP authenticates per request: connect this endpoint in your chat client with GitHub OAuth (or send Authorization: Bearer <token> with repo scope). No device flow here.');
    case 'export_to_excalidraw_url':
      throw new Error('not supported on remote — use export_scene and share the JSON');
    case 'switch_remote': {
      if (!a.target) throw new Error('pass { target: "owner/repo" }');
      const repo = parseRepo(a.target);
      const v = await verifyAccess(token, repo, false);
      if (!v.ok) throw new Error(v.status === 404 ? `repo ${repo} not found` : `no access to ${repo} with this token`);
      defaults.set(hashToken(token), { repo, at: Date.now() });
      return textResult(`Default canvas set to ${repo}. Later calls may omit repo.`);
    }
    case 'current_canvas': {
      const d = defaultRepo(token);
      return textResult(d ? `remote:${d}` : 'no default canvas — pass { repo: "owner/repo" } or call switch_remote');
    }
    case 'list_canvases': {
      const r = await fetch(`${GH_API}/user/repos?per_page=100&affiliation=owner,collaborator&sort=pushed`, { headers: ghHeaders(token) });
      if (!r.ok) throw new Error(`github ${r.status}: cannot list repos with this token`);
      const list = await r.json();
      const names = list.map((x) => `${x.full_name}${x.private ? ' (private)' : ''}`);
      return textResult(`Repos you can access (any may hold a canvas on branch ${CANVAS_BRANCH}):\n${names.join('\n') || '(none)'}`);
    }
  }

  // --- all remaining tools need a repo + read access; mutations need push
  const MUTATING = new Set(['create_element', 'batch_create_elements', 'update_element', 'delete_element', 'clear_canvas', 'import_scene', 'group_elements', 'ungroup_elements', 'align_elements', 'distribute_elements', 'lock_elements', 'unlock_elements', 'duplicate_elements', 'add_image', 'restore_snapshot', 'snapshot_scene', 'create_from_mermaid']);
  const repo = needRepo(a, token);
  const v = await verifyAccess(token, repo, MUTATING.has(name));
  if (!v.ok) throw new Error(v.status === 404 ? `repo ${repo} not found` : `no access to ${repo} with this token`);

  switch (name) {
    case 'describe_scene':
    case 'query_elements':
    case 'get_element':
    case 'export_scene':
    case 'commit_scene': {
      const { doc } = await getScene(repo, token);
      const elements = doc?.elements || [];
      if (name === 'commit_scene') return textResult(`Committed (remote auto-commits every call): ${elements.length} elements on ${repo}.`);
      if (name === 'get_element') {
        if (!a.id) throw new Error('id is required');
        const el = byId(elements, a.id);
        if (!el) throw new Error(`Element ${a.id} not found`);
        return textResult(JSON.stringify(el, null, 2));
      }
      if (name === 'export_scene') {
        return textResult(JSON.stringify({ type: 'excalidraw', version: 2, source: 'excalidrop', elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null } }, null, 2));
      }
      if (name === 'query_elements') {
        let out = elements;
        if (a.type) out = out.filter((e) => e.type === a.type);
        if (a.bbox) {
          const b = a.bbox;
          out = out.filter((el) =>
            (b.x_min === undefined || el.x >= b.x_min) && (b.x_max === undefined || el.x <= b.x_max) &&
            (b.y_min === undefined || el.y >= b.y_min) && (b.y_max === undefined || el.y <= b.y_max));
        }
        if (a.filter) out = out.filter((el) => Object.entries(a.filter).every(([k, val]) => el[k] === val));
        return textResult(JSON.stringify(out, null, 2));
      }
      // describe_scene
      const byType = {};
      for (const e of elements) byType[e.type] = (byType[e.type] || 0) + 1;
      const conns = elements.filter((e) => e.type === 'arrow' && (e.start || e.end)).length;
      const xs = elements.map((e) => e.x), ys = elements.map((e) => e.y);
      return textResult(`Canvas ${repo}: ${elements.length} elements (${Object.entries(byType).map(([t, n]) => `${n}x ${t}`).join(', ') || 'empty'}), ${conns} bound arrows.` +
        (elements.length ? ` bbox x[${Math.min(...xs)}..${Math.max(...xs)}] y[${Math.min(...ys)}..${Math.max(...ys)}].` : '') +
        `\n${JSON.stringify(elements.slice(0, 50), null, 2)}${elements.length > 50 ? `\n… +${elements.length - 50} more (use query_elements)` : ''}`);
    }

    case 'create_element': {
      if (!a.type || a.x === undefined || a.y === undefined) throw new Error('type, x, y are required');
      const el = buildElement(a);
      const { sha } = await mutateScene(repo, token, `excalidrop: add ${el.type} ${el.id}`, (elements) => { elements.push(el); });
      return textResult(`Element created on ${repo} (${sha.slice(0, 7)}):\n${JSON.stringify(el, null, 2)}`);
    }
    case 'batch_create_elements': {
      if (!Array.isArray(a.elements) || !a.elements.length) throw new Error('elements[] is required');
      const els = a.elements.map(buildElement);
      const { sha } = await mutateScene(repo, token, `excalidrop: batch add ${els.length} elements`, (elements) => { for (const e of els) elements.push(e); });
      return textResult(`${els.length} elements created on ${repo} (${sha.slice(0, 7)}):\n${JSON.stringify(els, null, 2)}`);
    }
    case 'update_element': {
      if (!a.id) throw new Error('id is required');
      const { id, repo: _r, points, ...updates } = a;
      let updated = null;
      await mutateScene(repo, token, `excalidrop: update ${id}`, (elements) => {
        const i = elements.findIndex((e) => e.id === id);
        if (i === -1) throw new Error(`Element ${id} not found`);
        updated = toLabel({ ...elements[i], ...updates, ...(points ? { points: points.map((p) => (Array.isArray(p) ? p : [p.x, p.y])) } : {}), updatedAt: new Date().toISOString() });
        if (updated.fontFamily !== undefined) updated.fontFamily = normalizeFontFamily(updated.fontFamily);
        elements[i] = updated;
      });
      return textResult(`Element updated on ${repo}:\n${JSON.stringify(updated, null, 2)}`);
    }
    case 'delete_element': {
      if (!a.id) throw new Error('id is required');
      await mutateScene(repo, token, `excalidrop: delete ${a.id}`, (elements) => {
        const i = elements.findIndex((e) => e.id === a.id);
        if (i === -1) throw new Error(`Element ${a.id} not found`);
        elements.splice(i, 1);
      });
      return textResult(`Element ${a.id} deleted from ${repo}.`);
    }
    case 'clear_canvas': {
      const { extra } = await mutateScene(repo, token, 'excalidrop: clear canvas', (elements) => { const n = elements.length; elements.length = 0; return { message: `excalidrop: clear ${n} elements`, n }; });
      return textResult(`Canvas cleared (${extra.n} elements removed from ${repo}).`);
    }
    case 'import_scene': {
      if (!a.data) throw new Error('data (raw .excalidraw JSON) is required');
      const incomingDoc = JSON.parse(a.data);
      const incoming = (Array.isArray(incomingDoc) ? incomingDoc : incomingDoc.elements || []).map((el) => ({ ...el, id: el.id || generateId() }));
      if (!incoming.length) throw new Error('No elements found in the import data');
      await mutateScene(repo, token, `excalidrop: import ${incoming.length} (${a.mode})`, (elements, files) => {
        if (a.mode === 'replace') elements.length = 0;
        if (incomingDoc.files && typeof incomingDoc.files === 'object') {
          for (const f of Object.values(incomingDoc.files)) if (f?.id) files.set(f.id, f);
        }
        for (const e of incoming) elements.push(e);
      });
      return textResult(`Imported ${incoming.length} elements into ${repo} (mode: ${a.mode}).`);
    }
    case 'add_image': {
      if (!a.dataURL || !a.dataURL.startsWith('data:')) throw new Error('add_image requires a dataURL (data:...;base64,...)');
      const mm = /^data:([^;]+);base64,(.+)$/s.exec(a.dataURL);
      if (!mm) throw new Error('Invalid image data');
      if (mm[2].length > 14 * 1024 * 1024) throw new Error('Image too large (max ~10MB)');
      const fileId = generateId();
      const elId = generateId();
      const now = new Date().toISOString();
      await mutateScene(repo, token, `excalidrop: add image ${fileId}`, (elements, files) => {
        files.set(fileId, { id: fileId, dataURL: a.dataURL, mimeType: mm[1], created: Date.now() });
        elements.push({ id: elId, type: 'image', x: a.x ?? 0, y: a.y ?? 0, width: a.width ?? 400, height: a.height ?? 300, fileId, status: 'saved', scale: [1, 1], createdAt: now, updatedAt: now, version: 1 });
      });
      return textResult(`Image added to ${repo} (fileId ${fileId}, element ${elId}).`);
    }
    case 'group_elements': {
      if (!a.elementIds?.length) throw new Error('elementIds[] is required');
      const groupId = generateId();
      let n = 0;
      await mutateScene(repo, token, `excalidrop: group ${a.elementIds.length}`, (elements) => {
        for (const id of a.elementIds) { const el = byId(elements, id); if (el) { el.groupIds = [...(el.groupIds || []), groupId]; n++; } }
        if (!n) throw new Error('No elements grouped (ids not found)');
      });
      return textResult(JSON.stringify({ groupId, elementIds: a.elementIds, successCount: n }, null, 2));
    }
    case 'ungroup_elements': {
      if (!a.groupId) throw new Error('groupId is required');
      let n = 0;
      await mutateScene(repo, token, `excalidrop: ungroup ${a.groupId}`, (elements) => {
        for (const el of elements.filter((e) => (e.groupIds || []).includes(a.groupId))) { el.groupIds = el.groupIds.filter((g) => g !== a.groupId); n++; }
        if (!n) throw new Error(`Group ${a.groupId} not found`);
      });
      return textResult(JSON.stringify({ groupId: a.groupId, ungrouped: true, successCount: n }, null, 2));
    }
    case 'align_elements': {
      const { elementIds, alignment } = a;
      if (!elementIds || elementIds.length < 2) throw new Error('Need at least 2 elements to align');
      await mutateScene(repo, token, `excalidrop: align ${alignment}`, (elements) => {
        const els = elementIds.map((id) => byId(elements, id)).filter(Boolean);
        if (els.length < 2) throw new Error('Need at least 2 elements to align (ids not found)');
        let fn;
        if (alignment === 'left') { const v = Math.min(...els.map((e) => e.x)); fn = () => ({ x: v }); }
        else if (alignment === 'right') { const v = Math.max(...els.map((e) => e.x + (e.width || 0))); fn = (e) => ({ x: v - (e.width || 0) }); }
        else if (alignment === 'center') { const m = els.map((e) => e.x + (e.width || 0) / 2).reduce((x, y) => x + y, 0) / els.length; fn = (e) => ({ x: m - (e.width || 0) / 2 }); }
        else if (alignment === 'top') { const v = Math.min(...els.map((e) => e.y)); fn = () => ({ y: v }); }
        else if (alignment === 'bottom') { const v = Math.max(...els.map((e) => e.y + (e.height || 0))); fn = (e) => ({ y: v - (e.height || 0) }); }
        else if (alignment === 'middle') { const m = els.map((e) => e.y + (e.height || 0) / 2).reduce((x, y) => x + y, 0) / els.length; fn = (e) => ({ y: m - (e.height || 0) / 2 }); }
        else throw new Error(`unknown alignment ${alignment}`);
        for (const el of els) Object.assign(el, fn(el));
      });
      return textResult(JSON.stringify({ aligned: true, elementIds, alignment }, null, 2));
    }
    case 'distribute_elements': {
      const { elementIds, direction } = a;
      if (!elementIds || elementIds.length < 3) throw new Error('Need at least 3 elements to distribute');
      await mutateScene(repo, token, `excalidrop: distribute ${direction}`, (elements) => {
        const els = elementIds.map((id) => byId(elements, id)).filter(Boolean);
        if (els.length < 3) throw new Error('Need at least 3 elements to distribute (ids not found)');
        if (direction === 'horizontal') {
          els.sort((x, y) => x.x - y.x);
          const gap = (els[els.length - 1].x + (els[els.length - 1].width || 0) - els[0].x - els.reduce((s, e) => s + (e.width || 0), 0)) / (els.length - 1);
          let x = els[0].x;
          for (const el of els) { el.x = x; x += (el.width || 0) + gap; }
        } else if (direction === 'vertical') {
          els.sort((x, y) => x.y - y.y);
          const gap = (els[els.length - 1].y + (els[els.length - 1].height || 0) - els[0].y - els.reduce((s, e) => s + (e.height || 0), 0)) / (els.length - 1);
          let y = els[0].y;
          for (const el of els) { el.y = y; y += (el.height || 0) + gap; }
        } else throw new Error(`unknown direction ${direction}`);
      });
      return textResult(JSON.stringify({ distributed: true, elementIds, direction }, null, 2));
    }
    case 'lock_elements':
    case 'unlock_elements': {
      if (!a.elementIds?.length) throw new Error('elementIds[] is required');
      const locked = name === 'lock_elements';
      await mutateScene(repo, token, `excalidrop: ${locked ? 'lock' : 'unlock'} ${a.elementIds.length}`, (elements) => {
        for (const id of a.elementIds) { const el = byId(elements, id); if (el) el.locked = locked; }
      });
      return textResult(JSON.stringify({ [locked ? 'locked' : 'unlocked']: true, elementIds: a.elementIds }, null, 2));
    }
    case 'duplicate_elements': {
      if (!a.elementIds?.length) throw new Error('elementIds[] is required');
      const dx = a.offsetX ?? 20, dy = a.offsetY ?? 20;
      let ids = [];
      await mutateScene(repo, token, `excalidrop: duplicate ${a.elementIds.length}`, (elements) => {
        for (const id of a.elementIds) {
          const el = byId(elements, id);
          if (!el) continue;
          const copy = { ...JSON.parse(JSON.stringify(el)), id: generateId(), x: el.x + dx, y: el.y + dy, groupIds: [], updatedAt: new Date().toISOString() };
          elements.push(copy);
          ids.push(copy.id);
        }
      });
      return textResult(JSON.stringify({ duplicated: ids.length, newIds: ids }, null, 2));
    }
    case 'snapshot_scene': {
      if (!a.name) throw new Error('name is required');
      const { doc } = await getScene(repo, token);
      const elements = doc?.elements || [];
      const r = await fetch(`${GH_API}/repos/${repo}/contents/snapshots/${a.name}.json`, {
        method: 'PUT', headers: ghHeaders(token),
        body: JSON.stringify({ message: `excalidrop: snapshot ${a.name} (${elements.length} elements)`, content: b64encode(JSON.stringify({ name: a.name, elements, createdAt: new Date().toISOString() }, null, 2)), branch: CANVAS_BRANCH }),
      });
      if (!r.ok) throw new Error(`snapshot write ${r.status}: ${(await r.text()).slice(0, 150)}`);
      return textResult(`Snapshot "${a.name}" saved (${elements.length} elements) on ${repo}.`);
    }
    case 'restore_snapshot': {
      if (!a.name) throw new Error('name is required');
      const r = await fetch(`${GH_API}/repos/${repo}/contents/snapshots/${a.name}.json?ref=${CANVAS_BRANCH}`, { headers: ghHeaders(token) });
      if (r.status === 404) throw new Error(`Snapshot "${a.name}" not found`);
      if (!r.ok) throw new Error(`snapshot read ${r.status}`);
      const j = await r.json();
      const snap = JSON.parse(b64decode(j.content));
      const els = (snap.elements || []).map((e) => ({ ...e, id: e.id || generateId() }));
      await mutateScene(repo, token, `excalidrop: restore ${a.name}`, (elements) => { elements.length = 0; for (const e of els) elements.push(e); });
      return textResult(`Snapshot "${a.name}" restored (${els.length} elements) on ${repo}.`);
    }

    // --- viewer-live tools: fan out to the DO room for this repo
    case 'get_canvas_screenshot': {
      const out = await viaDo(env, repo, token, 'screenshot', { background: a.background ?? true, format: 'png' });
      return { content: [{ type: 'text', text: `Screenshot of ${repo} (${out.format || 'png'}):` }, { type: 'image', data: out.data, mimeType: out.format === 'svg' ? 'image/svg+xml' : 'image/png' }] };
    }
    case 'export_to_image': {
      if (!a.format) throw new Error('format is required');
      const out = await viaDo(env, repo, token, 'export', { background: a.background ?? true, format: a.format });
      return { content: [{ type: 'text', text: `Exported ${repo} as ${a.format}.` }, { type: 'image', data: out.data, mimeType: a.format === 'svg' ? 'image/svg+xml' : 'image/png' }] };
    }
    case 'set_viewport': {
      const out = await viaDo(env, repo, token, 'viewport', a);
      return textResult(`Viewport updated on ${repo}.\n${JSON.stringify(out, null, 2)}`);
    }
    case 'create_from_mermaid': {
      if (!a.mermaidDiagram) throw new Error('mermaidDiagram is required');
      const out = await viaDo(env, repo, token, 'mermaid', { mermaidDiagram: a.mermaidDiagram, config: a.config || {} });
      const els = (out.elements || []).map((e) => ({ ...e, id: e.id || generateId() }));
      if (!els.length) throw new Error('Viewer returned no elements for this diagram');
      await mutateScene(repo, token, `excalidrop: mermaid import ${els.length}`, (elements) => { for (const e of els) elements.push(e); });
      return textResult(`${els.length} elements created on ${repo} from Mermaid diagram.`);
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message: String(message).slice(0, 500) } };
}

export async function handleMcp(req, env, cors) {
  const headers = { 'Content-Type': 'application/json', ...cors };
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ name: SERVER_NAME, mcp: `POST this URL with JSON-RPC (spec ${MCP_VERSION}). Register https://<this-host>/mcp once in your chat client, then call tools with { repo: "owner/name" }.` }), { headers });
  }
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method not allowed (use POST)' }), { status: 405, headers });

  // daily budget (best-effort per isolate)
  const day = DAY();
  if (day !== dailyDay) { dailyDay = day; dailyCount = 0; }
  dailyCount += 1;
  if (dailyCount > DAILY_BUDGET) {
    return new Response(JSON.stringify(quotaError()), { status: 429, headers });
  }

  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return new Response(JSON.stringify(rpcError(null, -32001, 'missing Bearer token — connect with GitHub OAuth (repo scope)')), { status: 401, headers });
  if (!rateOk(`mcp:${hashToken(token)}`, 60, 60000) || !rateOk(`mcpip:${ip}`, 120, 60000)) {
    return new Response(JSON.stringify(rpcError(null, -32002, 'rate limited (60/min per token). Retry shortly.')), { status: 429, headers });
  }

  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify(rpcError(null, -32700, 'bad json')), { status: 400, headers }); }
  // Header-based routing per spec; fall back to the body for lenient clients.
  const method = req.headers.get('Mcp-Method') || body.method;
  const name = req.headers.get('Mcp-Name') || body.params?.name;
  const id = body.id ?? null;

  try {
    if (method === 'server/discover' || (method === 'initialize')) {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id,
        result: {
          name: SERVER_NAME, version: SERVER_VERSION, protocolVersion: MCP_VERSION,
          description: 'GitHub-backed Excalidraw canvas. One endpoint for every canvas: pass { repo: "owner/name" } per tool call.',
          capabilities: { tools: {} },
        },
      }), { headers });
    }
    if (method === 'tools/list') {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id,
        result: { tools: TOOLS, ttlMs: TOOL_LIST_TTL_MS, cacheScope: 'catalog' },
      }), { headers });
    }
    if (method === 'tools/call') {
      if (!name) return new Response(JSON.stringify(rpcError(id, -32602, 'tool name is required (params.name)')), { status: 400, headers });
      if (!TOOLS.some((t) => t.name === name)) return new Response(JSON.stringify(rpcError(id, -32601, `unknown tool ${name}`)), { status: 404, headers });
      const result = await callTool(env, name, body.params?.arguments || {}, token);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers });
    }
    return new Response(JSON.stringify(rpcError(id, -32601, `unsupported method ${method} (use server/discover, tools/list, tools/call)`)), { status: 400, headers });
  } catch (e) {
    const msg = (e && e.message) || 'tool failed';
    const noAccess = /no access|not found|missing Bearer|rate limited|budget exhausted/i.test(msg);
    const noViewer = /no viewer connected|viewer timed out/i.test(msg);
    const status = noAccess ? 403 : noViewer ? 503 : 500;
    return new Response(JSON.stringify(rpcError(id, noAccess ? -32003 : -32603, msg)), { status, headers });
  }
}
