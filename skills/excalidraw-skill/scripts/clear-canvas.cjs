#!/usr/bin/env node
/* eslint-disable no-console */
// Remote-only clear (commits to GitHub). Usage: --repo owner/repo
const { repoFromArgs, token, getScene, putScene } = require('./gh-helper.cjs');

async function main() {
  const repo = repoFromArgs(process.argv.slice(2));
  if (!repo) throw new Error('Pass --repo owner/repo.');
  if (!token()) throw new Error('No GitHub token. Run `gh auth login` or `npx excalidrop login`.');
  const scene = await getScene(repo);
  await putScene(repo, [], scene.files, scene.sha, `excalidrop: clear canvas (${scene.elements.length} removed)`);
  console.log(`Cleared canvas (${scene.elements.length} elements removed)`);
}

main().catch((err) => { console.error(err?.stack || String(err)); process.exit(1); });
