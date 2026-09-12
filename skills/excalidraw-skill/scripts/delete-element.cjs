#!/usr/bin/env node
/* eslint-disable no-console */
// Remote-only delete. Usage: --repo owner/repo --id <id>
const { repoFromArgs, token, getScene, putScene } = require('./gh-helper.cjs');

async function main() {
  const argv = process.argv.slice(2);
  const repo = repoFromArgs(argv);
  let id = null;
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--id') id = argv[++i];
  if (!repo || !id) throw new Error('Usage: --repo owner/repo --id <id>');
  if (!token()) throw new Error('No GitHub token.');
  const scene = await getScene(repo);
  await putScene(repo, scene.elements.filter((e) => e.id !== id), scene.files, scene.sha, `excalidrop: delete ${id} via skill`);
  console.log(`Deleted ${id}`);
}

main().catch((err) => { console.error(err?.stack || String(err)); process.exit(1); });
