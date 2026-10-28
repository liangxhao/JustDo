import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { expect, test } from 'vitest';

test('loads the same Vite config and startup HTML with bundled and native loaders', () => {
  // Use plain Node so Vitest cannot hide native module-format or resolution errors.
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { loadConfigFromFile } from 'vite';

    const snapshots = [];
    for (const loader of ['bundle', 'native']) {
      const loaded = await loadConfigFromFile(
        { command: 'serve', mode: 'development' },
        undefined, process.cwd(), 'silent', undefined, loader,
      );
      assert.ok(loaded);
      const { config } = loaded;
      const startup = config.plugins.flat().find(plugin => plugin.name === 'startup-presentation-html');
      const html = startup.transformIndexHtml.handler(
        fs.readFileSync(path.join(config.root, 'startup-bootstrap.html'), 'utf8'),
      );
      assert.equal(config.root, path.join(process.cwd(), 'src/renderer'));
      assert.equal(config.resolve.alias['@shared'], path.join(process.cwd(), 'src/shared'));
      assert.ok(html.includes('data:image/png;base64,'));
      assert.ok(!html.includes('%STARTUP_'));
      snapshots.push({
        path: loaded.path, root: config.root, envDir: config.envDir,
        aliases: config.resolve.alias, server: config.server, base: config.base, html,
      });
    }
    assert.deepEqual(snapshots[1], snapshots[0]);
  `], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { ...process.env, NODE_ENV: 'development' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).not.toMatch(/MODULE_TYPELESS_PACKAGE_JSON|unsupported by.*configLoader/u);
}, 30_000);
