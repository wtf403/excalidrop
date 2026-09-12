#!/usr/bin/env node
/* eslint-disable no-console */
// Remote-only export. Usage: --repo owner/repo [--out file]
const fs = require('node:fs');
const path = require('node:path');
const { repoFromArgs, token, getScene } = require('./gh-helper.cjs');

async function main() {
  const argv = process.argv.slice(2);
  const repo = repoFromArgs(argv);
  if (!repo) throw new Error('Pass --repo owner/repo.');
  if (!token()) throw new Error('No GitHub token. Run `gh auth login` or `npx excalidrop login`.');
  let outFile = null;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--out' || argv[i] === '-o') && argv[i + 1]) outFile = argv[++i];
  }
  const scene = await getScene(repo);
  const payload = { exportedAt: new Date().toISOString(), repo, elements: scene.elements };
  const text = JSON.stringify(payload, null, 2);
  if (!outFile) { process.stdout.write(text + '\n'); return; }
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, text + '\n');
  console.log(`Wrote ${payload.elements.length} elements to ${outFile}`);
}

main().catch((err) => { console.error(err?.stack || String(err)); process.exit(1); });
