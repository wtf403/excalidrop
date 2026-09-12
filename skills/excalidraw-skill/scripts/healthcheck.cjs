#!/usr/bin/env node
/* eslint-disable no-console */
// Remote-only: checks gh auth + scene readability. Usage: --repo owner/repo
const { repoFromArgs, token, getScene } = require('./gh-helper.cjs');

async function main() {
  const repo = repoFromArgs(process.argv.slice(2));
  if (!repo) throw new Error('Pass --repo owner/repo (or run inside a cloned repo).');
  if (!token()) throw new Error('No GitHub token. Run `gh auth login` or `npx excalidrop login`.');
  const scene = await getScene(repo);
  console.log(JSON.stringify({ ok: true, repo, elements: scene.elements.length, sha: scene.sha?.slice(0, 7) || null }, null, 2));
}

main().catch((err) => { console.error(err?.stack || String(err)); process.exit(1); });
