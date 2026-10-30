import path from 'node:path';

import { build } from 'esbuild';
import { expect, it } from 'vitest';

const pluginRoot = path.resolve(import.meta.dirname, '../..');

async function bundle(entry: string, platform: 'node' | 'browser' = 'node') {
  return build({
    absWorkingDir: pluginRoot,
    tsconfigRaw: {},
    entryPoints: [path.resolve(pluginRoot, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform,
    packages: 'external',
    metafile: true,
  });
}

it('bundles workflow execution without application or Agent Team implementation', async () => {
  const result = await bundle('index.ts');
  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
  expect(inputs.some(file => file.startsWith('../'))).toBe(false);
  expect(inputs.some(file => file.startsWith('host/'))).toBe(false);
  expect(inputs.some(file => file.startsWith('browser/'))).toBe(false);
  expect(inputs.some(file => file.startsWith('app/'))).toBe(false);
  expect(inputs).toContain('execution/launch-admission.ts');
  const imports = Object.values(result.metafile!.inputs).flatMap(input => input.imports);
  expect(imports.some(item => item.path.startsWith('@runtime-services/sdk/'))).toBe(true);
});

it('exposes browser-safe application contracts through plugin contracts and prompts only', async () => {
  const result = await bundle('app/contracts/index.ts', 'browser');
  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
  expect(inputs.some(file => file.startsWith('src/main/'))).toBe(false);
  const pluginInputs = inputs.filter(file => !file.startsWith('../'));
  expect(pluginInputs.length).toBeGreaterThan(0);
  expect(pluginInputs.every(file => /(?:^|\/)(contracts|prompt)\//.test(file))).toBe(true);
});

it('keeps product workflow coordination independent of Electron IPC', async () => {
  const result = await bundle('host/coordinator.ts');
  const imports = Object.values(result.metafile!.inputs).flatMap(input => input.imports);
  expect(imports.some(item => item.path === 'electron')).toBe(false);
  expect(imports.some(item => item.path.startsWith('openclaw/plugin-sdk'))).toBe(false);
  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
  expect(inputs.filter(file => file.startsWith('src/'))).toEqual([]);
  expect(inputs).toContain('host/coordinator.ts');
  expect(
    Object.keys(result.metafile!.inputs).some(file =>
      file.replaceAll('\\', '/').startsWith('src/main/ipc/'),
    ),
  ).toBe(false);
});

it.each(['coordinator', 'config'])(
  'host %s bundles independently of the application and native SDK',
  async module => {
    const result = await bundle('host/' + module + '.ts');
    const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
    expect(inputs.some(file => file.startsWith('../'))).toBe(false);
    expect(inputs.some(file => file.startsWith('browser/'))).toBe(false);
    const imports = Object.values(result.metafile!.inputs).flatMap(input => input.imports);
    expect(
      imports.some(item => item.path === 'electron' || item.path.startsWith('openclaw/plugin-sdk')),
    ).toBe(false);
  },
);

it.each([
  'composer',
  'discovery',
  'panel',
  'batch',
  'detail',
  'intervention',
  'handoff',
  'translations',
  'graph/layout',
  'graph/viewport',
])(
  'browser %s bundles independently of application, host and native registration',
  async module => {
    const result = await bundle('browser/' + module + '.ts', 'browser');
    const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
    expect(inputs.some(file => file.startsWith('../'))).toBe(false);
    expect(inputs.some(file => /^(host|service|execution|data|batch)\//.test(file))).toBe(false);
    const imports = Object.values(result.metafile!.inputs).flatMap(input => input.imports);
    expect(
      imports.some(item => item.path === 'electron' || item.path.startsWith('openclaw/plugin-sdk')),
    ).toBe(false);
  },
);
