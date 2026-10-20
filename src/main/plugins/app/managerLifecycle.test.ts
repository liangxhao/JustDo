import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { AppPluginManifest } from '../../../../packages/app-plugin-sdk/contracts';
import type { AppMainModule, AppResourceParticipant } from '../../../../packages/app-plugin-sdk/main';
import { appNativeGatewayMethodAlias, type AppNativeHandshake } from '../../../../packages/app-plugin-sdk/native-contract';
import { bindPluginGatewayClient } from '../../engine/gateway/pluginRequestBinding';
import { artifactDigest } from './artifact';
import { readAppAsset } from './assets';
import { type AppCandidate, AppPluginManager } from './manager';
import type { AppHostResources } from './registry';

const id = 'lifecycle-fixture';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const disposers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });

async function fixture(options: {
  beforePackageMutation?(): Promise<void> | void;
  resources?: AppResourceParticipant;
  ensureReady?(): Promise<void>;
  stopGateway?(): Promise<void>;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'app-manager-lifecycle-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  async function version(value: string) {
    const nativeRoot = path.join(root, value);
    const appRoot = path.join(nativeRoot, 'app');
    await mkdir(appRoot, { recursive: true });
    const native = `export default {}; // ${value}`;
    await writeFile(path.join(nativeRoot, 'index.js'), native);
    const manifest: AppPluginManifest = {
      manifestVersion: 1, apiVersion: 1, id, nativePluginId: id, version: value,
      entries: { main: 'main.mjs', browser: 'browser.mjs', presentation: 'presentation.mjs' }, capabilities: [],
      commands: ['read', 'native'], slots: [],
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
  let candidates = [current.candidate];
  let enabled = true;
  let connected = true;
  let processId = 100;
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
      requestGateway: (method: string, params?: unknown) => client.request(method, params),
      requestConnectedGateway: async () => {
        if (!nativeReady) throw new Error('configuration is still settling');
        const receipt = { ...current.receipt }; await pendingRead; return receipt;
      },
      ensureReady: async () => {
        resumes++; processId++; generation++; connected = true;
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
    getGatewayProcessId: () => processId, getGatewayProcessGeneration: () => generation,
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
            commands: [...registration.commands, {
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
  return { manager, read, version,
    native: (epoch = manager.snapshot()[0].epoch) => manager.invoke({ id, command: 'native', epoch, args: [] }),
    nativeRequests,
    receipt: () => current.receipt,
    setGatewayMethods: (value: unknown) => {
      current.receipt = { ...current.receipt, gatewayMethods: value as AppNativeHandshake['gatewayMethods'] };
    },
    replace: (next: typeof current) => { current = next; candidates = [next.candidate]; },
    enabled: (value: boolean) => { enabled = value; },
    wrongProcess: () => { current.receipt.processId++; },
    delayRead: (task: Promise<void> | undefined) => { pendingRead = task; },
    supersede: () => { generation++; },
    uncertainStop: () => { stopConfirmed = false; },
    disconnect: () => { connected = false; },
    failCatalog: (value: boolean) => { catalogFailure = value; },
    nativeReady: (value: boolean) => { nativeReady = value; },
    counts: () => ({ resumes, stops }),
  };
}

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
