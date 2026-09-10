#!/usr/bin/env node
// Postinstall hint for `npm i -D excalidrop`.
// Print-only: npm blocks interactive stdin during postinstall, so the actual
// setup (port pick + agent install) happens via `npx excalidrop init`.
if (process.env.EXCALIDROP_NO_POSTINSTALL) process.exit(0);

console.log(`
  excalidrop installed.

  Remote canvas (recommended — GitHub-backed, works on any repo):

    npx excalidrop setup

  checks gh auth, publishes the viewer to gh-pages, prints the app-install
  link and verifies the site is live. Then tell your agent:

    switch_remote { target: "<your Pages URL>" }

  Local canvas instead:

    npx excalidrop init   # picks a free port, offers AI-agent install
    npx excalidrop up
`);
