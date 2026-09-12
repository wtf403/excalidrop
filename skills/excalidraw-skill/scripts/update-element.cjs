#!/usr/bin/env node
/* eslint-disable no-console */
// Remote-only update. Usage: --repo owner/repo --id <id> (--data <json> | --file <path>)
const fs = require('node:fs');
const { repoFromArgs, token, getScene, putScene } = require('./gh-helper.cjs');

async function main() {
  const argv = process.argv.slice(2);
  const repo = repoFromArgs(argv);
  let id = null; let data = null; let file = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') id = argv[++i];
    else if (argv[i] === '--data') data = argv[++i];
    else if (argv[i] === '--file') file = argv[++i];
  }
  if (!repo || !id || (!data && !file)) throw new Error('Usage: --repo owner/repo --id <id> (--data \'<json>\' | --file <path>)');
  if (!token()) throw new Error('No GitHub token.');
  const patch = data ? JSON.parse(data) : JSON.parse(fs.readFileSync(file, 'utf8'));
  const scene = await getScene(repo);
  const els = scene.elements.map((e) => (e.id === id ? { ...e, ...patch, id } : e));
  if (!els.some((e) => e.id === id)) throw new Error(`Element ${id} not found`);
  await putScene(repo, els, scene.files, scene.sha, `excalidrop: update ${id} via skill`);
  process.stdout.write(JSON.stringify(els.find((e) => e.id === id), null, 2) + '\n');
}

main().catch((err) => { console.error(err?.stack || String(err)); process.exit(1); });
