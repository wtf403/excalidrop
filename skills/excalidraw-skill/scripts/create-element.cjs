#!/usr/bin/env node
/* eslint-disable no-console */
// Remote-only create. Usage: --repo owner/repo (--data <json> | --file <path>)
const fs = require('node:fs');
const crypto = require('node:crypto');
const { repoFromArgs, token, getScene, putScene } = require('./gh-helper.cjs');

async function main() {
  const argv = process.argv.slice(2);
  const repo = repoFromArgs(argv);
  let data = null; let file = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') data = argv[++i];
    else if (argv[i] === '--file') file = argv[++i];
  }
  if (!repo || (!data && !file)) throw new Error("Usage: --repo owner/repo (--data '<json>' | --file <path>)");
  if (!token()) throw new Error('No GitHub token.');
  const payload = data ? JSON.parse(data) : JSON.parse(fs.readFileSync(file, 'utf8'));
  const el = { id: payload.id || crypto.randomUUID().slice(0, 12), ...payload };
  const scene = await getScene(repo);
  await putScene(repo, [...scene.elements, el], scene.files, scene.sha, 'excalidrop: create element via skill');
  process.stdout.write(JSON.stringify(el, null, 2) + '\n');
}

main().catch((err) => { console.error(err?.stack || String(err)); process.exit(1); });
