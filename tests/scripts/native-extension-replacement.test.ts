import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, onTestFinished, test } from 'vitest';

const {
  syncLocalExtensions,
} = require('../../scripts/openclaw/sync-openclaw-runtime-resources.cjs');
const {
  precompileOpenClawExtensions,
} = require('../../scripts/openclaw/precompile-openclaw-extensions.cjs');
const {
  listBuildRecipeFiles,
} = require('../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');

test('replaces the entire native directory and compiles main, setup, policy, catalog and workers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-replacement-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'plugins/extensions/openai');
  const runtime = path.join(root, 'runtime');
  const target = path.join(runtime, 'dist/extensions/openai');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ version: '2026.10.4' }));
  fs.writeFileSync(
    path.join(target, 'native-only.js'),
    'throw Error("must not load upstream entry");',
  );
  fs.writeFileSync(
    path.join(source, 'upstream-source.json'),
    JSON.stringify({ id: 'openai', version: '2026.10.4' }),
  );
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({
      type: 'module',
      version: '2026.10.4',
      openclaw: {
        runtimeBundled: true,
        extensions: ['./index.ts'],
        build: { workerEntries: ['./audio.worker.ts', './socket.worker.ts'] },
      },
    }),
  );
  fs.writeFileSync(
    path.join(source, 'openclaw.plugin.json'),
    JSON.stringify({ id: 'openai', capabilityCatalogEntry: './capability-catalog.ts' }),
  );
  for (const name of [
    'index',
    'setup-api',
    'provider-policy-api',
    'provider-contract-api',
    'capability-catalog',
    'audio.worker',
    'socket.worker',
  ])
    fs.writeFileSync(path.join(source, name + '.ts'), `export const identity: string = '${name}';`);

  expect(syncLocalExtensions(root, runtime, 'test').copied).toEqual(['openai']);
  expect(fs.existsSync(path.join(target, 'native-only.js'))).toBe(false);
  expect(await precompileOpenClawExtensions(runtime, { required: true })).toMatchObject({
    compiled: 1,
    errors: 0,
  });
  for (const name of [
    'index',
    'setup-api',
    'provider-policy-api',
    'provider-contract-api',
    'capability-catalog',
    'audio.worker',
    'socket.worker',
  ]) {
    expect(fs.existsSync(path.join(target, name + '.js'))).toBe(true);
    expect(fs.existsSync(path.join(target, name + '.ts'))).toBe(false);
  }
  expect(
    JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).openclaw,
  ).toMatchObject({
    extensions: ['./index.js'],
    build: { workerEntries: ['./audio.worker.js', './socket.worker.js'] },
  });
  expect(
    JSON.parse(fs.readFileSync(path.join(target, 'openclaw.plugin.json'), 'utf8'))
      .capabilityCatalogEntry,
  ).toBe('./capability-catalog.js');
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ version: '2026.10.1' }));
  expect(() => syncLocalExtensions(root, runtime, 'test')).toThrow(/requires review/);
  expect(fs.existsSync(path.join(target, 'index.js'))).toBe(true);
});

test('binds every local OpenAI production source, contract and worker to the runtime fingerprint', () => {
  const files = listBuildRecipeFiles(path.resolve('.')).map((file: string) =>
    path.relative('.', file).replaceAll('\\', '/'),
  );
  for (const name of [
    'image-generation-provider.ts',
    'tts.ts',
    'realtime-transcription-provider-factory.ts',
    'video-provider.ts',
    'contracts/media-config.ts',
    'package-lock.json',
    'upstream-source.json',
    'realtime-quicksilver-audio.worker.ts',
  ])
    expect(files).toContain('plugins/extensions/openai/' + name);
  expect(files.some((file: string) => file.endsWith('sync-native-extension-overlay.cjs'))).toBe(
    false,
  );
});

test('binds Smart Canvas UI sources while excluding unused assets and tests', () => {
  const files = listBuildRecipeFiles(path.resolve('.')).map((file: string) =>
    path.relative('.', file).replaceAll('\\', '/'),
  );
  for (const name of [
    'index.ts',
    'document/resource-bootstrap.ts',
    'document/serialization.ts',
    'ui/content-kind.ts',
    'ui/runtime.ts',
  ])
    expect(files).toContain(`plugins/extensions/smart-canvas/${name}`);
  expect(
    files.some((file: string) => file.startsWith('plugins/extensions/smart-canvas/assets/')),
  ).toBe(false);
  expect(
    files.some((file: string) => file.startsWith('plugins/extensions/smart-canvas/tests/')),
  ).toBe(false);
});
