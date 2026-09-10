

interface MinimalCanvasApi {
  getSceneElements(): Array<Record<string, any>>;
  updateScene(scene: { elements: Array<Record<string, any>> }): void;
  resetScene(): void;
}

export type CanvasApiGetter = () => MinimalCanvasApi | null | undefined;

export interface WebMCPHandle {
  available: boolean;
  count: number;
  cleanup: () => void;
}

interface ModelContextLike {
  registerTool(
    tool: {
      name: string;
      title?: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: Record<string, unknown>;
      execute: (args: any, opts?: { signal?: AbortSignal }) => unknown | Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

function getModelContext(): ModelContextLike | null {
  try {
    const doc = document as unknown as Record<string, unknown>;
    const nav = navigator as unknown as Record<string, unknown>;
    const mc =
      (doc['modelContext'] as ModelContextLike | undefined) ??
      (nav['modelContext'] as ModelContextLike | undefined);
    if (mc && typeof mc.registerTool === 'function') return mc;
  } catch {

  }
  return null;
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return (crypto as Crypto).randomUUID().slice(0, 12);
    }
  } catch {

  }
  return `el_${Math.random().toString(36).slice(2, 10)}`;
}

function summarize(el: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: el['id'],
    type: el['type'],
    x: Math.round(Number(el['x'] ?? 0)),
    y: Math.round(Number(el['y'] ?? 0)),
  };
  if (el['width'] !== undefined) out['width'] = el['width'];
  if (el['height'] !== undefined) out['height'] = el['height'];
  const text =
    (typeof el['text'] === 'string' && el['text']) ||
    (el['label'] as { text?: string } | undefined)?.text;
  if (text) out['text'] = String(text).slice(0, 120);
  if (el['locked']) out['locked'] = true;
  return out;
}

const ELEMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Custom element ID (auto-generated if omitted)' },
    type: { type: 'string', description: 'Excalidraw element type: rectangle, ellipse, diamond, text, arrow, line, freedraw, image' },
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    text: { type: 'string', description: 'Label text for shapes / content for text elements' },
    backgroundColor: { type: 'string' },
    strokeColor: { type: 'string' },
    strokeWidth: { type: 'number' },
    fontSize: { type: 'number' },
    startElementId: { type: 'string', description: 'For arrows: bind start to this element ID' },
    endElementId: { type: 'string', description: 'For arrows: bind end to this element ID' },
  },
  required: ['type', 'x', 'y'],
  additionalProperties: true,
};


export function registerCanvasWebMCP(getApi: CanvasApiGetter): WebMCPHandle {
  const noop = () => {};
  const mc = getModelContext();
  if (!mc) return { available: false, count: 0, cleanup: noop };

  const controller = new AbortController();
  const signal = controller.signal;
  let count = 0;

  const requireApi = (): MinimalCanvasApi => {
    const api = getApi();
    if (!api) throw new Error('Canvas not ready yet');
    return api;
  };

  const safeRegister = (tool: Parameters<ModelContextLike['registerTool']>[0]): void => {
    try {
      const p = mc.registerTool(tool, { signal });
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => {

        });
      }
      count += 1;
    } catch {

    }
  };

  safeRegister({
    name: 'describe_scene',
    title: 'Describe canvas scene',
    description:
      'Read-only summary of the live Excalidraw canvas: element counts by type plus id/type/position/label per element (capped at 200). Call before editing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: () => {
      const api = requireApi();
      const els = api.getSceneElements().filter((e) => !e['isDeleted']);
      const byType: Record<string, number> = {};
      for (const e of els) {
        const t = String(e['type'] ?? 'unknown');
        byType[t] = (byType[t] ?? 0) + 1;
      }
      return {
        count: els.length,
        byType,
        elements: els.slice(0, 200).map(summarize),
      };
    },
  });

  safeRegister({
    name: 'create_elements',
    title: 'Create canvas elements',
    description:
      'Add new elements to the live canvas in one batch. Assign custom ids to shapes so arrows can reference them via startElementId/endElementId.',
    inputSchema: {
      type: 'object',
      properties: { elements: { type: 'array', items: ELEMENT_SCHEMA, minItems: 1 } },
      required: ['elements'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false },
    execute: (args: { elements?: Array<Record<string, any>> }) => {
      const api = requireApi();
      const input = Array.isArray(args?.elements) ? args.elements : [];
      if (input.length === 0) throw new Error('elements must be a non-empty array');
      if (input.length > 200) throw new Error('max 200 elements per call');
      const created = input.map((raw) => {
        if (!raw || typeof raw !== 'object') throw new Error('each element must be an object');
        if (typeof raw['type'] !== 'string') throw new Error('each element needs a type');
        if (typeof raw['x'] !== 'number' || typeof raw['y'] !== 'number') {
          throw new Error('each element needs numeric x and y');
        }
        const { startElementId, endElementId, ...rest } = raw;
        const el: Record<string, any> = { id: newId(), ...rest };
        if (typeof startElementId === 'string') el['start'] = { id: startElementId };
        if (typeof endElementId === 'string') el['end'] = { id: endElementId };
        if ((el['type'] === 'arrow' || el['type'] === 'line') && !Array.isArray(el['points'])) {
          el['points'] = [
            [0, 0],
            [100, 0],
          ];
        }
        return el;
      });
      const current = api.getSceneElements();
      api.updateScene({ elements: [...current, ...created] });
      return { ok: true, count: created.length, ids: created.map((e) => e['id']) };
    },
  });

  safeRegister({
    name: 'update_element',
    title: 'Update canvas element',
    description: 'Patch position, size, colors, or text of one element by id on the live canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Element ID from describe_scene' },
        patch: {
          type: 'object',
          description: 'Fields to merge (x, y, width, height, backgroundColor, strokeColor, text, ...)',
        },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false },
    execute: (args: { id?: string; patch?: Record<string, unknown> }) => {
      const api = requireApi();
      if (!args?.id) throw new Error('id is required');
      if (!args?.patch || typeof args.patch !== 'object') throw new Error('patch must be an object');
      const current = api.getSceneElements();
      const idx = current.findIndex((e) => e['id'] === args.id);
      if (idx === -1) throw new Error(`Element ${args.id} not found`);
      const next = current.slice();
      next[idx] = { ...current[idx], ...args.patch, id: args.id };
      api.updateScene({ elements: next });
      return { ok: true, id: args.id };
    },
  });

  safeRegister({
    name: 'delete_element',
    title: 'Delete canvas element',
    description: 'Remove one element by id from the live canvas.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    execute: (args: { id?: string }) => {
      const api = requireApi();
      if (!args?.id) throw new Error('id is required');
      const current = api.getSceneElements();
      if (!current.some((e) => e['id'] === args.id)) throw new Error(`Element ${args.id} not found`);
      api.updateScene({ elements: current.filter((e) => e['id'] !== args.id) });
      return { ok: true, deleted: args.id };
    },
  });

  safeRegister({
    name: 'clear_canvas',
    title: 'Clear canvas',
    description: 'Remove ALL elements from the live canvas. Ask the user to confirm first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { destructiveHint: true, consequentialHint: true },
    execute: () => {
      const api = requireApi();
      const n = api.getSceneElements().length;
      api.resetScene();
      return { ok: true, cleared: n };
    },
  });

  return {
    available: true,
    count,
    cleanup: () => {
      try {
        controller.abort();
      } catch {

      }
    },
  };
}
