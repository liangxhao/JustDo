import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';

const { discoverAppPluginTestSuites } = createRequire(import.meta.url)('../../scripts/test/app-plugin-test-suites.cjs');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('discovers only present app packages and accepts an empty optional inventory', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plugin-suites-'));
  roots.push(root);
  expect(discoverAppPluginTestSuites(root)).toEqual([]);
  const plugin = path.join(root, 'plugins/extensions/example');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ app: { main: 'main.ts' }, scripts: { test: 'vitest run' } }));
  expect(() => discoverAppPluginTestSuites(root)).toThrow('independent test suite');
  writeFileSync(path.join(plugin, 'vitest.config.ts'), 'export default {};');
  expect(discoverAppPluginTestSuites(root)).toEqual([{ root: plugin, config: path.join(plugin, 'vitest.config.ts') }]);
});
