// Preserve the public probe entry point while testing the independent built Browser artifacts.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const result = spawnSync(
  process.execPath,
  [path.join(root, 'scripts/test/plugin-host/verify-built-browser-artifacts.mjs')],
  { cwd: root, env: { ...process.env }, stdio: 'inherit', windowsHide: true },
);
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
