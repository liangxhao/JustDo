import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.7/040-plugin-recovery-missing-source.cjs');
const { transform, TARGET, CONTRACT, callerRange } = patch.__testing;
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\r\n/g, '\n');
const nativeFactory = fixture('plugin-reload-recovery.fixture.js');
// Exact published prefix through the recovery allocation; only the closing brace is synthetic.
const nativeCallerPrefix = fixture('plugin-reload-recovery-caller-prefix.fixture.js');
const nativeGeneration = fixture('plugin-runtime-generation.fixture.js');
const native = `${nativeFactory}\n${nativeCallerPrefix}`;
const roots: string[] = [];
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-recovery-test-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'dist'));
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('plugin-recovery-test-'))
      throw new Error('Unexpected fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

class PluginSourceRecoveryUnavailableError extends Error {}
const codeError = (code: string) => Object.assign(new Error('Native capture refused'), { code });
const wrappedMissing = () => new Error('Cannot capture plugin source', { cause: codeError('ENOENT') });

function setup(error: unknown, options: {
  pristine?: boolean;
  retiringIds?: string[];
  defaultFactory?: boolean;
  siblingError?: unknown;
  freshInstall?: boolean;
} = {}) {
  const sibling: { id: string; status: string; enabled?: boolean } = { id: 'healthy-sibling', status: 'loaded' };
  const selected: typeof sibling = { id: 'native-plugin', status: 'loaded' };
  const dispose = vi.fn();
  const preparePlugins = vi.fn((_options: {
    pluginIds: string[];
    moduleRecoveries: Map<string, unknown>;
    loadModules?: boolean;
  }) => ({
    retireGatewayRuntimeBindings: vi.fn(),
    pluginRegistry: { plugins: [sibling] },
  }));
  const capturePluginRuntimeRecovery = vi.fn((record: typeof selected) => {
    if (record === selected) throw error;
    if (options.siblingError !== undefined) throw options.siblingError;
    return { module: { dispose } };
  });
  const factory = vm.runInNewContext(`${options.pristine ? native : transform(native)}\ncreatePluginReloadRecovery`, {
    Error, Map, Set, Array,
    PluginSourceRecoveryUnavailableError,
    capturePluginRuntimeRecovery,
    getPluginInstance: () => ({ disposing: false }),
  });
  const previous = { plugins: options.freshInstall ? [sibling] : [selected, sibling] };
  const recovery = options.defaultFactory
    ? factory(previous, preparePlugins)
    : factory(previous, preparePlugins, options.retiringIds ?? ['native-plugin']);
  return { recovery, previous, preparePlugins, capturePluginRuntimeRecovery, dispose, selected, sibling };
}

function createGeneration() {
  const factory = vm.runInNewContext(`${nativeGeneration}\ncreateGatewayPluginRuntimeGeneration`, {
    Error, Map, Set, Array, Object,
    createDeferredCore: () => ({ promise: Promise.resolve(), resolve: vi.fn() }),
    getPluginInstance: () => ({ acceptingCalls: true }),
  });
  return factory({ getServices: () => null, setServices: vi.fn() });
}

test('pins complete native owners to the locked published package', () => {
  expect(createHash('sha256').update(nativeFactory).digest('hex'))
    .toBe('cb053ab675c7b5f193f0128214405d4fba4f5531f13339d93ce7212a3a598886');
  expect(createHash('sha256').update(nativeGeneration).digest('hex'))
    .toBe('6a7ac7d9b7b16340b4ccafbc90b7881b7a975965b9477c5ba840f9422041d94e');
  const targets = JSON.parse(fs.readFileSync(path.join(__dirname,
    '../../../../scripts/patches/v2026.10.7/pristine-targets.json'), 'utf8'));
  expect(targets.targets.find((target: { file: string }) => target.file === TARGET).sha256)
    .toBe('f17288b403547c0594f215ea5d4809b5810834e815de6e67ff618859e9feef8f');
});

test.each([
  ['captured DLL missing', wrappedMissing],
  ['copy permission denied', () => codeError('EPERM')],
] as const)('does not attempt a retired target rollback copy (%s)', (_label, makeError) => {
  const error = makeError();
  expect(() => setup(error, { pristine: true }).recovery.capture(new Set(['native-plugin']))).toThrow(error);
  const f = setup(error);

  expect(f.recovery.capture(new Set(['native-plugin', 'healthy-sibling']))).toEqual([]);
  expect(f.capturePluginRuntimeRecovery).toHaveBeenCalledExactlyOnceWith(f.sibling);
  expect([...f.recovery.previousHookIds]).toEqual(['native-plugin', 'healthy-sibling']);
  expect([...f.recovery.unavailablePluginIds]).toEqual(['native-plugin']);
  f.recovery.dispose();
  f.recovery.dispose();
  expect(f.dispose).toHaveBeenCalledOnce();
});

test.each(['default', 'empty'] as const)('keeps ordinary capture for %s factory callers', admission => {
  const error = wrappedMissing();
  const f = setup(error, { defaultFactory: admission === 'default', retiringIds: [] });
  expect(() => f.recovery.capture(new Set(['native-plugin']))).toThrow(error);
  expect(f.capturePluginRuntimeRecovery).toHaveBeenCalledExactlyOnceWith(f.selected);
  expect([...f.recovery.unavailablePluginIds]).toEqual([]);
});

test.each([undefined, 'reload', 'enable', 'install', 'update', 'refresh', 'metadata', 'disable', 'uninstall'])('passes only exact native retirement targets at the actual caller (%s)', async reason => {
  const capture = vi.fn(() => ({}));
  const previousRegistry = { plugins: [] };
  const preparePlugins = vi.fn();
  const caller = vm.runInNewContext(`${callerRange(transform(native)).text}\nreloadGatewayPlugins`, {
    createPluginReloadRecovery: capture,
    getGatewayRestartDrainSignal: () => new AbortController().signal,
    getRuntimeConfig: () => ({}),
    getPluginRuntimeLoadContext: () => ({}),
  });
  const pluginIds = ['native-plugin'];

  await caller({
    runtime: { pluginRuntime: { registry: previousRegistry },
      kernel: { pluginRuntimeGeneration: { currentServices: () => ({}) } } },
    loadGatewayPluginBootstrapModule: async () => ({ prepareGatewayPluginLoad: preparePlugins }),
  }, { pluginLifecycle: reason === undefined ? undefined : { reason, pluginIds }, pluginIds: ['unrelated'] });

  const retiring = reason === 'uninstall' || reason === 'disable' || reason === 'install';
  expect(capture).toHaveBeenCalledExactlyOnceWith(previousRegistry, preparePlugins, retiring ? pluginIds : []);
  if (retiring) expect(capture.mock.calls[0][2]).toBe(pluginIds);
});

test('leaves fresh installs without old target instances on the ordinary native path', () => {
  for (const pristine of [true, false]) {
    const f = setup(codeError('ENOENT'), { pristine, freshInstall: true });
    expect(f.recovery.capture(new Set(['native-plugin', 'healthy-sibling']))).toEqual([]);
    expect(f.capturePluginRuntimeRecovery).toHaveBeenCalledExactlyOnceWith(f.sibling);
    expect([...f.recovery.unavailablePluginIds]).toEqual([]);
    expect([...f.recovery.previousHookIds]).toEqual(['healthy-sibling']);
  }
});

test('snapshots exact retirement identities without widening to case variants or later caller mutations', () => {
  const error = codeError('EPERM');
  const ids = ['native-plugin'];
  const f = setup(error, { retiringIds: ids });
  ids.splice(0, 1, 'healthy-sibling');

  expect(f.recovery.capture(new Set(['native-plugin', 'healthy-sibling']))).toEqual([]);
  expect(f.capturePluginRuntimeRecovery).toHaveBeenCalledExactlyOnceWith(f.sibling);
  for (const retiringIds of [['Native-Plugin'], ['native-plugin-extra'], ['healthy-sibling']]) {
    const unrelated = setup(error, { retiringIds });
    expect(() => unrelated.recovery.capture(new Set(['native-plugin']))).toThrow(error);
  }
});

test('can retire the still-registered owner when disabling after an earlier capture failure', async () => {
  const error = wrappedMissing();
  expect(() => setup(error, { pristine: true }).recovery.capture(new Set(['native-plugin']))).toThrow(error);
  let recovery: ReturnType<typeof setup>['recovery'];
  const capturePluginRuntimeRecovery = vi.fn(() => { throw error; });
  const previousRegistry = { plugins: [{ id: 'native-plugin', status: 'loaded' }] };
  const createRecovery = vm.runInNewContext(`${transform(native)}\ncreatePluginReloadRecovery`, {
    Error, Map, Set, Array,
    PluginSourceRecoveryUnavailableError,
    capturePluginRuntimeRecovery,
    getPluginInstance: () => ({ disposing: false }),
  });
  const caller = vm.runInNewContext(`${callerRange(transform(native)).text}\nreloadGatewayPlugins`, {
    createPluginReloadRecovery: (...args: unknown[]) => { recovery = createRecovery(...args); return recovery; },
    getGatewayRestartDrainSignal: () => new AbortController().signal,
    // Native uninstall has already saved disabled policy, while old registration remains live.
    getRuntimeConfig: () => ({ plugins: { entries: { 'native-plugin': { enabled: false } } } }),
    getPluginRuntimeLoadContext: () => ({}),
  });

  await caller({
    runtime: { pluginRuntime: { registry: previousRegistry },
      kernel: { pluginRuntimeGeneration: { currentServices: () => ({}) } } },
    loadGatewayPluginBootstrapModule: async () => ({ prepareGatewayPluginLoad: vi.fn() }),
  }, { pluginLifecycle: { reason: 'disable', pluginIds: ['native-plugin'] } });

  expect(recovery.capture(new Set(['native-plugin']))).toEqual([]);
  expect(capturePluginRuntimeRecovery).not.toHaveBeenCalled();
  expect([...recovery.previousHookIds]).toEqual(['native-plugin']);
});

test.each([
  ['missing file', () => codeError('ENOENT')],
  ['permission', () => codeError('EPERM')],
  ['wrapped missing file', wrappedMissing],
  ['aggregate cleanup failure', () => new AggregateError([codeError('ENOENT'), codeError('EPERM')])],
] as const)('retains the original non-target capture failure (%s)', (_label, makeError) => {
  const error = makeError();
  const f = setup(undefined, { siblingError: error });

  expect(() => f.recovery.capture(new Set(['native-plugin', 'healthy-sibling']))).toThrow(error);
  expect(f.capturePluginRuntimeRecovery).toHaveBeenCalledExactlyOnceWith(f.sibling);
  expect([...f.recovery.unavailablePluginIds]).toEqual(['native-plugin']);
});

test('keeps the existing native typed-error fallback for ordinary captures', () => {
  for (const defaultFactory of [true, false]) {
    const f = setup(new PluginSourceRecoveryUnavailableError('Original native diagnostic'), {
      defaultFactory, retiringIds: [],
    });
    expect(f.recovery.capture(new Set(['native-plugin'])))
      .toEqual([expect.stringContaining('Plugin native-plugin captured source is missing')]);
    expect([...f.recovery.unavailablePluginIds]).toEqual(['native-plugin']);
  }
  const f = setup(undefined, { siblingError: new PluginSourceRecoveryUnavailableError('Sibling source removed') });
  expect(f.recovery.capture(new Set(['native-plugin', 'healthy-sibling'])))
    .toEqual([expect.stringContaining('Plugin healthy-sibling captured source is missing')]);
});

test('restores a changed sibling without recreating the intentionally retired target', () => {
  const f = setup(codeError('EPERM'));
  f.recovery.capture(new Set(['native-plugin', 'healthy-sibling']));
  const restored = f.recovery.prepare({ replacePluginIds: new Set(['native-plugin', 'healthy-sibling']) }, new Error('Later activation failed'));

  expect(restored.pluginRegistry.plugins).toEqual([f.sibling]);
  expect(f.preparePlugins).toHaveBeenCalledTimes(2);
  expect(f.preparePlugins.mock.calls.every(([options]) => options.pluginIds.join() === 'healthy-sibling')).toBe(true);
  expect(f.preparePlugins.mock.calls[0][0]).toMatchObject({ loadModules: false });
  expect(f.preparePlugins.mock.results[0].value.retireGatewayRuntimeBindings).toHaveBeenCalledOnce();
  expect(f.preparePlugins.mock.calls[1][0].moduleRecoveries.has('native-plugin')).toBe(false);
  expect(f.preparePlugins.mock.calls[1][0].moduleRecoveries.has('healthy-sibling')).toBe(true);
  f.recovery.dispose();
  expect(f.dispose).toHaveBeenCalledOnce();
});

test('keeps the native rollback guard against reintroducing an unavailable owner', () => {
  const f = setup(wrappedMissing());
  f.recovery.capture(new Set(['native-plugin']));
  f.preparePlugins.mockReturnValueOnce({
    retireGatewayRuntimeBindings: vi.fn(),
    pluginRegistry: { plugins: [{ ...f.selected, enabled: true }] },
  });

  expect(() => f.recovery.prepare({ replacePluginIds: new Set(['native-plugin']) }, new Error('Rollback')))
    .toThrow('Plugin recovery requires previously retired runtimes without captured source: native-plugin');
  expect(f.preparePlugins).toHaveBeenCalledOnce();
});

test.each(['unchanged', 'restored'])('preserves native live status before the old target stops (%s)', outcome => {
  const error = codeError('EPERM');
  const f = setup(undefined, { siblingError: error });
  expect(() => f.recovery.capture(new Set(['native-plugin', 'healthy-sibling']))).toThrow(error);
  const generation = createGeneration();
  const reservation = generation.reserve();
  reservation.setReloadStatus({ phase: 'reloading', pluginIds: ['native-plugin', 'healthy-sibling'] });
  reservation.reject();
  reservation.finishReload(outcome, new Set(['native-plugin', 'healthy-sibling']), f.previous, f.recovery.unavailablePluginIds);

  expect(generation.getReloadStatus()).toBeUndefined();
});

test('reports only the retired target as failed after native rollback restores its healthy sibling', () => {
  const f = setup(wrappedMissing());
  const changed = new Set(['native-plugin', 'healthy-sibling']);
  f.recovery.capture(changed);
  const restored = f.recovery.prepare({ replacePluginIds: changed }, new Error('After stop'));
  const generation = createGeneration();
  const reservation = generation.reserve();
  reservation.reject();
  reservation.finishReload('restored', changed, restored.pluginRegistry, f.recovery.unavailablePluginIds);

  expect(generation.getReloadStatus()).toMatchObject({ phase: 'failed', pluginIds: ['native-plugin'] });
});

test('validates source and compressed bundle atomically and rejects mixed or corrupted shapes', () => {
  const root = makeRoot();
  const files = [path.join(root, TARGET), path.join(root, 'gateway-bundle.mjs')];
  files.forEach(file => fs.writeFileSync(file, native));
  expect(() => patch.verifyPatch(root)).toThrow('must skip only its exact targets');
  expect(patch.applyPatch(root)).toHaveLength(2);
  expect(patch.applyPatch(root)).toEqual([]);
  const current = files.map(file => fs.readFileSync(file, 'utf8'));
  const bundle = transformSync(current[1], { minifySyntax: true, minifyWhitespace: true, target: 'node24', legalComments: 'none' }).code;
  fs.writeFileSync(files[1], bundle);
  expect(patch.verifyPatch(root)).toEqual([]);
  expect(patch.applyPatch(root)).toEqual([]);

  fs.writeFileSync(files[1], native);
  const mixed = files.map(file => fs.readFileSync(file, 'utf8'));
  expect(() => patch.applyPatch(root)).toThrow('Mixed source/bundle');
  expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(mixed);
  for (const [file, corrupted] of [
    [files[0], current[0].replaceAll(CONTRACT, CONTRACT.replace('10_7', '10_6'))],
    [files[0], current[0].replace('skipRecoveryPluginIds = []', 'skipRecoveryPluginIds = ["native-plugin"]')],
    [files[0], current[0].replace('new Set(skipRecoveryPluginIds)', 'new Set(["native-plugin"])')],
    [files[0], current[0].replace('previousHookIds.add(record.id);', '')],
    [files[0], current[0].replace('skipRecoveryTargets.has(record.id)', 'skipRecoveryTargets.size > 0')],
    [files[0], current[0].replace('params.pluginLifecycle?.reason === "disable"', 'params.pluginLifecycle?.reason === "enable"')],
    [files[0], current[0].replace('params.pluginLifecycle?.reason === "install"', 'params.pluginLifecycle?.reason === "reload"')],
    [files[0], current[0].replace('params.pluginLifecycle.pluginIds : []', 'params.pluginIds : []')],
    [files[1], bundle.replace('selectedUnavailableIds.has', 'selectedUnavailableIds.get')],
  ]) {
    fs.writeFileSync(files[0], current[0]);
    fs.writeFileSync(files[1], bundle);
    fs.writeFileSync(file, corrupted);
    const before = files.map(filename => fs.readFileSync(filename, 'utf8'));
    expect(() => patch.applyPatch(root)).toThrow();
    expect(() => patch.verifyPatch(root)).toThrow();
    expect(files.map(filename => fs.readFileSync(filename, 'utf8'))).toEqual(before);
  }
});

test.each(['RECOVERY_MISSING_SOURCE', 'UNINSTALL_RECOVERY', 'RETIREMENT_RECOVERY'])(
  'rejects historical %s marker-only partial shapes in source and bundle without writes', family => {
    const root = makeRoot();
    const files = [path.join(root, TARGET), path.join(root, 'gateway-bundle.mjs')];
    const current = transform(native);
    for (const body of [native, current]) {
      for (const selected of files) {
        files.forEach(file => fs.writeFileSync(file, current));
        fs.writeFileSync(selected, `// RUNTIME_PLUGIN_${family}_V2026_10_7\n${body}`);
        const before = files.map(file => fs.readFileSync(file, 'utf8'));
        expect(() => patch.applyPatch(root)).toThrow('historical lifecycle recovery');
        expect(() => patch.verifyPatch(root)).toThrow('historical lifecycle recovery');
        expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
      }
    }
  },
);

test('verifies compressed callers with merged local declarations and alpha-renamed parameters', () => {
  const withFollowingLocal = native.replace(/}\s*$/, 'const afterCapture = params.nextConfig; await afterCapture(); return afterCapture;\n}');
  const renamed = withFollowingLocal.replace(/\bparams\b/g, 'nativeReloadParams');
  const current = transform(renamed);
  const bundle = transformSync(current, {
    minifySyntax: true, minifyWhitespace: true, target: 'node24', legalComments: 'none',
  }).code;

  expect(bundle).toContain('skipRecoveryPluginIds=[]');
  expect(bundle).toContain(',afterCapture=nativeReloadParams.nextConfig;');
  expect(transform(bundle, 'gateway-bundle.mjs')).toBe(bundle);
  expect(() => transform(bundle.replace('nativeReloadParams.pluginLifecycle.pluginIds:[]', 'previousConfig.pluginIds:[]'), 'gateway-bundle.mjs'))
    .toThrow('lifecycle targets changed');
});
