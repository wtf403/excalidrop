#!/usr/bin/env node
// Postinstall hint for `npm i -D excalidrop`.
// Print-only: npm blocks interactive stdin during postinstall, so the actual
// setup (port pick + agent install) happens via `npx excalidrop init`.
if (process.env.EXCALIDROP_NO_POSTINSTALL) process.exit(0);

console.log(`
  excalidrop installed.

  Next step — set up this project's canvas (picks a free port, writes
  .excalidrop.json + .mcp.json, offers AI-agent install):

    npx excalidrop init

  Then start drawing:

    npx excalidrop up
`);
