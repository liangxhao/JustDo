import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { AppPluginError, type AppPluginManifest } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import type { AppMainHost } from '../../../../plugins/sdk/app-plugin-sdk/main';
import { preparePluginDataDirectory } from '../data/pluginDataService';
import type { VerifiedAppArtifact } from './artifact';
import { type AppHostResources,AppPluginRegistry } from './registry';

it.each([undefined, 'retain'] as const)(
  'fences private data access by declaration, durable retention and business lifetime: %s', async retention => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'plugin-data-port-test-'));
  const manifest: AppPluginManifest = {
    manifestVersion: 1, apiVersion: 1, id: 'fixture', nativePluginId: 'fixture', version: '1.0.0',
    entries: { main: 'main.mjs', browser: 'browser.mjs' }, capabilities: [], commands: ['read'], slots: [],
    data: { directory: 'managed-v1', ...(retention ? { retention } : {}) },
  };
  const artifact: VerifiedAppArtifact = { root: state, artifact: { manifest, hash: 'a'.repeat(64), files: {} } };
  const binding = { pluginId: 'fixture', registrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', processId: 123, gatewayMethods: [] };
  let enabled = true;
  let host!: AppMainHost;
  const registry = new AppPluginRegistry(() => ({ enabled, confirmed: true, binding }));
  const undeclared = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
  const cleanup = async () => {
    if (path.dirname(state) !== path.resolve(os.tmpdir()) || !path.basename(state).startsWith('plugin-data-port-test-'))
      throw new Error('Unsafe test cleanup');
    await rm(state, { recursive: true, force: true });
  };
  try {
    const directory = await preparePluginDataDirectory(state, 'fixture', manifest.data!);
    const resources = { getNativeStateDirectory: () => state } as unknown as AppHostResources;
    const load = async () => ({ register: (value: AppMainHost) => {
      host = value;
      return { commands: [{ id: 'read', invoke: () => host.getPluginDataDirectory() }] };
    } });
    await registry.prepare(artifact, resources, load);
    registry.activate();
    expect(host.getNativeStateDirectory()).toBe(path.join(state, 'fixture'));
    expect(() => host.getPluginDataDirectory()).toThrow(AppPluginError.Unavailable);
    const request = { id: 'fixture', epoch: registry.snapshot()[0].epoch, command: 'read', args: [] };
    expect(await registry.invoke(request)).toBe(directory);
    if (retention === 'retain') {
      const marker = path.join(directory, '.owner.json');
      const owner = JSON.parse(await readFile(marker, 'utf8'));
      delete owner.retention;
      await writeFile(marker, JSON.stringify(owner));
      expect(await registry.invoke(request)).toEqual({ success: false,
        error: AppPluginError.Unavailable });
      await preparePluginDataDirectory(state, 'fixture', manifest.data!);
      expect(await registry.invoke(request)).toBe(directory);
    }
    enabled = false;
    registry.refresh();
    expect(await registry.invoke(request)).toMatchObject({ success: false });
    const withoutData = { ...manifest };
    delete withoutData.data;
    await undeclared.prepare({ ...artifact, artifact: { ...artifact.artifact, manifest: withoutData } }, resources, load);
    undeclared.activate();
    expect(await undeclared.invoke({ ...request, epoch: undeclared.snapshot()[0].epoch })).toEqual({ success: false,
      error: AppPluginError.Unavailable });
  } finally {
    registry.dispose(); undeclared.dispose();
    await cleanup();
  }
});

it('allows retained data lookup in disabled resource callbacks without restoring business access', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'plugin-retained-port-test-'));
  const manifest: AppPluginManifest = {
    manifestVersion: 1, apiVersion: 1, id: 'fixture', nativePluginId: 'fixture', version: '1.0.0',
    entries: { main: 'main.mjs', browser: 'browser.mjs' }, capabilities: [], commands: ['read'], slots: [],
    data: { directory: 'managed-v1', retention: 'retain' },
  };
  const artifact: VerifiedAppArtifact = { root: state, artifact: { manifest, hash: 'a'.repeat(64), files: {} } };
  const binding = { pluginId: 'fixture', registrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', processId: 123, gatewayMethods: [] };
  let enabled = true;
  let host!: AppMainHost;
  let observed: string | undefined;
  const registry = new AppPluginRegistry(() => ({ enabled, confirmed: true, binding }));
  try {
    const directory = await preparePluginDataDirectory(state, 'fixture', manifest.data!);
    await registry.prepare(artifact, { getNativeStateDirectory: () => state } as unknown as AppHostResources,
      async () => ({ register: value => {
        host = value;
        return {
          commands: [{ id: 'read', invoke: () => host.getRetainedPluginDataDirectory() }],
          resources: {
            protectedResources: () => {
              expect(() => host.getPluginDataDirectory()).toThrow(AppPluginError.Unavailable);
              observed = host.getRetainedPluginDataDirectory();
              return [];
            },
            expandResources: ids => [...ids], acquireDeletion: () => () => undefined,
            isDeleting: () => false, isManaged: () => false,
            prepareDelete: async () => undefined, deleteManaged: async () => false,
          },
        };
      } }));
    registry.activate();
    const request = { id: 'fixture', epoch: registry.snapshot()[0].epoch, command: 'read', args: [] };
    expect(await registry.invoke(request)).toBe(directory);
    expect(() => host.getRetainedPluginDataDirectory()).toThrow(AppPluginError.Unavailable);
    enabled = false;
    registry.refresh();
    expect(await registry.invoke(request)).toMatchObject({ success: false });
    const readResources = registry.registrations()[0].resources!.protectedResources!;
    expect(readResources()).toEqual([]);
    expect(observed).toBe(directory);
    const marker = path.join(directory, '.owner.json');
    const owner = JSON.parse(await readFile(marker, 'utf8'));
    delete owner.retention;
    await writeFile(marker, JSON.stringify(owner));
    expect(readResources).toThrow('Plugin data retention is unavailable');
    await preparePluginDataDirectory(state, 'fixture', manifest.data!);
    expect(readResources()).toEqual([]);
    registry.dispose();
    expect(() => host.getRetainedPluginDataDirectory()).toThrow(AppPluginError.Retired);
    expect(readResources).toThrow(AppPluginError.Retired);
  } finally {
    registry.dispose();
    await rm(state, { recursive: true, force: true });
  }
});

it.each([undefined, { directory: 'managed-v1' as const }])(
  'rejects retained data lookup without an explicit retained declaration: %j', async data => {
    const state = await mkdtemp(path.join(os.tmpdir(), 'plugin-retained-port-test-'));
    const manifest: AppPluginManifest = {
      manifestVersion: 1, apiVersion: 1, id: 'fixture', nativePluginId: 'fixture', version: '1.0.0',
      entries: { main: 'main.mjs', browser: 'browser.mjs' }, capabilities: [], commands: [], slots: [],
      ...(data ? { data } : {}),
    };
    const registry = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
    let rejected = false;
    try {
      await preparePluginDataDirectory(state, 'fixture', { directory: 'managed-v1', retention: 'retain' });
      await registry.prepare({ root: state, artifact: { manifest, hash: 'a'.repeat(64), files: {} } },
        { getNativeStateDirectory: () => state } as unknown as AppHostResources,
        async () => ({ register: host => ({ commands: [], activate: () => {
          expect(() => host.getRetainedPluginDataDirectory()).toThrow(AppPluginError.Unavailable);
          rejected = true;
        } }) }));
      registry.activate();
      expect(rejected).toBe(true);
    } finally {
      registry.dispose();
      await rm(state, { recursive: true, force: true });
    }
  },
);

it('revokes retained data lookup after the cleanup callback lifetime ends', async () => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'plugin-retained-port-test-'));
  const manifest: AppPluginManifest = {
    manifestVersion: 1, apiVersion: 1, id: 'fixture', nativePluginId: 'fixture', version: '1.0.0',
    entries: { main: 'main.mjs', browser: 'browser.mjs' }, capabilities: [], commands: [], slots: [],
    data: { directory: 'managed-v1', retention: 'retain' },
  };
  const registry = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
  let late: Promise<void> | undefined;
  try {
    const directory = await preparePluginDataDirectory(state, 'fixture', manifest.data!);
    await registry.prepare({ root: state, artifact: { manifest, hash: 'a'.repeat(64), files: {} } },
      { getNativeStateDirectory: () => state } as unknown as AppHostResources,
      async () => ({ register: host => ({ commands: [], activate: () => {
        expect(host.getRetainedPluginDataDirectory()).toBe(directory);
        late = Promise.resolve().then(() => {
          expect(() => host.getRetainedPluginDataDirectory()).toThrow(AppPluginError.Retired);
        });
      } }) }));
    registry.activate();
    expect(late).toBeDefined();
    await late;
  } finally {
    registry.dispose();
    await rm(state, { recursive: true, force: true });
  }
});
