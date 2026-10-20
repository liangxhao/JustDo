import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

import {
  type AppNativeBinding,
  appNativeGatewayMethodAlias,
} from '../../packages/app-plugin-sdk/native-contract';
import { type Flow, viewFlow } from '../../plugins/extensions/swarm-workflow/contracts/flow';
import { SwarmWorkflowGateway } from '../../plugins/extensions/swarm-workflow/contracts/workflow';
import { FlowStore } from '../../plugins/extensions/swarm-workflow/data/store';
import { FlowEngine, type FlowHost } from '../../plugins/extensions/swarm-workflow/execution/engine';
import { bindPluginGatewayClient } from '../../src/main/engine/gateway/pluginRequestBinding';
import type { GatewayClientLike } from '../../src/main/engine/gateway/types';
import { inspectAppArtifact } from '../../src/main/plugins/app/artifact';
import { type AppHostResources, AppPluginRegistry } from '../../src/main/plugins/app/registry';

const buildRoot = path.resolve('build');
let artifactDirectory: string | undefined;
let compiledRoot: string;
beforeAll(async () => {
  await mkdir(buildRoot, { recursive: true });
  artifactDirectory = await mkdtemp(path.join(buildRoot, 'swarm-main-artifact-'));
  const { buildAppPlugin } = await import('../../scripts/plugins/build-app-plugins.mjs');
  const built = await buildAppPlugin(path.resolve('plugins/extensions/swarm-workflow'), artifactDirectory);
  compiledRoot = built.root;
});
afterAll(async () => {
  if (!artifactDirectory) return;
  const relative = path.relative(buildRoot, artifactDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Unsafe artifact fixture cleanup');
  await rm(artifactDirectory, { recursive: true, force: true });
});

test('loads the built Swarm Main and controls only exact owned flows through bound Native aliases', async () => {
  await mkdir(buildRoot, { recursive: true });
  const directory = await mkdtemp(path.join(buildRoot, 'swarm-main-boundary-'));
  const nativeDirectory = path.join(directory, 'state');
  const database = new FlowStore(path.join(nativeDirectory, 'swarm-workflow'));
  const parentKey = 'agent:main:justdo:source';
  const flow: Flow = {
    id: 'owned', requestId: 'request', parentKey, parentId: 'native-source', agentId: 'main',
    agents: [], cwd: directory, permissionMode: 'workspace', mode: 'auto', goal: 'Inspect',
    revision: 3, createdAt: 1, updatedAt: 1, status: 'paused', nodes: [],
  };
  database.insert(flow);
  database.insert({ ...flow, id: 'foreign', requestId: 'foreign-request', parentKey: 'agent:main:justdo:other' });
  const engine = new FlowEngine(database, {} as FlowHost);
  const identity = { pluginId: 'swarm-workflow', registrationId: randomUUID(), processId: process.pid };
  const binding: AppNativeBinding = {
    ...identity,
    gatewayMethods: [SwarmWorkflowGateway.List, SwarmWorkflowGateway.Control].map((method, ordinal) => ({
      method, alias: appNativeGatewayMethodAlias(identity, ordinal),
    })),
  };
  const listAlias = binding.gatewayMethods[0].alias;
  const controlAlias = binding.gatewayMethods[1].alias;
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === listAlias) {
      expect(params).toEqual({ parentKeys: [parentKey] });
      return {
        flows: database.forParents([parentKey]).map(viewFlow),
        running: database.summary([parentKey]).running,
      };
    }
    if (method !== controlAlias) throw new Error('Unexpected Native method or registration alias');
    if (!params || typeof params !== 'object') throw new Error('Invalid flow control');
    expect(Object.keys(params).sort()).toEqual(['action', 'id', 'parentKeys', 'revision']);
    const control = params as { parentKeys: unknown; id: string; revision: number; action: 'stop' };
    expect(control.parentKeys).toEqual([parentKey]);
    expect(control.action).toBe('stop');
    if (database.get(control.id)?.parentKey !== parentKey) throw new Error('Foreign flow owner');
    return viewFlow(engine.control(control.id, control.revision, control.action));
  });
  const client = bindPluginGatewayClient({
    request, start: vi.fn(), stop: vi.fn(),
  } as unknown as GatewayClientLike);
  const runtime = {
    getGatewayClient: () => client,
    getSessionKeysForSession: () => [
      'agent:main:openai-user:telegram:channel', parentKey,
      'agent:main:subagent:worker', parentKey,
    ],
  };
  const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
  try {
    const artifact = await inspectAppArtifact(compiledRoot);
    await registry.prepare(artifact, {
      getNativeStateDirectory: () => nativeDirectory,
      getRuntime: () => runtime,
      getSessions: () => ({ getSession: (id: string) => id === 'source' ? { id } : null }),
      onNativeEvent: () => () => undefined,
    } as unknown as AppHostResources, url => {
      expect(url).toBe(pathToFileURL(path.join(artifact.root, artifact.artifact.manifest.entries.main)).href);
      // Vitest's VM cannot run the production Function-created import callback.
      // Load the exact verified built entry through its supported ESM loader.
      return import(/* @vite-ignore */ url);
    });
    registry.activate();
    const snapshot = registry.snapshot()[0];
    expect(snapshot.state).toBe('active');
    const invoke = (command: string, args: unknown[]) => registry.invoke({
      id: snapshot.id, epoch: snapshot.epoch, command, args,
    });
    expect(await invoke('workflow.list', ['source'])).toMatchObject({
      success: true, flows: [{ id: 'owned', revision: 3, status: 'paused' }],
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(listAlias, { parentKeys: [parentKey] }, undefined);

    expect(await invoke('workflow.control', ['unowned-source', 'owned', 3, 'stop']))
      .toMatchObject({ success: false });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await invoke('workflow.control', ['source', 'foreign', 3, 'stop']))
      .toMatchObject({ success: false });
    expect(await invoke('workflow.control', ['source', 'owned', 2, 'stop']))
      .toMatchObject({ success: false });
    expect(database.get('owned')).toMatchObject({ status: 'paused', revision: 3 });
    expect(await invoke('workflow.control', ['source', 'owned', 3, 'stop']))
      .toMatchObject({ success: true });
    expect(request).toHaveBeenLastCalledWith(controlAlias, {
      parentKeys: [parentKey], id: 'owned', revision: 3, action: 'stop',
    }, undefined);
    expect(database.get('owned')).toMatchObject({ status: 'stopping', revision: 4 });
    expect(database.get('foreign')).toMatchObject({ status: 'paused', revision: 3 });
    expect(request.mock.calls.filter(([method]) => method === controlAlias)).toHaveLength(2);
    expect(request.mock.calls.every(([method]) => method === listAlias || method === controlAlias))
      .toBe(true);
  } finally {
    registry.dispose();
    engine.stop();
    database.close();
    const relative = path.relative(buildRoot, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Unsafe boundary fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
