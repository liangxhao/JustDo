import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { build } from 'esbuild';
import { expect, it } from 'vitest';

async function bundle(entry: string, platform: 'node' | 'browser' = 'node') {
  return build({
    entryPoints: [path.resolve(entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform,
    ...(platform === 'node' ? { packages: 'external' as const } : {}),
    metafile: true,
  });
}

it('bundles workflow execution without application or Agent Team implementation', async () => {
  const result = await bundle('plugins/extensions/swarm-workflow/index.ts');
  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
  expect(inputs.some(file => file.startsWith('src/'))).toBe(false);
  expect(inputs.some(file => file.startsWith('plugins/extensions/swarm-workflow/host/'))).toBe(
    false,
  );
  expect(inputs.some(file => file.startsWith('plugins/extensions/swarm-workflow/browser/'))).toBe(
    false,
  );
  expect(inputs.some(file => file.startsWith('plugins/extensions/agent-team/'))).toBe(false);
  expect(inputs).toContain('plugins/extensions/swarm-workflow/execution/launch-admission.ts');
  expect(inputs).toContain('plugins/extensions/runtime-services/execution/managed-subagent.ts');
  expect(inputs).toContain('plugins/extensions/runtime-services/filesystem/admission.ts');
});

it('keeps required Runtime Services independent of the optional workflow implementation', async () => {
  const result = await bundle('plugins/extensions/runtime-services/index.ts');
  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
  expect(inputs.some(file => file.startsWith('src/'))).toBe(false);
  expect(inputs.some(file => file.startsWith('plugins/extensions/swarm-workflow/'))).toBe(false);
});

it('exposes browser-safe application contracts through plugin contracts and prompts only', async () => {
  const result = await bundle('plugins/extensions/swarm-workflow/app/contracts/index.ts', 'browser');
  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
  expect(inputs.some(file => file.startsWith('src/main/'))).toBe(false);
  const pluginInputs = inputs.filter(file => file.startsWith('plugins/extensions/'));
  expect(pluginInputs.length).toBeGreaterThan(0);
  expect(pluginInputs.every(file => /\/(contracts|prompt)\//.test(file))).toBe(true);
});

it('keeps product workflow coordination independent of Electron IPC', async () => {
  const result = await bundle('plugins/extensions/swarm-workflow/host/coordinator.ts');
  const imports = Object.values(result.metafile!.inputs).flatMap(input => input.imports);
  expect(imports.some(item => item.path === 'electron')).toBe(false);
  expect(imports.some(item => item.path.startsWith('openclaw/plugin-sdk'))).toBe(false);
  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
  expect(inputs.filter(file => file.startsWith('src/'))).toEqual([]);
  expect(inputs).toContain('plugins/extensions/swarm-workflow/host/coordinator.ts');
  expect(
    Object.keys(result.metafile!.inputs).some(file =>
      file.replaceAll('\\', '/').startsWith('src/main/ipc/'),
    ),
  ).toBe(false);
});

it('stages a self-contained workflow entry before runtime source pruning', () => {
  const {
    bundleProductExtension,
  } = require('../../../../scripts/openclaw/sync-openclaw-runtime-resources.cjs');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-workflow-bundle-'));
  try {
    fs.writeFileSync(path.join(target, 'index.ts'), '// staged source');
    bundleProductExtension(path.resolve('plugins/extensions/swarm-workflow'), target);
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    expect(pkg.openclaw.extensions).toEqual(['./index.js']);
    expect(fs.existsSync(path.join(target, 'index.ts'))).toBe(false);
    const code = fs.readFileSync(path.join(target, 'index.js'), 'utf8');
    expect(code).toContain('swarm-workflow.service');
    expect(code).not.toMatch(/from ["']\.\.\//);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

it.each(['coordinator', 'config'])(
  'host %s bundles independently of the application and native SDK',
  async module => {
    const result = await bundle('plugins/extensions/swarm-workflow/host/' + module + '.ts');
    const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
    expect(inputs.some(file => file.startsWith('src/'))).toBe(false);
    expect(
      inputs.some(file => file.startsWith('plugins/extensions/swarm-workflow/browser/')),
    ).toBe(false);
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
    const result = await bundle(
      'plugins/extensions/swarm-workflow/browser/' + module + '.ts',
      'browser',
    );
    const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
    expect(inputs.some(file => file.startsWith('src/'))).toBe(false);
    expect(
      inputs.some(file =>
        /plugins\/extensions\/swarm-workflow\/(host|service|execution|data|batch)\//.test(file),
      ),
    ).toBe(false);
    const imports = Object.values(result.metafile!.inputs).flatMap(input => input.imports);
    expect(
      imports.some(item => item.path === 'electron' || item.path.startsWith('openclaw/plugin-sdk')),
    ).toBe(false);
  },
);
