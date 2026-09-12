#!/usr/bin/env node
/* eslint-disable no-console */
// Remote-only import. Usage: --repo owner/repo --in <file> [--mode merge|replace]
const fs = require('node:fs');
const { repoFromArgs, token, getScene, putScene } = require('./gh-helper.cjs');

function usage() {
  console.error(['Usage:', '  node scripts/import-elements.cjs --repo owner/repo --in <file> [--mode merge|replace]'].join('\n'));
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const repo = repoFromArgs(argv);
  let inFile = null; let mode = 'merge';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in' && argv[i + 1]) inFile = argv[++i];
    else if (argv[i] === '--mode' && argv[i + 1]) mode = argv[++i];
  }
  if (!repo || !inFile) usage();
  if (!token()) throw new Error('No GitHub token. Run `gh auth login` or `npx excalidrop login`.');
  const raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const incoming = Array.isArray(raw) ? raw : raw.elements || [];
  if (!incoming.length) throw new Error('No elements in input file');
  const scene = await getScene(repo);
  const elements = mode === 'replace' ? incoming : [...scene.elements, ...incoming];
  await putScene(repo, elements, scene.files, scene.sha, `excalidrop: import ${incoming.length} elements (${mode})`);
  console.log(`Imported ${incoming.length} elements (${mode}) to ${repo}`);
}

main().catch((err) => { console.error(err?.stack || String(err)); process.exit(1); });
