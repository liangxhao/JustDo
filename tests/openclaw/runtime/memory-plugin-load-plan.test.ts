import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, test } from 'vitest';

const distRoot = path.resolve(
  process.env.JUSTDO_TEST_PRISTINE_RUNTIME ?? 'vendor/openclaw-runtime/current',
  'dist',
);
const cases = [
  {
    name: 'excludes memory omitted from a restrictive allowlist',
    plugins: { allow: ['runtime-services'] },
    expected: [],
  },
  {
    name: 'loads memory after config sync includes it in the allowlist',
    plugins: {
      allow: ['runtime-services', 'memory-core'],
      entries: { 'memory-core': { enabled: true } },
    },
    expected: ['memory-core'],
  },
  {
    name: 'respects explicit memory disable despite allowlist membership',
    plugins: { allow: ['memory-core'], entries: { 'memory-core': { enabled: false } } },
    expected: [],
  },
  {
    name: 'respects memory deny despite allowlist membership',
    plugins: { allow: ['memory-core'], deny: ['memory-core'] },
    expected: [],
  },
  {
    name: 'respects a disabled memory slot despite allowlist membership',
    plugins: { allow: ['memory-core'], slots: { memory: 'none' } },
    expected: [],
  },
];

describe.skipIf(!fs.existsSync(distRoot))('native memory plugin runtime selection', () => {
  let selectedPluginIds: string[][];

  beforeAll(() => {
    const runtimeFile = fs
      .readdirSync(distRoot)
      .filter(name => /^runtime-plugin-load-plan-.*\.m?js$/u.test(name))
      .map(name => path.join(distRoot, name))
      .find(filename =>
        fs.readFileSync(filename, 'utf8').includes('function resolveAgentRuntimePluginLoadPlan('),
      );
    expect(runtimeFile).toBeDefined();
    const source = fs.readFileSync(runtimeFile!, 'utf8');
    const exportName = source.match(/resolveAgentRuntimePluginLoadPlan as (\w+)/u)?.[1];
    expect(exportName).toBeDefined();

    // Execute the shipped module in Node, avoiding Vitest's transformation of
    // the runtime's dependency graph. Only discovery metadata is a fixture.
    const script = `
      const native = await import(${JSON.stringify(pathToFileURL(runtimeFile!).href)});
      const plan = native[${JSON.stringify(exportName)}];
      const metadataSnapshot = {
        index: { plugins: [{ pluginId: 'memory-core', origin: 'bundled', startup: { memory: true } }] },
        normalizePluginId: id => id,
      };
      const results = ${JSON.stringify(cases)}.map(({ plugins }) => plan({
        config: { plugins: { slots: { memory: 'memory-core' }, ...plugins } },
        metadataSnapshot,
        selections: [],
        basePluginIds: [],
      }).pluginIds);
      process.stdout.write(JSON.stringify(results));
    `;
    selectedPluginIds = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      }),
    );
  }, 35_000);

  test.each(cases.map((entry, index) => ({ ...entry, index })))('$name', ({ expected, index }) => {
    expect(selectedPluginIds[index]).toEqual(expected);
  });
});
