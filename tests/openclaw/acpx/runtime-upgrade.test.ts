import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

// Point at a prepared extension's acpx/package.json to exercise its real dependency.
// ACPX_RUNTIME_BASELINE_PACKAGE optionally adds a genuine 0.19.1 storage round trip.
const packageFile = process.env.ACPX_RUNTIME_TEST_PACKAGE
  ?? path.resolve('plugins/extensions/acpx/node_modules/acpx/package.json');

test.skipIf(!process.env.ACPX_RUNTIME_TEST_PACKAGE && !fs.existsSync(packageFile))(
  'the locked acpx runtime preserves session identity, permissions and turn controls',
  () => {
    const result = spawnSync(
      process.env.ACPX_RUNTIME_TEST_EXECUTABLE ?? process.execPath,
      [path.resolve('tests/openclaw/acpx/runtime-upgrade-fixture.mjs')],
      {
        encoding: 'utf8',
        // Cover the worker's 90s execution + 15s cleanup budgets under CI load.
        timeout: 115_000,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ACPX_RUNTIME_TEST_PACKAGE: packageFile },
      },
    );
    expect(result.error, 'runtime fixture must exit within its cleanup budget').toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('acpx runtime regression passed');
  },
  120_000,
);
