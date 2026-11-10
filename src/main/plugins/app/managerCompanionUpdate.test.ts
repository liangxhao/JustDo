import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { AppPluginManifest } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import type { AppMainModule } from '../../../../plugins/sdk/app-plugin-sdk/main';
import { type AppNativeHandshake, appNativeHandshakeMethod } from '../../../../plugins/sdk/app-plugin-sdk/native-contract';
import { bindPluginGatewayClient } from '../../engine/gateway/pluginRequestBinding';
import { ExtensionPackageLifecycleMode } from '../extensions/extensionPackageLifecycle';
import { AppApprovalStore } from './approvalStore';
import { artifactDigest } from './artifact';
import { readAppAsset } from './assets';
import { AppPluginManager, discoverAppCandidates } from './manager';
import type { AppHostResources } from './registry';

const targetId = 'companion-update-fixture';
const peerId = 'companion-update-peer';
const nativeSource = 'export default {};';
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const disposers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });

async function fixture(options: { cleanupNativeQuery?: boolean; disabled?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'app-companion-update-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const bundled = path.join(root, 'bundled');
  const state = path.join(root, 'state');
  await mkdir(bundled);
  await mkdir(state);
  await writeFile(path.join(bundled, 'catalog.json'), '[]');
  const store = new AppApprovalStore(path.join(root, 'approvals.json'));
  const installed = [targetId, peerId].map(id => ({ id, installPath: path.join(root, 'installed', id) }));
  const receipts = new Map<string, AppNativeHandshake>();
  const loadedModules: string[] = [];
  const enabled = new Map([[targetId, !options.disabled], [peerId, true]]);
  const enabledBindings: { admitted: unknown; registered: string | undefined }[] = [];
  const cleanupCalls: { method: string; owner: string; hook: string; registered: string | undefined }[] = [];
  const nativeClient = bindPluginGatewayClient({ start() {}, stop() {},
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === 'fixture.cleanup') {
        const { owner, hook } = params as { owner: string; hook: string };
        cleanupCalls.push({ method, owner, hook, registered: receipts.get(owner)?.registrationId });
        return {} as T;
      }
      const id = method.slice(0, -'.app.dispatch'.length);
      enabledBindings.push({ admitted: (params as { registrationId?: string })?.registrationId,
        registered: receipts.get(id)?.registrationId });
      return {} as T;
    },
  });
  let pid: number | null = 100;
  let generation = 1;
  let connected = true;
  const writePackage = async (directory: string, id: string, version: string, native = nativeSource) => {
    const appRoot = path.join(directory, 'app');
    await mkdir(appRoot, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({
      name: id, version, type: 'module', openclaw: { extensions: ['./index.js'] },
    }));
    await writeFile(path.join(directory, 'openclaw.plugin.json'), JSON.stringify({
      id, version, configSchema: { type: 'object', properties: {} },
    }));
    await writeFile(path.join(directory, 'index.js'), native);
    await writeFile(path.join(directory, 'native-asset.txt'), `Native resource ${version}`);
    const manifest: AppPluginManifest = {
      manifestVersion: 1, apiVersion: 1, id, nativePluginId: id, version,
      entries: { main: 'main.mjs', browser: 'browser.mjs' },
      commands: ['read'], capabilities: [], slots: [],
    };
    const contents = {
      'main.mjs': `export function register(){return {commands:[{id:'read',invoke:()=>({success:true,value:${JSON.stringify(version)}})}]};}`,
      'browser.mjs': `export function register(){} // UI ${version}`,
      'native.binding.json': JSON.stringify({ entry: 'index.js', profile: 'single-file-v1', sha256: sha(native) }),
    };
    const files = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, sha(bytes)]));
    for (const [name, bytes] of Object.entries(contents)) await writeFile(path.join(appRoot, name), bytes);
    const hash = artifactDigest(manifest, files);
    await writeFile(path.join(appRoot, 'app.artifact.json'), JSON.stringify({ manifest, files, hash }));
    return { hash, directory, native };
  };
  const register = (id: string, native = nativeSource) => {
    const item = installed.find(item => item.id === id)!;
    receipts.set(id, { pluginId: id, registrationId: randomUUID(), processId: pid!,
      gatewayMethods: [], nativeEntry: path.join(item.installPath, 'index.js'), sourceSha256: sha(native) });
  };
  for (const item of installed) {
    const first = await writePackage(item.installPath, item.id, '1.0.0');
    await store.approve(item.id, first.hash);
    register(item.id);
  }
  const approve = vi.fn((id: string, hash: string) => store.approve(id, hash));
  const stopped = vi.fn(async <T>(operation: () => Promise<T>) => {
    connected = false; pid = null;
    return operation();
  });
  const ensureReady = vi.fn(async () => {
    pid = 101; generation++; connected = true;
    for (const item of installed) register(item.id);
  });
  const runtime = { captureGatewayResponseContext: () => ({ isCurrent: () => connected }) };
  const manager = new AppPluginManager({
    retentionRoot: path.join(root, 'retained'),
    resources: {
      getNativeStateDirectory: () => state,
      getRuntime: () => runtime,
      getSessions: () => ({ listAgents: () => [] }),
      requestGateway: (...args: [string, unknown?]) => nativeClient.request(...args),
      requestConnectedGateway: async (method: string) => {
        const id = installed.find(item => appNativeHandshakeMethod(item.id) === method)!.id;
        return enabled.get(id) ? receipts.get(id) : undefined;
      },
      ensureReady,
    } as unknown as AppHostResources,
    candidates: async () => {
      return discoverAppCandidates(bundled, null, installed, await store.read());
    },
    approveArtifact: approve,
    readDesiredEnabled: id => enabled.get(id),
    broadcast: () => {},
    isGatewayConnected: () => connected,
    getGatewayProcessId: () => pid,
    getGatewayProcessGeneration: () => generation,
    withStoppedGateway: stopped,
    loadModule: async url => {
      loadedModules.push(url);
      const source = await readFile(new URL(url), 'utf8');
      // The native/Electron probe separately covers the real SDK-built ESM graphs.
      const module = new Function(`${source.replace('export function', 'function')};return {register};`)() as AppMainModule;
      return { register: host => ({ ...module.register(host),
        ...(options.cleanupNativeQuery ? {
          cleanupGatewayMethods: ['fixture.cleanup'],
          allowCleanupGatewayRequest: (method: string) => method === 'fixture.cleanup',
          beforeDisable: async () => { await host.requestGateway('fixture.cleanup', { owner: host.manifest.id, hook: 'beforeDisable' }); },
          beforePackageMutation: async () => { await host.requestGateway('fixture.cleanup', { owner: host.manifest.id, hook: 'beforePackageMutation' }); },
        } : {}),
        onEnable: () => { void host.requestGateway('fixture.enable', {}); },
      }) };
    },
  });
  disposers.push(() => manager.dispose());
  await manager.prepare(); await manager.activate(); await manager.refresh();
  const installPath = installed[0].installPath;
  const history = path.join(state, 'history-sentinel.json');
  await writeFile(history, '{"history":"preserved"}');
  return {
    manager, installPath, approve, stopped, ensureReady, store, history, enabledBindings, cleanupCalls, loadedModules,
    currentRegistration: () => receipts.get(targetId)!.registrationId,
    source: (version: string) => writePackage(path.join(root, `source-${version}`), targetId, version,
      `export default {version:${JSON.stringify(version)}};`),
    replace: async (source: { directory: string; native: string }) => {
      await cp(source.directory, installPath, { recursive: true });
      register(targetId, source.native);
    },
    snapshot: (id = targetId) => manager.snapshot().find(item => item.id === id)!,
    invoke: (id = targetId, epoch = manager.snapshot().find(item => item.id === id)!.epoch) =>
      manager.invoke({ id, command: 'read', epoch, args: [] }),
    apply: <T>(sourceDirectory: string, operation: (mode: string) => Promise<T>) => manager.withExtensionPackageMutation(apply =>
      apply({ nativePluginIds: [targetId], installPath, sourceDirectory }, operation)),
    approveInstalled: () => manager.approveInstalledPackage({ nativePluginId: targetId, installPath }),
  };
}

test('updates Native and Main/UI together without disturbing another companion', async () => {
  const f = await fixture();
  const original = f.snapshot();
  const peer = f.snapshot(peerId);
  expect(await f.invoke()).toEqual({ success: true, value: '1.0.0' });
  for (const version of ['1.0.1']) {
    const previous = f.snapshot();
    const next = await f.source(version);
    await f.apply(next.directory, async mode => {
      expect(mode).toBe(ExtensionPackageLifecycleMode.HOT);
      expect(f.loadedModules).toHaveLength(2); // Only the two already installed Main modules.
      expect(f.snapshot().state).not.toBe('active');
      expect(await f.invoke(targetId, previous.epoch)).toMatchObject({ success: false });
      expect(f.snapshot(peerId)).toEqual(peer);
      expect(await readAppAsset(peer.browserEntry!.slice(1))).not.toBeNull();
      await f.replace(next);
      await f.approveInstalled();
    });
    expect(f.snapshot()).toMatchObject({ state: 'active', version, hash: next.hash });
    expect(f.snapshot().epoch).not.toBe(previous.epoch);
    expect(await f.invoke()).toEqual({ success: true, value: version });
    expect(await readAppAsset(previous.browserEntry!.slice(1))).toBeNull();
    expect(await readAppAsset(f.snapshot().browserEntry!.slice(1))).not.toBeNull();
    expect(f.snapshot(peerId)).toEqual(peer);
  }
  expect(await f.invoke(targetId, original.epoch)).toMatchObject({ success: false });
  expect(await f.invoke(peerId)).toEqual({ success: true, value: '1.0.0' });
  expect(f.approve).toHaveBeenCalledExactlyOnceWith(targetId, f.snapshot().hash);
  expect(f.loadedModules).toHaveLength(3); // The replacement loads once, after Native committed.
  expect(f.stopped).not.toHaveBeenCalled();
  expect(f.ensureReady).not.toHaveBeenCalled();
  expect(f.enabledBindings.length).toBeGreaterThanOrEqual(3);
  expect(f.enabledBindings.every(binding => binding.admitted === binding.registered)).toBe(true);
  expect(await readFile(f.history, 'utf8')).toBe('{"history":"preserved"}');
});

test('leaves an unknown installation unapproved and withdraws only the affected owner', async () => {
  const f = await fixture();
  const old = f.snapshot();
  const peer = f.snapshot(peerId);
  const next = await f.source('1.0.1');
  const nativeWrite = vi.fn(async () => {
    await f.replace(next);
    throw new Error('Native installation reply was lost');
  });
  await expect(f.apply(next.directory, nativeWrite)).rejects.toThrow('reply was lost');
  expect(nativeWrite).toHaveBeenCalledOnce();
  expect(f.approve).not.toHaveBeenCalled();
  expect((await f.store.read())[targetId]).toBe(old.hash);
  expect(f.snapshot()?.state).not.toBe('active');
  expect(await f.invoke(targetId, old.epoch)).toMatchObject({ success: false });
  expect(f.snapshot(peerId)).toEqual(peer);
  expect(f.stopped).not.toHaveBeenCalled();
  expect(f.ensureReady).not.toHaveBeenCalled();
});

test('allows declared old-owner Native cleanup before hot replacement without a business binding', async () => {
  const f = await fixture({ cleanupNativeQuery: true });
  const peer = f.snapshot(peerId);
  const previousRegistration = f.currentRegistration();
  const next = await f.source('1.0.1');
  await f.apply(next.directory, async mode => {
    expect(mode).toBe(ExtensionPackageLifecycleMode.HOT);
    expect(new Set(f.cleanupCalls.map(call => call.hook))).toEqual(new Set(['beforeDisable', 'beforePackageMutation']));
    // A business binding would turn this raw method into an App Native dispatch RPC.
    expect(f.cleanupCalls.every(call => call.method === 'fixture.cleanup' &&
      call.owner === targetId && call.registered === previousRegistration)).toBe(true);
    expect(f.snapshot(peerId)).toEqual(peer);
    await f.replace(next);
    await f.approveInstalled();
  });
  expect(f.snapshot()).toMatchObject({ state: 'active', hash: next.hash });
  expect(f.currentRegistration()).not.toBe(previousRegistration);
  expect(f.enabledBindings.every(binding => binding.admitted === binding.registered)).toBe(true);
  expect(f.stopped).not.toHaveBeenCalled();
  expect(f.ensureReady).not.toHaveBeenCalled();
});

test('reloads an updated disabled companion without enabling it', async () => {
  const f = await fixture({ disabled: true });
  const peer = f.snapshot(peerId);
  const next = await f.source('1.0.1');
  await f.apply(next.directory, async mode => {
    expect(mode).toBe(ExtensionPackageLifecycleMode.HOT);
    await f.replace(next);
    await f.approveInstalled();
  });
  expect(f.snapshot()).toMatchObject({ hash: next.hash, version: '1.0.1', installed: true });
  expect(f.snapshot().state).not.toBe('active');
  expect(f.snapshot().browserEntry).toBeUndefined();
  expect(await f.invoke()).toMatchObject({ success: false });
  expect(f.snapshot(peerId)).toEqual(peer);
  expect((await f.store.read())[targetId]).toBe(next.hash);
  expect(f.enabledBindings).toHaveLength(1); // Only the unrelated enabled peer.
  expect(f.stopped).not.toHaveBeenCalled();
  expect(f.ensureReady).not.toHaveBeenCalled();
  expect(await readFile(f.history, 'utf8')).toBe('{"history":"preserved"}');
});
