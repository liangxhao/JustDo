import fs from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import react from '@vitejs/plugin-react';
import { build, createServer, transformWithOxc, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { reactHooksRefreshPlugin } from '../../scripts/build/vite-react-hooks-refresh.mjs';

const require = createRequire(import.meta.url);
const hookSource = (body: string) => `
import { useEffect, useState, useSyncExternalStore } from 'react';
export function useSettings() { ${body} }
export function useAvailability() { return useSettings(); }
`;
const oldHooks = hookSource('const [value] = useState(false); useEffect(() => {}, []); return value;');
const newHooks = hookSource('return useSyncExternalStore(() => () => {}, () => false);');
let projectRoot: string;
let server: ViteDevServer;

beforeAll(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'react-hooks-refresh-'));
  const files = [
    'src/renderer/useSettings.ts',
    'src/main/useSettings.ts',
    'src/shared/useSettings.ts',
    'plugins/extensions/sample/browser/useSettings.ts',
    'plugins/extensions/sample/host/useSettings.ts',
  ];
  for (const file of files) {
    const filename = path.join(projectRoot, file);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, oldHooks);
  }
  server = await createServer({
    configFile: false,
    root: projectRoot,
    cacheDir: path.join(projectRoot, '.vite'),
    plugins: [reactHooksRefreshPlugin(projectRoot), react()],
    resolve: {
      alias: {
        'react-dom': path.dirname(require.resolve('react-dom/package.json')),
        react: path.dirname(require.resolve('react/package.json')),
      },
    },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: { server: createHttpServer() }, watch: null },
  });
});

afterAll(async () => {
  await server?.close();
  if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true });
});

test.each([
  '/src/renderer/useSettings.ts',
  '/plugins/extensions/sample/browser/useSettings.ts',
])('connects non-JSX Hook signatures to the real refresh runtime in %s', async url => {
  const result = await server.transformRequest(url);
  expect(result?.code).toContain('__createHookSignature()');
  expect(result?.code).toContain('createSignatureFunctionForTransform as __createHookSignature');
  expect(result?.code).toContain('from "/@react-refresh"');
  expect(result?.code).toContain('return [useSettings]');
  expect(result?.map).toBeTruthy();
});

test.each([
  '/src/main/useSettings.ts',
  '/src/shared/useSettings.ts',
  '/plugins/extensions/sample/host/useSettings.ts',
])('leaves non-browser modules outside refresh instrumentation: %s', async url => {
  const result = await server.transformRequest(url);
  expect(result?.code).not.toContain('createSignatureFunctionForTransform');
});

test('skips signatures when HMR is disabled', async () => {
  const inactiveServer = await createServer({
    configFile: false,
    root: projectRoot,
    plugins: [reactHooksRefreshPlugin(projectRoot)],
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { react: path.dirname(require.resolve('react/package.json')) } },
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  try {
    const result = await inactiveServer.transformRequest('/src/renderer/useSettings.ts');
    expect(result?.code).not.toContain('createSignatureFunctionForTransform');
  } finally {
    await inactiveServer.close();
  }
});

test('omits the refresh runtime from production builds', async () => {
  const result = await build({
    configFile: false,
    root: projectRoot,
    logLevel: 'silent',
    plugins: [reactHooksRefreshPlugin(projectRoot), react()],
    build: {
      write: false,
      lib: { entry: path.join(projectRoot, 'src/renderer/useSettings.ts'), formats: ['es'] },
      rollupOptions: { external: ['react'] },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!('output' in output)) continue;
    for (const chunk of output.output) {
      if (chunk.type === 'chunk') expect(chunk.code).not.toContain('createSignatureFunctionForTransform');
    }
  }
});

async function createRefreshRuntime() {
  const runtimePath = path.join(path.dirname(require.resolve('@vitejs/plugin-react')), 'refresh-runtime.js');
  const source = (await fs.readFile(runtimePath, 'utf8'))
    .replace(/^export default .*$/gm, '')
    .replace(/^export /gm, '');
  return vm.runInNewContext(
    source + ';\n({ register, createSignatureFunctionForTransform, performReactRefresh })',
    { window: {}, setTimeout, clearTimeout },
  );
}

function evaluate(source: string, bindings: Record<string, unknown>, exports: string[]) {
  const code = source.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  return vm.runInNewContext(code + `;\n({ ${exports.join(', ')} })`, { ...bindings });
}

test.each([
  { body: newHooks, shouldRemount: true },
  { body: oldHooks.replace('return value;', 'return { enabled: value };'), shouldRemount: false },
])('remounts only when a nested Hook signature changes ($shouldRemount)', async ({ body, shouldRemount }) => {
  const runtime = await createRefreshRuntime();
  const bindings = {
    $RefreshSig$: runtime.createSignatureFunctionForTransform,
    __createHookSignature: runtime.createSignatureFunctionForTransform,
    $RefreshReg$: () => {},
    useState: () => [false],
    useEffect: () => {},
    useSyncExternalStore: () => false,
  };
  const plugin = reactHooksRefreshPlugin(projectRoot);
  const transform = plugin.transform as (code: string, id: string) => Promise<{ code: string }>;
  const componentSource = `
import { useAvailability } from './useSettings';
export function Fixture() { useAvailability(); return null; }
`;
  const component = await transformWithOxc(componentSource, 'Fixture.tsx', {
    jsx: { runtime: 'automatic', refresh: true },
  });
  const components = [];
  for (const source of [oldHooks, body]) {
    const result = await transform(source, path.join(projectRoot, 'src/renderer/useSettings.ts'));
    const hooks = evaluate(result.code, bindings, ['useAvailability']);
    const { Fixture } = evaluate(component.code, { ...bindings, ...hooks }, ['Fixture']);
    Fixture(); // Collect the nested signatures before simulating the edit.
    components.push(Fixture);
  }
  runtime.register(components[0], 'Fixture');
  runtime.register(components[1], 'Fixture');

  const update = runtime.performReactRefresh();

  expect(update.staleFamilies.size).toBe(shouldRemount ? 1 : 0);
  expect(update.updatedFamilies.size).toBe(shouldRemount ? 0 : 1);
});
