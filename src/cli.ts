#!/usr/bin/env node
// Checked before anything else loads: on older Node, `node:sqlite` is missing (20) or lacks what the
// index needs (22), and the failure would be a stack trace instead of an instruction.
export const MIN_NODE = 24;

if (Number(process.versions.node.split('.')[0]) < MIN_NODE) {
  console.error(
    `askdocs needs Node.js ${MIN_NODE} or newer; this is Node ${process.versions.node}. Install it from https://nodejs.org, or run: nvm install ${MIN_NODE}`,
  );
  process.exit(1);
}

await import('./main');
