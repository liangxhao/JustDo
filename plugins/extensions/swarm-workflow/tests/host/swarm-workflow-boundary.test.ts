import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { AppMainHost } from '@app-plugin/sdk/main';

import {
  type AppNativeBinding,
  appNativeGatewayMethodAlias,
} from '@app-plugin/sdk/native-contract';
import { type Flow, viewFlow } from '../../contracts/flow';
import { SwarmWorkflowGatewayEvent, WorkflowEventName } from '../../contracts/events';
import { SwarmWorkflowGateway } from '../../contracts/workflow';
import { FlowStore } from '../../data/store';
import { FlowEngine, type FlowHost } from '../../execution/engine';

const pluginRoot = path.resolve(import.meta.dirname, '../..');
const hostRoot = process.env.APP_PLUGIN_HOST_ROOT;
const loadHost = (entry: string) => {
  if (!hostRoot) throw new Error('Host integration requires APP_PLUGIN_HOST_ROOT');
  return import(/* @vite-ignore */ pathToFileURL(path.resolve(hostRoot, entry)).href);
};
const [binding, artifacts, registryModule] = hostRoot
  ? await Promise.all([
      loadHost('src/main/engine/gateway/pluginRequestBinding.ts'),
      loadHost('src/main/plugins/app/artifact.ts'),
      loadHost('src/main/plugins/app/registry.ts'),
    ])
  : [];
const bindPluginGatewayClient = binding?.bindPluginGatewayClient;
const inspectAppArtifact = artifacts?.inspectAppArtifact;
const AppPluginRegistry = registryModule?.AppPluginRegistry;
type AppHostResources = Omit<
  AppMainHost,
  | 'manifest'
  | 'epoch'
  | 'signal'
  | 'isEnabled'
  | 'assertActive'
  | 'onExecutionReceipt'
  | 'publishEvent'
>;
type GatewayClientLike = {
  start(): void;
  stop(): void;
  request: AppMainHost['requestGateway'];
};

const buildRoot = path.join(hostRoot ?? pluginRoot, 'build');
describe.skipIf(!hostRoot)('Host integration (requires APP_PLUGIN_HOST_ROOT)', () => {
  let artifactDirectory: string | undefined;
  let compiledRoot: string;
  beforeAll(async () => {
    await mkdir(buildRoot, { recursive: true });
    artifactDirectory = await mkdtemp(path.join(buildRoot, 'swarm-main-artifact-'));
    const { buildAppPlugin } = await loadHost('scripts/plugins/build-app-plugins.mjs');
    const built = await buildAppPlugin(pluginRoot, artifactDirectory);
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
    const relative = path.relative(buildRoot, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Unsafe boundary fixture cleanup');
    const nativeDirectory = path.join(directory, 'state');
    const database = new FlowStore(path.join(nativeDirectory, 'swarm-workflow'));
    const parentKey = 'agent:main:justdo:source';
    const flow: Flow = {
      id: 'owned',
      requestId: 'request',
      parentKey,
      parentId: 'native-source',
      agentId: 'main',
      agents: [],
      cwd: directory,
      permissionMode: 'workspace',
      mode: 'auto',
      goal: 'Inspect',
      revision: 3,
      createdAt: 1,
      updatedAt: 1,
      status: 'paused',
      nodes: [],
    };
    database.insert(flow);
    database.insert({
      ...flow,
      id: 'foreign',
      requestId: 'foreign-request',
      parentKey: 'agent:main:justdo:other',
    });
    const engine = new FlowEngine(database, {} as FlowHost);
    const identity = {
      pluginId: 'swarm-workflow',
      registrationId: randomUUID(),
      processId: process.pid,
    };
    const binding: AppNativeBinding = {
      ...identity,
      gatewayMethods: [SwarmWorkflowGateway.List, SwarmWorkflowGateway.Control].map(
        (method, ordinal) => ({
          method,
          alias: appNativeGatewayMethodAlias(identity, ordinal),
        }),
      ),
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
      if (method !== controlAlias)
        throw new Error('Unexpected Native method or registration alias');
      if (!params || typeof params !== 'object') throw new Error('Invalid flow control');
      expect(Object.keys(params).sort()).toEqual(['action', 'id', 'parentKeys', 'revision']);
      const control = params as {
        parentKeys: unknown;
        id: string;
        revision: number;
        action: 'stop';
      };
      expect(control.parentKeys).toEqual([parentKey]);
      expect(control.action).toBe('stop');
      if (database.get(control.id)?.parentKey !== parentKey) throw new Error('Foreign flow owner');
      return viewFlow(engine.control(control.id, control.revision, control.action));
    });
    const client: GatewayClientLike = bindPluginGatewayClient({
      request,
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as GatewayClientLike);
    const runtime = {
      getGatewayClient: () => client,
      getSessionKeysForSession: () => [
        'agent:main:openai-user:telegram:channel',
        parentKey,
        'agent:main:subagent:worker',
        parentKey,
      ],
    };
    const publishEvent = vi.fn();
    const nativeEvents = new Set<(event: { event: string; payload: unknown }) => void>();
    const registry = new AppPluginRegistry(
      () => ({ enabled: true, confirmed: true, binding }),
      publishEvent,
    );
    try {
      const artifact = await inspectAppArtifact(compiledRoot);
      const resources = {
        getNativeStateDirectory: () => nativeDirectory,
        getRuntime: () => runtime,
        getSessions: () => ({
          getSession: (id: string) => (id === 'source' ? { id } : null),
          getSessionByNativeKey: () => null,
        }),
        onNativeEvent: (listener: (event: { event: string; payload: unknown }) => void) => {
          nativeEvents.add(listener);
          return () => nativeEvents.delete(listener);
        },
      } as unknown as AppHostResources;
      const loadModule = (url: string) => {
        expect(url).toBe(
          pathToFileURL(path.join(artifact.root, artifact.artifact.manifest.entries.main)).href,
        );
        // Vitest's VM cannot run the production Function-created import callback.
        // Load the exact verified built entry through its supported ESM loader.
        return import(/* @vite-ignore */ url);
      };
      await registry.prepare(artifact, resources, loadModule);
      registry.activate();
      const snapshot = registry.snapshot()[0];
      expect(snapshot.state).toBe('active');
      const change = { parentKey, flowId: flow.id, revision: flow.revision };
      for (const listener of nativeEvents) {
        listener({ event: SwarmWorkflowGatewayEvent.Changed, payload: change });
        listener({
          event: SwarmWorkflowGatewayEvent.Changed,
          payload: { ...change, parentKey: 'agent:other:justdo:source' },
        });
      }
      expect(publishEvent).toHaveBeenCalledExactlyOnceWith({
        id: snapshot.id,
        hash: snapshot.hash,
        epoch: snapshot.epoch,
        name: WorkflowEventName.Changed,
        payload: { sessionId: 'source', flowId: flow.id, revision: flow.revision },
      });
      const invoke = (command: string, args: unknown[]) =>
        registry.invoke({
          id: snapshot.id,
          epoch: snapshot.epoch,
          command,
          args,
        });
      expect(await invoke('workflow.list', ['source'])).toMatchObject({
        success: true,
        flows: [{ id: 'owned', revision: 3, status: 'paused' }],
      });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        listAlias,
        { parentKeys: [parentKey] },
        undefined,
      );

      expect(
        await invoke('workflow.control', ['unowned-source', 'owned', 3, 'stop']),
      ).toMatchObject({ success: false });
      expect(request).toHaveBeenCalledTimes(1);
      expect(await invoke('workflow.control', ['source', 'foreign', 3, 'stop'])).toMatchObject({
        success: false,
      });
      expect(await invoke('workflow.control', ['source', 'owned', 2, 'stop'])).toMatchObject({
        success: false,
      });
      expect(database.get('owned')).toMatchObject({ status: 'paused', revision: 3 });
      expect(await invoke('workflow.control', ['source', 'owned', 3, 'stop'])).toMatchObject({
        success: true,
      });
      expect(request).toHaveBeenLastCalledWith(
        controlAlias,
        {
          parentKeys: [parentKey],
          id: 'owned',
          revision: 3,
          action: 'stop',
        },
        undefined,
      );
      expect(database.get('owned')).toMatchObject({ status: 'stopping', revision: 4 });
      expect(database.get('foreign')).toMatchObject({ status: 'paused', revision: 3 });
      expect(request.mock.calls.filter(([method]) => method === controlAlias)).toHaveLength(2);
      expect(
        request.mock.calls.every(([method]) => method === listAlias || method === controlAlias),
      ).toBe(true);

      const retained = database.get('owned');
      registry.removeOwner('swarm-workflow');
      expect(registry.snapshot()).toEqual([]);
      expect(await invoke('workflow.list', ['source'])).toMatchObject({ success: false });
      expect(database.get('owned')).toEqual(retained);
      await registry.prepare(artifact, resources, loadModule);
      registry.activate();
      const restored = registry.snapshot()[0];
      expect(restored.epoch).not.toBe(snapshot.epoch);
      expect(
        await registry.invoke({
          id: restored.id,
          epoch: restored.epoch,
          command: 'workflow.list',
          args: ['source'],
        }),
      ).toMatchObject({
        success: true,
        flows: [{ id: 'owned', revision: 4, status: 'stopping' }],
      });
      expect(request.mock.calls.filter(([method]) => method === controlAlias)).toHaveLength(2);
    } finally {
      registry.dispose();
      engine.stop();
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
