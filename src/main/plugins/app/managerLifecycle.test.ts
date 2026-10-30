import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { AppPluginManifest } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import { resolvePluginDataDirectory } from '../../../../plugins/sdk/app-plugin-sdk/data';
import type { AppMainModule, AppResourceParticipant } from '../../../../plugins/sdk/app-plugin-sdk/main';
import { appNativeGatewayMethodAlias, type AppNativeHandshake } from '../../../../plugins/sdk/app-plugin-sdk/native-contract';
import { EnginePhase, type OpenClawEngineStatus } from '../../../shared/openclaw/engineStatus';
import { PluginOperationStage } from '../../../shared/plugins/pluginOperation';
import { t } from '../../core/i18n';
import { EnginePreparationPendingCode, EnginePreparationPendingError } from '../../engine/enginePreparationError';
import { bindPluginGatewayClient } from '../../engine/gateway/pluginRequestBinding';
import { removeExtensionPackage } from '../extensions/extensionMutation';
import { type ApplyExtensionPackageMutation, ExtensionPackageLifecycleMode } from '../extensions/extensionPackageLifecycle';
import { artifactDigest } from './artifact';
import { readAppAsset } from './assets';
import { type AppCandidate, AppPluginManager } from './manager';
import type { AppHostResources } from './registry';
import { ensureAppPluginRuntimeReady } from './runtimeReadiness';

const id = 'lifecycle-fixture';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const disposers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });

async function fixture(options: {
  beforePackageMutation?(): Promise<void> | void;
  resources?: AppResourceParticipant;
  ensureReady?(): Promise<void>;
  stopGateway?(): Promise<void>;
  cleanupOnly?: boolean;
  data?: AppPluginManifest['data'];
  initiallyOffline?: boolean;
  initiallyDisconnected?: boolean;
  unknownGatewayProcess?: boolean;
  prepareState?(state: string): Promise<void>;
  notifyMetadataOnRead?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'app-manager-lifecycle-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, 'state');
  await mkdir(stateDirectory);
  await options.prepareState?.(stateDirectory);
  async function version(value: string, data = options.data) {
    const nativeRoot = path.join(root, value);
    const appRoot = path.join(nativeRoot, 'app');
    await mkdir(appRoot, { recursive: true });
    const native = `export default {}; // ${value}`;
    await writeFile(path.join(nativeRoot, 'index.js'), native);
    const manifest: AppPluginManifest = {
      manifestVersion: 1, apiVersion: 1, id, nativePluginId: id, version: value,
      entries: { main: 'main.mjs', browser: 'browser.mjs', presentation: 'presentation.mjs' }, capabilities: [],
      commands: ['read', 'native'], slots: [],
      ...(data ? { data } : {}),
    };
    const content = {
      'main.mjs': `export function register(){return {commands:[{id:'read',invoke:()=>({success:true,value:${JSON.stringify(value)}})}]};}`,
      'browser.mjs': 'export function register(){}',
      'presentation.mjs': 'export const presentation={text:source=>source};',
      'native.binding.json': JSON.stringify({ entry: 'index.js', profile: 'single-file-v1', sha256: sha(native) }),
    };
    const files = Object.fromEntries(Object.entries(content).map(([name, text]) => [name, sha(text)]));
    for (const [name, text] of Object.entries(content)) await writeFile(path.join(appRoot, name), text);
    await writeFile(path.join(appRoot, 'app.artifact.json'), JSON.stringify({ manifest, files, hash: artifactDigest(manifest, files) }));
    return { candidate: { root: appRoot, nativeRoot, trusted: true } as AppCandidate,
      receipt: { pluginId: id, registrationId: randomUUID(), processId: 100, gatewayMethods: [],
        nativeEntry: path.join(nativeRoot, 'index.js'), sourceSha256: sha(native) } as AppNativeHandshake };
  }
  let current = await version('1.0.0');
  if (options.cleanupOnly) current.candidate.cleanupOnly = true;
  let candidates = [current.candidate];
  let enabled = true;
  let connected = !options.initiallyOffline && !options.initiallyDisconnected;
  let processId: number | null = options.initiallyOffline ? null : 100;
  let generation = 1;
  let resumes = 0;
  let stops = 0;
  let stopConfirmed = true;
  let pendingRead: Promise<void> | undefined;
  let catalogFailure = false;
  let nativeReady = true;
  const nativeRequests: { method: string; params: unknown }[] = [];
  const client = bindPluginGatewayClient({
    start() {}, stop() {},
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      nativeRequests.push({ method, params });
      return { success: true } as T;
    },
  });
  const manager = new AppPluginManager({
    retentionRoot: path.join(root, 'retained'),
    resources: {
      getNativeStateDirectory: () => stateDirectory,
      requestGateway: (method: string, params?: unknown) => client.request(method, params),
      requestConnectedGateway: async () => {
        if (!nativeReady) throw new Error('configuration is still settling');
        const receipt = { ...current.receipt }; await pendingRead; return receipt;
      },
      ensureReady: async () => {
        resumes++; processId = (processId ?? 100) + 1; generation++; connected = true;
        current.receipt = { ...current.receipt, processId, registrationId: randomUUID() };
        await options.ensureReady?.();
      },
    } as unknown as AppHostResources,
    readDesiredEnabled: () => enabled,
    candidates: async () => {
      if (catalogFailure) throw new Error('temporary catalog failure');
      return candidates;
    },
    broadcast: () => {}, isGatewayConnected: () => connected,
    getGatewayProcessId: options.unknownGatewayProcess ? undefined : () => processId,
    getGatewayProcessGeneration: () => generation,
    loadModule: async url => {
      const source = await readFile(new URL(url), 'utf8');
      // Execute this test's fixed, import-free fixture; real ESM loading is covered
      // by the built artifact and Gateway probes outside Vitest's VM importer.
      const module = new Function(`${source.replace('export function', 'function')};return {register};`)() as AppMainModule;
      return {
        register: host => {
          const registration = module.register(host);
          return {
            ...registration,
            commands: [...registration.commands.map(command => options.notifyMetadataOnRead && command.id === 'read'
              ? { ...command, invoke: (...args: unknown[]) => {
                  host.executionSessionsChanged();
                  return command.invoke(...args);
                } }
              : command), {
              id: 'native', invoke: () => host.requestGateway('lifecycle.start', {}),
            }],
            beforePackageMutation: options.beforePackageMutation,
            resources: options.resources,
          };
        },
      };
    },
    withStoppedGateway: async operation => {
      stops++; if (!stopConfirmed) throw new Error('stop unconfirmed');
      await options.stopGateway?.();
      connected = false; return operation();
    },
  });
  disposers.push(() => manager.dispose());
  await manager.prepare(); await manager.activate(); await manager.refresh();
  const read = (epoch = manager.snapshot()[0].epoch) => manager.invoke({ id, command: 'read', epoch, args: [] });
  return { manager, read, version, root, stateDirectory,
    native: (epoch = manager.snapshot()[0].epoch) => manager.invoke({ id, command: 'native', epoch, args: [] }),
    nativeRequests,
    receipt: () => current.receipt,
    setGatewayMethods: (value: unknown) => {
      current.receipt = { ...current.receipt, gatewayMethods: value as AppNativeHandshake['gatewayMethods'] };
    },
    replace: (next: typeof current) => { current = next; candidates = [next.candidate]; },
    setCandidates: (next: AppCandidate[]) => { candidates = next; },
    enabled: (value: boolean) => { enabled = value; },
    wrongProcess: () => { current.receipt.processId++; },
    delayRead: (task: Promise<void> | undefined) => { pendingRead = task; },
    supersede: () => { generation++; },
    uncertainStop: () => { stopConfirmed = false; },
    disconnect: () => { connected = false; },
    offline: () => { connected = false; processId = null; },
    failCatalog: (value: boolean) => { catalogFailure = value; },
    nativeReady: (value: boolean) => { nativeReady = value; },
    counts: () => ({ resumes, stops }),
  };
}

test('prepares managed data and migrates a declared legacy directory before the first Gateway exists', async () => {
  const f = await fixture({ initiallyOffline: true,
    data: { directory: 'managed-v1', migrateLegacyDirectory: { requiredFiles: ['selection.json'] } },
    prepareState: async state => {
      await mkdir(path.join(state, id));
      await writeFile(path.join(state, id, 'selection.json'), '{}');
    },
  });
  expect(f.manager.snapshot()).toHaveLength(1);
  expect(resolvePluginDataDirectory(f.stateDirectory, id)).toBe(path.join(f.stateDirectory, 'plugin-data', id));
  expect(existsSync(path.join(f.stateDirectory, id))).toBe(false);
});

test.each(['disconnected-alive', 'unknown-process'] as const)(
  'does not create or migrate data when Gateway stop is not established: %s', async mode => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const f = await fixture({ initiallyOffline: mode === 'unknown-process', initiallyDisconnected: true,
        unknownGatewayProcess: mode === 'unknown-process',
        data: { directory: 'managed-v1', migrateLegacyDirectory: { requiredFiles: ['selection.json'] } },
        prepareState: async state => {
          await mkdir(path.join(state, id));
          await writeFile(path.join(state, id, 'selection.json'), '{}');
        },
      });
      expect(f.manager.snapshot()).toEqual([]);
      expect(existsSync(path.join(f.stateDirectory, id, 'selection.json'))).toBe(true);
      expect(existsSync(path.join(f.stateDirectory, 'plugin-data'))).toBe(false);
      expect(warn).toHaveBeenCalledWith('[AppPlugins] Plugin data preparation failed', id, expect.any(String));
    } finally { warn.mockRestore(); }
  },
);

test('prepares new managed data under the stopped replacement lease', async () => {
  const f = await fixture();
  await mkdir(path.join(f.stateDirectory, id));
  await writeFile(path.join(f.stateDirectory, id, 'selection.json'), '{}');
  const next = await f.version('2.0.0', { directory: 'managed-v1',
    migrateLegacyDirectory: { requiredFiles: ['selection.json'] } });
  expect(existsSync(path.join(f.stateDirectory, 'plugin-data'))).toBe(false);
  await f.manager.mutatePackage(async () => { f.replace(next); });
  expect(resolvePluginDataDirectory(f.stateDirectory, id)).toBe(path.join(f.stateDirectory, 'plugin-data', id));
  expect(existsSync(path.join(f.stateDirectory, id))).toBe(false);
  expect(f.manager.snapshot()[0].version).toBe('2.0.0');
});

test('does not withdraw execution sources for unchanged refreshes or ordinary read commands', async () => {
  const f = await fixture();
  const initial = f.manager.snapshot();
  const changed = vi.fn();
  const release = f.manager.onExecutionSessionsChanged(changed);
  try {
    await f.manager.refresh();
    await f.manager.refresh();
    expect(await f.read()).toEqual({ success: true, value: '1.0.0' });
    expect(f.manager.snapshot()).toEqual(initial);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    release();
  }
});

test('preserves explicit metadata notifications while deduplicating the unchanged lifecycle publication around a read', async () => {
  const f = await fixture({ notifyMetadataOnRead: true });
  const changed = vi.fn();
  const release = f.manager.onExecutionSessionsChanged(changed);
  try {
    await f.read();
    await f.read();
    expect(changed.mock.calls).toEqual([[true], [true]]);
  } finally {
    release();
  }
});

test('still withdraws sources when an actual enable state or Native binding changes', async () => {
  const f = await fixture();
  const changed = vi.fn();
  const release = f.manager.onExecutionSessionsChanged(changed);
  try {
    f.enabled(false);
    await f.manager.refresh();
    expect(f.manager.snapshot()[0].state).toBe('cleanup');
    expect(changed).toHaveBeenCalledWith(false);
    changed.mockClear();
    f.enabled(true);
    await f.manager.refresh();
    expect(f.manager.snapshot()[0].state).toBe('active');
    expect(changed).toHaveBeenCalledWith(false);
    changed.mockClear();
    f.receipt().registrationId = randomUUID();
    const previousEpoch = f.manager.snapshot()[0].epoch;
    await f.manager.refresh();
    expect(f.manager.snapshot()[0].epoch).not.toBe(previousEpoch);
    expect(changed).toHaveBeenCalledWith(false);
    changed.mockClear();
    await f.manager.refresh();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    release();
  }
});

test('records the source signature before notifying so a same-state listener refresh cannot recurse', async () => {
  const f = await fixture();
  let depth = 0;
  let maximumDepth = 0;
  const release = f.manager.onExecutionSessionsChanged(() => {
    depth++;
    maximumDepth = Math.max(maximumDepth, depth);
    try {
      if (depth < 4) f.manager.registry.refresh();
    } finally {
      depth--;
    }
  });
  try {
    f.enabled(false);
    await f.manager.refresh();
    expect(maximumDepth).toBe(1);
    expect(f.manager.snapshot()[0].state).toBe('cleanup');
  } finally {
    release();
  }
});

test('adopts a replacement Main/UI artifact after Gateway stop without restarting the application', async () => {
  const f = await fixture(); const old = f.manager.snapshot()[0];
  expect(await f.read()).toEqual({ success: true, value: '1.0.0' });
  const next = await f.version('2.0.0');
  await f.manager.mutatePackage(async () => {
    expect(f.manager.snapshot().every(item => item.state !== 'active')).toBe(true);
    f.replace(next);
  });
  expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
  expect(f.manager.snapshot()[0]).toMatchObject({ state: 'active', version: '2.0.0' });
  expect(f.manager.snapshot()[0].restartRequired).not.toBe(true);
  expect(await f.read()).toEqual({ success: true, value: '2.0.0' });
  expect(await f.read(old.epoch)).toMatchObject({ success: false });
});

test('ordinary package changes keep the Gateway, App epoch and assets active', async () => {
  const f = await fixture();
  const original = f.manager.snapshot()[0];
  const write = vi.fn(async mode => {
    expect(mode).toBe(ExtensionPackageLifecycleMode.HOT);
    expect(f.manager.snapshot()[0]).toEqual(original);
    expect(await f.read()).toEqual({ success: true, value: '1.0.0' });
    return 'installed';
  });

  const result = await f.manager.withExtensionPackageMutation(apply => apply({
    nativePluginIds: ['ordinary-package', 'ordinary-package/child'],
    installPath: path.join(f.root, 'ordinary'),
  }, write));

  expect(result).toBe('installed');
  expect(write).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ stops: 0, resumes: 0 });
  expect(f.manager.snapshot()[0]).toEqual(original);
  expect(await readAppAsset(original.presentationEntry!.slice(1))).not.toBeNull();
});

test('a disconnected but still owned Gateway is left for hot admission to reject before send', async () => {
  const f = await fixture();
  f.disconnect();
  const write = vi.fn(async mode => {
    expect(mode).toBe(ExtensionPackageLifecycleMode.HOT);
    throw new Error('connected native client is unavailable before send');
  });

  await expect(f.manager.withExtensionPackageMutation(apply => apply({
    nativePluginIds: ['ordinary-package'],
  }, write))).rejects.toThrow('before send');

  expect(f.counts()).toEqual({ stops: 0, resumes: 0 });
  expect(write).toHaveBeenCalledOnce();
});

test('offline ordinary package changes retain the startup fence without starting Gateway', async () => {
  const f = await fixture();
  f.offline();
  const write = vi.fn(async mode => mode);

  const mode = await f.manager.withExtensionPackageMutation(apply => apply({
    nativePluginIds: ['ordinary-package'],
  }, write));

  expect(mode).toBe(ExtensionPackageLifecycleMode.STOPPED);
  expect(f.counts()).toEqual({ stops: 1, resumes: 0 });
});

test.each(['malformed', 'directory', 'broken symlink'] as const)(
  'incoming %s App artifact markers use stopped reconciliation', async kind => {
    const f = await fixture();
    const sourceDirectory = path.join(f.root, 'incoming');
    const appRoot = path.join(sourceDirectory, 'app');
    await mkdir(appRoot, { recursive: true });
    const marker = path.join(appRoot, 'app.artifact.json');
    if (kind === 'malformed') await writeFile(marker, '{');
    else if (kind === 'directory') await mkdir(marker);
    else await symlink(path.join(f.root, 'missing-marker'), marker,
      process.platform === 'win32' ? 'junction' : 'file');

    const mode = await f.manager.withExtensionPackageMutation(apply => apply({
      nativePluginIds: ['new-app-package'], sourceDirectory,
    }, async mode => mode));

    expect(mode).toBe(ExtensionPackageLifecycleMode.STOPPED);
    expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
  },
);

test.each(['file', 'directory'] as const)('an ordinary app resource %s does not require a restart', async kind => {
  const f = await fixture();
  const sourceDirectory = path.join(f.root, 'ordinary');
  await mkdir(sourceDirectory);
  const appRoot = path.join(sourceDirectory, 'app');
  if (kind === 'file') await writeFile(appRoot, 'ordinary resource');
  else {
    await mkdir(appRoot);
    await writeFile(path.join(appRoot, 'index.html'), '<p>ordinary resource</p>');
  }

  const mode = await f.manager.withExtensionPackageMutation(apply => apply({
    nativePluginIds: ['ordinary-package'], sourceDirectory,
  }, async mode => mode));

  expect(mode).toBe(ExtensionPackageLifecycleMode.HOT);
  expect(f.counts()).toEqual({ stops: 0, resumes: 0 });
});

test('plain package replacement still cleans the selected App owner when its marker is missing', async () => {
  const f = await fixture();
  const nativeRoot = path.join(f.root, '1.0.0');
  await rm(path.join(nativeRoot, 'app'), { recursive: true });

  const mode = await f.manager.withExtensionPackageMutation(apply => apply({
    nativePluginIds: ['replacement-child'], installPath: nativeRoot,
  }, async mode => {
    f.setCandidates([]);
    return mode;
  }));

  expect(mode).toBe(ExtensionPackageLifecycleMode.STOPPED);
  expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
  expect(f.manager.snapshot()).toEqual([]);
});

test('a selected cleanup-only App owner still requires stopped package mutation', async () => {
  const f = await fixture({ cleanupOnly: true });
  expect(f.manager.isAppCompanion(id)).toBe(false);

  const mode = await f.manager.withExtensionPackageMutation(apply => apply({
    nativePluginIds: [id],
  }, async mode => mode));

  expect(mode).toBe(ExtensionPackageLifecycleMode.STOPPED);
  expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
});

test('an ordinary plugin data removal requires the stopped package lifecycle', async () => {
  const f = await fixture();
  const mode = await f.manager.withExtensionPackageMutation(apply => apply({
    nativePluginIds: ['ordinary-package'], requireStopped: true,
  }, async mode => mode));

  expect(mode).toBe(ExtensionPackageLifecycleMode.STOPPED);
  expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
});

test.each(['unapproved', 'bundled', 'retained'] as const)(
  '%s App identities survive missing package markers in routing', async kind => {
    const f = await fixture();
    const hash = 'a'.repeat(64);
    f.setCandidates([{
      root: path.join(f.root, 'missing-app'), nativeRoot: path.join(f.root, 'missing-native'),
      nativePluginId: 'historical-app', trusted: false,
      identity: { id: 'historical-app', hash },
      ...(kind === 'bundled' ? { bundled: true } : {}),
      ...(kind === 'retained' ? { cleanupOnly: true, retainedReceipt: { id: 'historical-app', hash } } : {}),
    }]);

    const mode = await f.manager.withExtensionPackageMutation(apply => apply({
      nativePluginIds: ['package-child', 'historical-app'],
    }, async mode => mode));

    expect(mode).toBe(ExtensionPackageLifecycleMode.STOPPED);
    expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
  },
);

test('unreadable App inventory rejects ordinary admission before stopping or writing', async () => {
  const f = await fixture();
  f.failCatalog(true);
  const write = vi.fn(async () => 'installed');

  await expect(f.manager.withExtensionPackageMutation(apply => apply({
    nativePluginIds: ['ordinary-package'],
  }, write))).rejects.toThrow('temporary catalog failure');

  expect(write).not.toHaveBeenCalled();
  expect(f.counts()).toEqual({ stops: 0, resumes: 0 });
});

test('package reservations reject reused and stale apply callbacks without borrowing a later owner', async () => {
  const f = await fixture();
  const target = { nativePluginIds: ['ordinary-package'] };
  const write = vi.fn(async () => 'installed');
  let stale!: ApplyExtensionPackageMutation;
  await f.manager.withExtensionPackageMutation(async apply => {
    stale = apply;
    expect(await apply(target, write)).toBe('installed');
    await expect(apply(target, write)).rejects.toThrow(t('extensionInstallMutationUnavailable'));
  });

  await f.manager.withExtensionPackageMutation(async apply => {
    await expect(stale(target, write)).rejects.toThrow(t('extensionInstallMutationUnavailable'));
    expect(await apply(target, write)).toBe('installed');
  });

  expect(write).toHaveBeenCalledTimes(2);
  expect(f.counts()).toEqual({ stops: 0, resumes: 0 });
});

test('an invalid package target cannot enter Native mutation or cold lifecycle', async () => {
  const f = await fixture();
  const write = vi.fn(async () => 'installed');

  await expect(f.manager.withExtensionPackageMutation(apply => apply({
    nativePluginIds: [],
  }, write))).rejects.toThrow('appPluginInvalidRequest');

  expect(write).not.toHaveBeenCalled();
  expect(f.counts()).toEqual({ stops: 0, resumes: 0 });
});

test('the outer package reservation orders toggles and fences deletion throughout preparation', async () => {
  const f = await fixture();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const order: string[] = [];
  const installing = f.manager.withExtensionPackageMutation(async apply => {
    order.push('prepare'); started(); await gate;
    return apply({ nativePluginIds: ['ordinary-package'] }, async () => { order.push('write'); });
  });
  await entered;
  const toggling = f.manager.mutate('ordinary-package', false, async () => { order.push('toggle'); });
  try {
    expect(() => f.manager.sessions.acquireDeletion(['ordinary-session']))
      .toThrow('appPluginCleanupUnresolved');
    expect(order).toEqual(['prepare']);
  } finally {
    finish();
    await installing;
    await toggling;
  }

  expect(order).toEqual(['prepare', 'write', 'toggle']);
  const release = f.manager.sessions.acquireDeletion(['ordinary-session']);
  release();
});

test('preserves a completed removal and its actual returned preparation failure before refreshing the host catalog', async () => {
  const reason = 'Network generation preparation failed: the local certificate store is unavailable';
  const prepare = vi.fn(async (): Promise<OpenClawEngineStatus> => ({
    phase: EnginePhase.Error, version: 'fixture', canRetry: true, message: reason,
  }));
  const f = await fixture({ ensureReady: async () => {
    await ensureAppPluginRuntimeReady(prepare);
  } });
  const refresh = vi.spyOn(f.manager, 'refresh');
  const operation = vi.fn(async () => ({ success: true }));

  const result = await removeExtensionPackage(operation, callback => f.manager.mutatePackage(callback));

  expect(result).toMatchObject({
    success: true,
    refreshWarning: true,
    failedStage: PluginOperationStage.PREPARING_RUNTIME,
    error: expect.stringContaining(reason),
  });
  expect(operation).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
  expect(refresh).not.toHaveBeenCalled();
  refresh.mockRestore();
});

test('rejects package replacement while the original deletion owner is awaiting preparation', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const remove = vi.fn(async () => true);
  const f = await fixture({ resources: {
    expandResources: ids => [...ids],
    acquireDeletion: () => () => undefined,
    isDeleting: () => false,
    isManaged: () => true,
    prepareDelete: async () => { entered(); await pending; },
    deleteManaged: remove,
  } });
  const next = await f.version('2.0.0');
  const replace = vi.fn(async () => { f.replace(next); });
  const release = f.manager.sessions.acquireDeletion(['source']);
  const deleting = f.manager.sessions.deleteManaged('source');
  await started;
  try {
    await expect(f.manager.mutatePackage(replace)).rejects.toThrow('appPluginCleanupUnresolved');
    expect(replace).not.toHaveBeenCalled();
    expect(f.counts()).toEqual({ stops: 0, resumes: 0 });
    expect(f.manager.snapshot()[0]).toMatchObject({ state: 'active', version: '1.0.0' });
  } finally {
    finish();
    try { await deleting; } finally { release(); }
  }
  expect(remove).toHaveBeenCalledExactlyOnceWith('source');
  await f.manager.mutatePackage(replace);
  expect(replace).toHaveBeenCalledOnce();
  expect(f.manager.snapshot()[0]).toMatchObject({ state: 'active', version: '2.0.0' });
});

test.each(['preflight', 'stop', 'mutation', 'reconnect'] as const)(
  'fences new deletion throughout package %s and releases it after reconnection',
  async phase => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pause = async () => { entered(); await pending; };
    const f = await fixture({
      beforePackageMutation: phase === 'preflight' ? pause : undefined,
      stopGateway: phase === 'stop' ? pause : undefined,
      ensureReady: phase === 'reconnect' ? pause : undefined,
    });
    const operation = vi.fn(async () => { if (phase === 'mutation') await pause(); });
    const mutation = f.manager.mutatePackage(operation);
    await started;
    try {
      expect(() => f.manager.sessions.acquireDeletion(['source']))
        .toThrow('appPluginCleanupUnresolved');
    } finally {
      finish();
      await mutation;
    }
    const release = f.manager.sessions.acquireDeletion(['source']);
    release();
    expect(operation).toHaveBeenCalledOnce();
    expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
  },
);

test.each(['preflight', 'stop', 'mutation', 'reconnect'] as const)(
  'releases the deletion exclusion after package %s fails',
  async phase => {
    const fail = async () => { throw new Error('package phase failed'); };
    const f = await fixture({
      beforePackageMutation: phase === 'preflight' ? fail : undefined,
      stopGateway: phase === 'stop' ? fail : undefined,
      ensureReady: phase === 'reconnect' ? fail : undefined,
    });
    const display = f.manager.snapshot()[0].presentationEntry!;
    await expect(f.manager.mutatePackage(phase === 'mutation' ? fail : async () => undefined))
      .rejects.toThrow('package phase failed');
    expect(f.manager.snapshot()[0].presentationEntry).toBe(display);
    expect(await readAppAsset(display.slice(1))).not.toBeNull();
    const next = vi.fn(async () => undefined);
    await f.manager.sessions.withPackageMutation(next);
    expect(next).toHaveBeenCalledOnce();
  },
);

test('disable withdraws UI admission before waiting for Native mutation; enable admits a fresh epoch', async () => {
  const f = await fixture(); const oldEpoch = f.manager.snapshot()[0].epoch;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const disabling = f.manager.mutate(id, false, async () => { entered(); await gate; f.enabled(false); });
  await started;
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
  expect(await f.read(oldEpoch)).toMatchObject({ success: false });
  release(); await disabling;
  await f.manager.mutate(id, true, async () => { f.enabled(true); });
  expect(f.manager.snapshot()[0].state).toBe('active');
  expect(await f.read(oldEpoch)).toMatchObject({ success: false });
});

test('disabled and disconnected installed display leases survive epochs but replacement revokes old assets', async () => {
  const f = await fixture();
  const original = f.manager.snapshot()[0];
  expect(original.installed).toBe(true);
  const route = original.presentationEntry!.slice(1);
  expect(await readAppAsset(route)).not.toBeNull();
  await f.manager.mutate(id, false, async () => {
    f.enabled(false);
  });
  expect(f.manager.snapshot()[0].presentationEntry).toBe(original.presentationEntry);
  expect(f.manager.snapshot()[0].browserEntry).toBeUndefined();
  f.disconnect();
  await f.manager.refresh();
  expect(await readAppAsset(route)).not.toBeNull();
  const next = await f.version('2.0.0');
  await f.manager.mutatePackage(async () => {
    f.replace(next);
  });
  expect(f.manager.snapshot()[0].presentationEntry).not.toBe(original.presentationEntry);
  expect(await readAppAsset(route)).toBeNull();
  expect(await readAppAsset(f.manager.snapshot()[0].presentationEntry!.slice(1))).not.toBeNull();
});

test('rejects foreign process receipts and a handshake crossing Gateway generation change', async () => {
  const f = await fixture(); f.wrongProcess(); await f.manager.refresh();
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
  let release!: () => void;
  f.delayRead(new Promise<void>(resolve => { release = resolve; }));
  const reading = f.manager.refresh(); await Promise.resolve(); await Promise.resolve();
  f.supersede(); release(); await reading;
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
});

test('never repeats an unknown package mutation and reconciles its committed artifact', async () => {
  const f = await fixture(); const next = await f.version('2.0.0'); let effects = 0;
  await expect(f.manager.mutatePackage(async () => {
    effects++; f.replace(next); throw new Error('unknown native outcome');
  })).rejects.toThrow('unknown native outcome');
  expect(effects).toBe(1); expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
  expect(await f.read()).toEqual({ success: true, value: '2.0.0' });
});

test('unconfirmed Gateway stop cannot touch package bytes or resume a replacement', async () => {
  const f = await fixture(); f.uncertainStop(); let effects = 0;
  await expect(f.manager.mutatePackage(async () => { effects++; })).rejects.toThrow('stop unconfirmed');
  expect(effects).toBe(0); expect(f.counts()).toEqual({ stops: 1, resumes: 0 });
});

test('resumes an owned Gateway after package mutation even if its client was disconnected', async () => {
  const f = await fixture(); f.disconnect();
  await f.manager.mutatePackage(async () => {});
  expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
  expect(f.manager.snapshot()[0].state).toBe('active');
});

test('repairs transient inventory failure in the same application without replaying the mutation', async () => {
  const f = await fixture(); let firstEffects = 0;
  const display = f.manager.snapshot()[0].presentationEntry!;
  await expect(f.manager.mutatePackage(async () => {
    firstEffects++; f.failCatalog(true);
  })).rejects.toThrow('temporary catalog failure');
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
  expect(f.manager.snapshot()[0].installed).toBe(true);
  expect(f.manager.snapshot()[0].presentationEntry).toBeUndefined();
  expect(await readAppAsset(display.slice(1))).toBeNull();
  f.failCatalog(false); let nextEffects = 0;
  await f.manager.mutatePackage(async () => { nextEffects++; });
  expect(firstEffects).toBe(1); expect(nextEffects).toBe(1);
  expect(f.manager.snapshot()[0].state).toBe('active');
  expect(f.manager.snapshot()[0].presentationEntry).toBe(display);
  expect(await readAppAsset(display.slice(1))).not.toBeNull();
});

test('repairs pending App inventory before a routed ordinary mutation without a second restart', async () => {
  const f = await fixture();
  const firstWrite = vi.fn(async () => { f.failCatalog(true); });
  await expect(f.manager.mutatePackage(firstWrite)).rejects.toThrow('temporary catalog failure');
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
  f.failCatalog(false);
  const nextWrite = vi.fn(async mode => {
    expect(mode).toBe(ExtensionPackageLifecycleMode.HOT);
    expect(f.manager.snapshot()[0].state).toBe('active');
    return 'installed';
  });

  await expect(f.manager.withExtensionPackageMutation(apply => apply({
    nativePluginIds: ['ordinary-package'],
  }, nextWrite))).resolves.toBe('installed');

  expect(firstWrite).toHaveBeenCalledOnce();
  expect(nextWrite).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ stops: 2, resumes: 2 });
  expect(await f.read()).toEqual({ success: true, value: '1.0.0' });
});

test('retains a package reconciliation error when engine recovery is also pending after native removal', async () => {
  const f = await fixture({ ensureReady: async () => {
    throw new EnginePreparationPendingError(EnginePreparationPendingCode.LIFECYCLE_CHANGED, 'Retired engine verification');
  } });
  const operation = vi.fn(async () => {
    f.failCatalog(true);
    return { success: true };
  });

  const result = await removeExtensionPackage(operation, callback => f.manager.mutatePackage(callback));

  expect(result).toMatchObject({
    success: true, refreshWarning: true, mutationCompleted: true,
    error: expect.stringContaining('temporary catalog failure'),
  });
  expect(result.error).toContain('Retired engine verification');
  expect(result).not.toHaveProperty('runtimeRecoveryPending');
  expect(operation).toHaveBeenCalledOnce();
  expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
  expect(f.manager.snapshot()[0].presentationEntry).toBeUndefined();
});

test('checks Native quiescence before stopping Gateway to repair package admission', async () => {
  let busy = false;
  const f = await fixture({
    beforePackageMutation: async () => {
      if (busy) throw new Error('Native batch is still active');
    },
  });
  let firstEffects = 0;
  await expect(f.manager.mutatePackage(async () => {
    firstEffects++; f.failCatalog(true);
  })).rejects.toThrow('temporary catalog failure');
  f.failCatalog(false); busy = true;
  let repairEffects = 0;
  await expect(f.manager.mutatePackage(async () => { repairEffects++; }))
    .rejects.toThrow('Native batch is still active');
  expect(firstEffects).toBe(1); expect(repairEffects).toBe(0);
  expect(f.counts()).toEqual({ stops: 1, resumes: 1 });
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
});

test('does not resume after an unconfirmed Gateway stop during package admission repair', async () => {
  const f = await fixture(); let firstEffects = 0;
  await expect(f.manager.mutatePackage(async () => {
    firstEffects++; f.failCatalog(true);
  })).rejects.toThrow('temporary catalog failure');
  f.failCatalog(false); f.uncertainStop();
  let repairEffects = 0;
  await expect(f.manager.mutatePackage(async () => { repairEffects++; }))
    .rejects.toThrow('stop unconfirmed');
  expect(firstEffects).toBe(1); expect(repairEffects).toBe(0);
  expect(f.counts()).toEqual({ stops: 2, resumes: 1 });
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
});

test('read-only handshake recovery publishes UI after Gateway configuration settles', async () => {
  const f = await fixture(); f.nativeReady(false);
  await f.manager.refresh();
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
  f.nativeReady(true);
  await vi.waitFor(() => expect(f.manager.snapshot()[0].state).toBe('active'));
});

test('retains the exact validated alias mapping and retires a changed handshake epoch', async () => {
  const f = await fixture();
  const alias = appNativeGatewayMethodAlias(f.receipt(), 0);
  const methods = [{ method: 'lifecycle.start', alias }];
  f.setGatewayMethods(methods);
  const oldEpoch = f.manager.snapshot()[0].epoch;
  await f.manager.refresh();
  expect(f.manager.snapshot()[0].epoch).not.toBe(oldEpoch);
  expect(await f.native(oldEpoch)).toMatchObject({ success: false });
  expect(f.nativeRequests).toHaveLength(0);
  methods[0].alias = 'foreign.alias';
  expect(await f.manager.registry.invoke({
    id, command: 'native', epoch: f.manager.snapshot()[0].epoch, args: [],
  })).toEqual({ success: true });
  expect(f.nativeRequests).toEqual([{ method: alias, params: {} }]);
  await f.manager.refresh();
  expect(f.manager.snapshot()[0].state).toBe('cleanup');
  expect(await f.native()).toMatchObject({ success: false });
  expect(f.nativeRequests).toHaveLength(1);
});

test.each([undefined, [{ method: 'lifecycle.start', alias: 'foreign.alias' }]])(
  'rejects an incomplete or forged Native mapping without a Core fallback: %j', async methods => {
    const f = await fixture();
    f.setGatewayMethods(methods);
    await f.manager.refresh();
    expect(f.manager.snapshot()[0].state).toBe('cleanup');
    expect(await f.native()).toMatchObject({ success: false });
    expect(f.nativeRequests).toHaveLength(0);
  },
);
