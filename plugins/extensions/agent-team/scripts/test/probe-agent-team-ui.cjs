'use strict';
const { hostRoot, pluginRoot } = require('../probe-paths.cjs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Exercise this plugin's actual built Browser through the public host registry.
const result = spawnSync(process.execPath,
  [path.join(hostRoot, 'scripts/test/plugin-host/verify-built-browser-artifacts.mjs')], {
    cwd: hostRoot, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, APP_PLUGIN_PROBE_SOURCE_ROOT: path.dirname(pluginRoot),
      APP_PLUGIN_PROBE_IDS: path.basename(pluginRoot) },
  });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
