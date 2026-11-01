import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { resolveReasoningRuntime } from './reasoning-runtime';

const roots: string[] = [];
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-reasoning-runtime-'));
  roots.push(root);
  return root;
}

function runtime(root: string, version = '2026.10.7') {
  const write = (file: string, content = '') => {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  };
  write('package.json', JSON.stringify({ name: 'openclaw', version }));
  for (const file of [
    'dist/builtin-openclaw-Ci5YBsOb.mjs',
    'dist/server-chat-state-go3yND5C.mjs',
    'dist/server-chat-qsqHPdkU.mjs',
    'node_modules/@openclaw/ai/dist/reasoning-tag-text-partitioner-CpOy9-IQ.mjs',
    'node_modules/@openclaw/ai/dist/internal/openai.mjs',
    'node_modules/@openclaw/ai/dist/openai-completions-transport-fixture.mjs',
  ]) write(file);
  write('node_modules/@openclaw/ai/dist/host-fixture.mjs', 'function createAiTransportHost() {}');
  return fs.realpathSync(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('selects the prepared locked vendor runtime when no build runtime exists', () => {
  const root = repository();
  const selected = runtime(path.join(root, 'vendor/openclaw-runtime/current'));
  expect(resolveReasoningRuntime({ repositoryRoot: root, environment: {} })).toBe(selected);
});

test('gives the prepared build priority over vendor and preserves explicit pristine priority', () => {
  const root = repository();
  const build = runtime(path.join(root, 'build/runtimes/openclaw/win-x64'));
  const vendor = runtime(path.join(root, 'vendor/openclaw-runtime/current'));
  expect(resolveReasoningRuntime({ repositoryRoot: root, environment: {} })).toBe(build);
  expect(resolveReasoningRuntime({ repositoryRoot: root, environment: {
    JUSTDO_EXECUTION_PRISTINE_DIR: vendor,
    OPENCLAW_TEST_NATIVE_RUNTIME_DIR: build,
  } })).toBe(vendor);
});

test('rejects an incomplete preferred artifact rather than falling through to a valid vendor runtime', () => {
  const root = repository();
  runtime(path.join(root, 'vendor/openclaw-runtime/current'));
  fs.mkdirSync(path.join(root, 'build/runtimes/openclaw/win-x64'), { recursive: true });
  expect(() => resolveReasoningRuntime({ repositoryRoot: root, environment: {} }))
    .toThrow('Native reasoning runtime admission failed');
});

test.each(['missing', 'wrong-version', 'missing-owner', 'ambiguous-transport'])(
  'rejects an explicitly selected %s runtime without using defaults', kind => {
    const root = repository();
    runtime(path.join(root, 'vendor/openclaw-runtime/current'));
    const selected = path.join(root, 'selected');
    if (kind !== 'missing') runtime(selected, kind === 'wrong-version' ? '2026.10.6' : undefined);
    if (kind === 'missing-owner') fs.unlinkSync(path.join(selected, 'dist/server-chat-qsqHPdkU.mjs'));
    if (kind === 'ambiguous-transport') fs.writeFileSync(
      path.join(selected, 'node_modules/@openclaw/ai/dist/openai-completions-transport-other.mjs'), '',
    );
    expect(() => resolveReasoningRuntime({ repositoryRoot: root, environment: {
      OPENCLAW_TEST_NATIVE_RUNTIME_DIR: selected,
    } })).toThrow('Native reasoning runtime admission failed');
  },
);

test.each([{}, { OPENCLAW_RUNTIME_CONTRACT_REQUIRED: '1' }])(
  'does not silently skip native reasoning validation without a prepared runtime: %j', environment => {
    expect(() => resolveReasoningRuntime({ repositoryRoot: repository(), environment }))
      .toThrow('Native reasoning tests require a prepared openclaw@2026.10.7 runtime');
  },
);
