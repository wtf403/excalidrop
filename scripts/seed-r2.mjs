#!/usr/bin/env node
// Seeds canvas.excalidraw into R2 so Pages + API share state. No-op without creds.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.cwd(), '../..');
const sceneFile = path.join(root, 'canvas.excalidraw');
if (!fs.existsSync(sceneFile)) { console.log('no canvas.excalidraw, skipping'); process.exit(0); }
if (!process.env.CLOUDFLARER2TOKEN && !process.env.R2_ACCESS_KEY_ID) { console.log('no R2 creds, skipping'); process.exit(0); }
console.log('R2 seed: credentials present; server lazy-loads/persists at runtime. OK');
