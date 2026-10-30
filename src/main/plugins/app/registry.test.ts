import { DatabaseSync } from 'node:sqlite';

import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import {
  AppPluginError,
  type AppPluginManifest,
} from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import type { AppMainHost, AppMainRegistration } from '../../../../plugins/sdk/app-plugin-sdk/main';
import type { VerifiedAppArtifact } from './artifact';
import { type AppHostResources, AppPluginRegistry } from './registry';

const manifest: AppPluginManifest = {
  manifestVersion: 1,
  apiVersion: 1,
  id: 'fixture',
  nativePluginId: 'fixture',
  version: '1.0.0',
  entries: { main: 'main.mjs', browser: 'browser.mjs' },
  capabilities: [],
  commands: ['read'],
  slots: [],
};
const artifact: VerifiedAppArtifact = {
  root: 'C:/fixture',
  artifact: { manifest, hash: 'a'.repeat(64), files: {} },
};
const binding = {
  pluginId: 'fixture',
  registrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  processId: 123,
  gatewayMethods: [],
};
const setup = async (register: (host: AppMainHost) => AppMainRegistration) => {
  let enabled = true;
  const registry = new AppPluginRegistry(() => ({ enabled, confirmed: true, binding }));
  await registry.prepare(artifact, {} as AppHostResources, async () => ({ register }));
  registry.activate();
  return {
    registry,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    request: () => ({
      id: manifest.id,
      epoch: registry.snapshot()[0].epoch,
      command: 'read',
      args: [],
    }),
  };
};

it.each([
  undefined,
  { ...binding, gatewayMethods: undefined },
  { ...binding, pluginId: 'foreign-plugin' },
])(
  'keeps business and UI admission closed without an exact complete binding: %j',
  async invalidBinding => {
    const invoke = vi.fn(() => ({ success: true }));
    const onEnable = vi.fn();
    const registry = new AppPluginRegistry(() => ({
      enabled: true,
      confirmed: true,
      binding: invalidBinding as typeof binding,
    }));
    try {
      await registry.prepare(artifact, {} as AppHostResources, async () => ({
        register: () => ({ commands: [{ id: 'read', invoke }], onEnable }),
      }));
      registry.activate();
      expect(registry.snapshot()[0].state).toBe('cleanup');
      expect(
        await registry.invoke({
          id: 'fixture',
          epoch: registry.snapshot()[0].epoch,
          command: 'read',
          args: [],
        }),
      ).toMatchObject({ success: false });
      expect(invoke).not.toHaveBeenCalled();
      expect(onEnable).not.toHaveBeenCalled();
    } finally {
      registry.dispose();
    }
  },
);

function cleanupFixture() {
  const sqlite = new DatabaseSync(':memory:');
  const database = {
    exec: (sql: string) => sqlite.exec(sql),
    prepare: (sql: string) => sqlite.prepare(sql),
    transaction: (operation: () => unknown) => () => {
      sqlite.exec('BEGIN');
      try {
        const result = operation();
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as Database.Database;
  const registry = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
  const listeners = new Set<Parameters<AppHostResources['onNativeEvent']>[0]>();
  const observed: string[] = [];
  const disposed: string[] = [];
  const events: string[] = [];
  const resourceIds = new Set(['source']);
  const stopSession = vi.fn();
  const execution = { stopSession };
  const resources = {
    getExecution: () => execution,
    onNativeEvent: (listener: Parameters<AppHostResources['onNativeEvent']>[0]) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as AppHostResources;
  const prepare = (label: string, hash: string, adopt = false) =>
    registry.prepare(
      {
        ...artifact,
        artifact: { ...artifact.artifact, hash: hash.repeat(64) },
      },
      resources,
      async () => ({
        register: host => {
          let off: (() => void) | undefined;
          return {
            commands: [],
            beforeDisable: async () => () => {
              host.getExecution().stopSession(`lease:${label}`);
              events.push(`release:${label}`);
            },
            resources: {
              protectedResources: () => [...resourceIds],
              adoptResources: () => adopt,
              expandResources: ids => [...ids],
              acquireDeletion: () => () => {
                host.getExecution().stopSession(`deletion:${label}`);
              },
              isDeleting: () => false,
              isManaged: () => false,
              prepareDelete: async () => undefined,
              deleteManaged: async () => false,
            },
            activate: () => {
              off = host.onExecutionReceipt(() => {
                observed.push(label);
              });
            },
            dispose: () => {
              host.getExecution().stopSession(`dispose:${label}`);
              disposed.push(label);
              events.push(`dispose:${label}`);
              off?.();
            },
          };
        },
      }),
    );
  return {
    registry,
    sqlite,
    database,
    prepare,
    listeners,
    observed,
    disposed,
    events,
    resourceIds,
    stopSession,
    emit: () => {
      for (const listener of listeners)
        listener({
          event: 'agent',
          payload: {
            stream: 'lifecycle',
            sessionKey: 'native-key',
            runId: 'native-run',
            data: { phase: 'end', executionSettled: true },
          },
        });
    },
    close: () => {
      registry.dispose();
      sqlite.close();
    },
  };
}

it('keeps native read contexts scoped to their runtime and plugin epoch', async () => {
  let enabled = true;
  let nativeCurrent = true;
  const nativeContext = {
    isCurrent: () => nativeCurrent,
    isResponseError: () => true,
  };
  let runtime = { captureGatewayResponseContext: () => nativeContext };
  const status = vi.fn().mockResolvedValue({
    known: true,
    running: false,
    mainRunning: false,
    subagentRunning: false,
  });
  const execution = { getSessionRuntimeStatus: status };
  const options = {
    targeted: true,
    includeSubagents: true,
    expectedSessionId: 'native-session',
    expectedLifecycleRevision: 'revision',
  };
  let captured: { isCurrent(): boolean } | null = null;
  const registry = new AppPluginRegistry(() => ({ enabled, confirmed: true, binding }));
  try {
    await registry.prepare(
      artifact,
      {
        getRuntime: () => runtime,
        getExecution: () => execution,
      } as unknown as AppHostResources,
      async () => ({
        register: host => ({
          commands: [
            {
              id: 'read',
              invoke: async () => {
                captured = host.getRuntime()!.captureGatewayResponseContext();
                await host.getExecution().getSessionRuntimeStatus('source', options);
                return { success: true };
              },
            },
          ],
        }),
      }),
    );
    registry.activate();
    const read = () =>
      registry.invoke({
        id: 'fixture',
        epoch: registry.snapshot()[0].epoch,
        command: 'read',
        args: [],
      });
    await expect(read()).resolves.toEqual({ success: true });
    expect(status).toHaveBeenCalledExactlyOnceWith('source', options);
    expect(Object.keys(captured!)).toEqual(['isCurrent']);
    expect(captured!.isCurrent()).toBe(true);
    nativeCurrent = false;
    expect(captured!.isCurrent()).toBe(false);

    nativeCurrent = true;
    await read();
    const replaced = captured!;
    runtime = { captureGatewayResponseContext: () => nativeContext };
    expect(replaced.isCurrent()).toBe(false);
    await read();
    const retired = captured!;
    enabled = false;
    registry.refresh();
    expect(retired.isCurrent()).toBe(false);
    enabled = true;
    registry.refresh();
    expect(retired.isCurrent()).toBe(false);
  } finally {
    registry.dispose();
  }
});

it('preserves execution identity and rejects reads through a replaced execution facade', async () => {
  const status = vi.fn().mockResolvedValue({ known: true, running: false });
  let execution = { getSessionRuntimeStatus: status };
  let host!: AppMainHost;
  const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
  try {
    await registry.prepare(
      artifact,
      {
        getExecution: () => execution,
      } as unknown as AppHostResources,
      async () => ({
        register: value => {
          host = value;
          return { commands: [] };
        },
      }),
    );
    const first = host.getExecution();
    expect(host.getExecution()).toBe(first);
    execution = { getSessionRuntimeStatus: status };
    expect(host.getExecution()).not.toBe(first);
    expect(() => first.getSessionRuntimeStatus('source', { targeted: true })).toThrow(
      AppPluginError.Unavailable,
    );
    expect(status).not.toHaveBeenCalled();
  } finally {
    registry.dispose();
  }
});

it('preserves live runtime and client identity without hiding real replacements', async () => {
  let client = { request: vi.fn().mockResolvedValue({}) };
  let runtime = { getGatewayClient: () => client };
  let host!: AppMainHost;
  const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
  await registry.prepare(
    artifact,
    {
      getRuntime: () => runtime,
    } as unknown as AppHostResources,
    async () => ({
      register: value => {
        host = value;
        return {
          commands: [
            {
              id: 'read',
              invoke: () => host.getRuntime()!.getGatewayClient()!.request('fixture.read', {}),
            },
          ],
        };
      },
    }),
  );
  registry.activate();
  const first = host.getRuntime()!;
  const firstClient = first.getGatewayClient();
  expect(host.getRuntime()).toBe(first);
  expect(first.getGatewayClient()).toBe(firstClient);
  client = { request: vi.fn().mockResolvedValue({}) };
  expect(host.getRuntime()).toBe(first);
  expect(first.getGatewayClient()).not.toBe(firstClient);
  runtime = { getGatewayClient: () => client };
  expect(host.getRuntime()).not.toBe(first);
  const invocation = {
    id: 'fixture',
    epoch: registry.snapshot()[0].epoch,
    command: 'read',
    args: [],
  };
  await registry.invoke(invocation);
  expect(client.request).toHaveBeenCalledExactlyOnceWith('fixture.read', {});
  registry.dispose();
  expect(() => firstClient!.request('fixture.read', {})).toThrow();
});

it('publishes metadata only from current business calls with host-owned identity', async () => {
  let enabled = true;
  let host!: AppMainHost;
  const publish = vi.fn();
  const registry = new AppPluginRegistry(() => ({ enabled, confirmed: true, binding }), publish);
  await registry.prepare(artifact, {} as AppHostResources, async () => ({
    register: value => {
      host = value;
      return {
        commands: [{ id: 'read', invoke: () => host.publishEvent('changed', { revision: 1 }) }],
      };
    },
  }));
  registry.activate();
  const epoch = registry.snapshot()[0].epoch;
  await registry.invoke({ id: manifest.id, epoch, command: 'read', args: [] });
  expect(publish).toHaveBeenCalledExactlyOnceWith({
    id: manifest.id,
    hash: artifact.artifact.hash,
    epoch,
    name: 'changed',
    payload: { revision: 1 },
  });
  expect(() => host.publishEvent('changed', {})).toThrow();
  enabled = false;
  registry.refresh();
  await registry.invoke({ id: manifest.id, epoch, command: 'read', args: [] });
  expect(publish).toHaveBeenCalledTimes(1);
});

describe('app plugin lifecycle admission', () => {
  it('isolates a known unavailable owner while preserving exact resource protection', async () => {
    const h = cleanupFixture();
    try {
      h.registry.initializeDatabase(h.database);
      h.registry.blockResourceAdmission('missing-owner');
      expect(h.registry.hasUnresolvedInventory()).toBe(true);
      expect(() => h.registry.assertResourceOwners(['ordinary'])).not.toThrow();
      const mutate = vi.fn(async () => undefined);
      await h.registry.mutate('healthy-owner', false, mutate);
      expect(mutate).toHaveBeenCalledOnce();
      await expect(h.registry.preparePackageMutation()).resolves.toBeUndefined();

      h.sqlite.prepare('INSERT INTO app_plugin_resources VALUES (?, ?, ?)')
        .run('missing-owner', 'b'.repeat(64), 'protected-source');
      expect(() => h.registry.assertResourceOwners(['protected-source'])).toThrow(AppPluginError.Unavailable);
      expect(() => h.registry.assertResourceOwners(['ordinary'])).not.toThrow();
      await expect(h.registry.preparePackageMutation()).rejects.toThrow('appPluginCleanupUnresolved');
      await expect(h.registry.mutate('missing-owner', false, mutate))
        .rejects.toThrow('appPluginCleanupUnresolved');
      expect(mutate).toHaveBeenCalledOnce();
    } finally {
      h.close();
    }
  });

  it('inherits scoped failures without converting them into an unknown global inventory', async () => {
    const h = cleanupFixture();
    const source = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
    try {
      source.blockResourceAdmission('missing-owner');
      h.registry.inheritResourceAdmissionFailures(source);
      h.registry.initializeDatabase(h.database);
      expect(() => h.registry.assertResourceOwners(['ordinary'])).not.toThrow();
      h.registry.restoreResourceAdmission('missing-owner');
      expect(h.registry.hasUnresolvedInventory()).toBe(false);

      source.blockResourceAdmission();
      h.registry.inheritResourceAdmissionFailures(source);
      expect(() => h.registry.assertResourceOwners(['ordinary'])).toThrow(AppPluginError.Unavailable);
      await expect(h.registry.preparePackageMutation()).rejects.toThrow('appPluginCleanupUnresolved');
    } finally {
      source.dispose();
      h.close();
    }
  });

  it('retires old receipt subscriptions after adoption without dropping the active disable lease', async () => {
    const h = cleanupFixture();
    try {
      await h.prepare('old', 'a');
      h.registry.initializeDatabase(h.database);
      h.registry.activate();
      await h.registry.mutate(
        'fixture',
        false,
        async () => {
          h.registry.retireForReplacement('fixture');
          await h.prepare('new', 'b', true);
          h.registry.initializeDatabase(h.database, { onlyIds: ['fixture'] });
          h.registry.activate();
          expect(h.disposed).toEqual([]);
        },
        { packageMutation: true },
      );
      expect(h.events).toEqual(['release:old', 'dispose:old']);
      expect(h.listeners.size).toBe(1);
      h.emit();
      expect(h.observed).toEqual(['new']);
      expect(() => h.registry.assertResourceOwners(['source'])).not.toThrow();
      expect(h.sqlite.prepare('SELECT artifact_hash FROM app_plugin_resources').get()).toEqual({
        artifact_hash: 'b'.repeat(64),
      });
    } finally {
      h.close();
    }
    expect(h.disposed).toEqual(['old', 'new']);
  });

  it('releases the last deletion lease before disposing an unreferenced retired owner', async () => {
    const h = cleanupFixture();
    try {
      await h.prepare('old', 'a');
      h.registry.initializeDatabase(h.database);
      h.registry.activate();
      const release = h.registry.registrations()[0].resources!.acquireDeletion(['source']);
      h.registry.retireForReplacement('fixture');
      h.resourceIds.clear();
      h.registry.confirmResourceDeletion(['source']);
      expect(h.disposed).toEqual([]);
      release();
      release();
      expect(h.disposed).toEqual(['old']);
      expect(h.listeners.size).toBe(0);
      expect(h.stopSession.mock.calls.map(([id]) => id)).toEqual(['deletion:old', 'dispose:old']);
    } finally {
      h.close();
    }
    expect(h.disposed).toEqual(['old']);
  });

  it('disposes each replaced registration once when returning to a previously used artifact', async () => {
    const h = cleanupFixture();
    try {
      await h.prepare('a-first', 'a');
      h.registry.initializeDatabase(h.database);
      h.registry.activate();
      h.registry.retireForReplacement('fixture');
      await h.prepare('b', 'b');
      h.registry.initializeDatabase(h.database);
      h.registry.activate();
      h.registry.retireForReplacement('fixture');
      expect(h.disposed).toEqual(['b']);
      await h.prepare('a-second', 'a');
      h.registry.initializeDatabase(h.database);
      expect(h.disposed).toEqual(['b']);
      h.registry.activate();
      expect(h.disposed).toEqual(['b', 'a-first']);
      h.registry.retireForReplacement('fixture');
      await h.prepare('c', 'c');
      h.registry.initializeDatabase(h.database);
      h.registry.activate();
      h.resourceIds.clear();
      h.registry.confirmResourceDeletion(['source']);
      expect(h.disposed).toEqual(['b', 'a-first', 'a-second']);
      expect(h.listeners.size).toBe(1);
      h.emit();
      expect(h.observed).toEqual(['c']);
    } finally {
      h.close();
    }
    expect(h.disposed).toEqual(['b', 'a-first', 'a-second', 'c']);
  });

  it('preserves a healthy same-artifact cleanup owner when an unactivated replacement retires', async () => {
    const h = cleanupFixture();
    try {
      await h.prepare('original', 'a');
      h.registry.initializeDatabase(h.database);
      h.registry.activate();
      h.registry.retireForReplacement('fixture');
      await h.prepare('unactivated', 'a');
      h.registry.retireForReplacement('fixture');
      expect(h.disposed).toEqual(['unactivated']);
      expect(h.listeners.size).toBe(1);
      expect(() => h.registry.assertResourceOwners(['source'])).not.toThrow();
      h.emit();
      expect(h.observed).toEqual(['original']);
      h.resourceIds.clear();
      h.registry.confirmResourceDeletion(['source']);
      expect(h.disposed).toEqual(['unactivated', 'original']);
    } finally {
      h.close();
    }
  });

  it.each(['success', 'unknown'])(
    'releases the old disable lease before replacement disposal after %s mutation',
    async outcome => {
      const registry = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
      const events: string[] = [];
      const stopSession = vi.fn();
      const execution = { stopSession };
      const unknown = new Error('unknown package outcome');
      try {
        await registry.prepare(
          artifact,
          { getExecution: () => execution } as unknown as AppHostResources,
          async () => ({
            register: host => ({
              commands: [],
              beforeDisable: async () => () => {
                host.getExecution().stopSession('cleanup-lease');
                events.push('release');
              },
              dispose: () => {
                events.push('dispose');
              },
            }),
          }),
        );
        registry.activate();
        const pending = registry.mutate(
          'fixture',
          false,
          async () => {
            registry.retireForReplacement('fixture');
            expect(events).toEqual([]);
            if (outcome === 'unknown') throw unknown;
            return { success: true };
          },
          { packageMutation: true },
        );
        if (outcome === 'unknown') await expect(pending).rejects.toBe(unknown);
        else await expect(pending).resolves.toEqual({ success: true });
        expect(events).toEqual(['release', 'dispose']);
        expect(stopSession).toHaveBeenCalledExactlyOnceWith('cleanup-lease');
      } finally {
        registry.dispose();
      }
    },
  );

  it('disposes imported cleanup owners once through their original registry scope', async () => {
    const source = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
    const target = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
    const stopSession = vi.fn();
    const execution = { stopSession };
    const dispose = vi.fn((host: AppMainHost) => {
      host.getExecution().stopSession('historical-source');
    });
    try {
      await source.prepare(
        artifact,
        { getExecution: () => execution } as unknown as AppHostResources,
        async () => ({
          register: host => ({ commands: [], dispose: () => dispose(host) }),
        }),
        { cleanupOnly: true },
      );
      source.activate();
      target.retainCleanupOwners(source);
      target.dispose();
      expect(dispose).not.toHaveBeenCalled();
      source.dispose();
      expect(dispose).toHaveBeenCalledOnce();
      expect(stopSession).toHaveBeenCalledExactlyOnceWith('historical-source');
    } finally {
      target.dispose();
      source.dispose();
    }
  });

  it('retains disposal of locally replaced cleanup owners in the original scope', async () => {
    const registry = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
    const stopSession = vi.fn();
    const execution = { stopSession };
    const database = {
      exec: vi.fn(),
      prepare: () => ({
        all: () => [{ artifact_hash: artifact.artifact.hash, resource_id: 'historical-source' }],
      }),
    } as unknown as Database.Database;
    try {
      await registry.prepare(
        artifact,
        { getExecution: () => execution } as unknown as AppHostResources,
        async () => ({
          register: host => ({
            commands: [],
            dispose: () => {
              host.getExecution().stopSession('historical-source');
            },
          }),
        }),
        { cleanupOnly: true },
      );
      registry.initializeDatabase(database);
      registry.activate();
      registry.retireForReplacement(manifest.id);
      expect(stopSession).not.toHaveBeenCalled();
      registry.dispose();
      expect(stopSession).toHaveBeenCalledExactlyOnceWith('historical-source');
    } finally {
      registry.dispose();
    }
  });

  it('reserves the native identity before asynchronous module loading', async () => {
    const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
    let resume: () => void = () => undefined;
    const first = registry.prepare(artifact, {} as AppHostResources, async () => {
      await new Promise<void>(resolve => {
        resume = resolve;
      });
      return { register: () => ({ commands: [] }) };
    });
    const duplicate = {
      ...artifact,
      artifact: { ...artifact.artifact, manifest: { ...manifest, id: 'other' } },
    };
    await expect(
      registry.prepare(duplicate, {} as AppHostResources, async () => ({
        register: () => ({ commands: [] }),
      })),
    ).rejects.toThrow('Duplicate');
    resume();
    await first;
    registry.activate();
    expect(registry.snapshot()).toHaveLength(1);
  });

  it('does not publish a candidate whose loader finishes after disposal', async () => {
    const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
    let resume: () => void = () => undefined;
    const register = vi.fn(() => ({ commands: [] }));
    const pending = registry.prepare(artifact, {} as AppHostResources, async () => {
      await new Promise<void>(resolve => {
        resume = resolve;
      });
      return { register };
    });
    registry.dispose();
    resume();
    await expect(pending).rejects.toThrow(AppPluginError.Retired);
    expect(register).not.toHaveBeenCalled();
    expect(registry.snapshot()).toEqual([]);
  });

  it('does not resume after an unknown native mutation outcome', async () => {
    const { registry, request } = await setup(() => ({
      commands: [{ id: 'read', invoke: () => ({ success: true }) }],
    }));
    await expect(
      registry.mutate('fixture', false, async () => {
        throw new Error('unknown');
      }),
    ).rejects.toThrow('unknown');
    expect(registry.snapshot()[0].state).toBe('cleanup');
    expect(await registry.invoke(request())).toEqual({
      success: false,
      error: AppPluginError.Unavailable,
    });
  });

  it('recovers a lost toggle response only after a fresh authenticated Native proof', async () => {
    let native = { enabled: true, confirmed: true, configurationEnabled: true, binding };
    const operation = vi.fn(async () => {
      throw new Error('response lost');
    });
    const invoke = vi.fn(() => ({ success: true }));
    const registry = new AppPluginRegistry(() => native);
    try {
      await registry.prepare(artifact, {} as AppHostResources, async () => ({
        register: () => ({ commands: [{ id: 'read', invoke }] }),
      }));
      registry.activate();
      await expect(registry.mutate('fixture', true, operation)).rejects.toThrow('response lost');
      registry.refresh();
      expect(registry.snapshot()[0].state).toBe('cleanup');
      native = { ...native, confirmed: false, binding: { ...binding } };
      registry.refresh();
      expect(registry.snapshot()[0].state).toBe('cleanup');
      native = { ...native, confirmed: true, binding: { ...binding } };
      registry.refresh();
      expect(registry.snapshot()[0].state).toBe('active');
      expect(
        await registry.invoke({
          id: 'fixture',
          epoch: registry.snapshot()[0].epoch,
          command: 'read',
          args: [],
        }),
      ).toEqual({ success: true });
      expect(operation).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      registry.dispose();
    }
  });

  it('restores a known package preflight veto without clearing a failed resource inventory', async () => {
    let readable = true;
    const invoke = vi.fn(() => ({ success: true }));
    const { registry, request } = await setup(() => ({
      commands: [{ id: 'read', invoke }],
      resources: {
        protectedResources: () => {
          if (!readable) throw new Error('metadata unavailable');
          return ['source'];
        },
        expandResources: ids => [...ids],
        acquireDeletion: () => () => undefined,
        isDeleting: () => false,
        isManaged: () => false,
        prepareDelete: async () => undefined,
        deleteManaged: async () => false,
      },
      beforePackageMutation: async () => undefined,
    }));
    const database = {
      exec: vi.fn(),
      prepare: () => ({ all: () => [], run: vi.fn() }),
      transaction: (operation: () => void) => operation,
    } as unknown as Database.Database;
    registry.initializeDatabase(database);
    const veto = new Error('preflight rejected before package mutation');
    await expect(
      registry.mutate(
        'fixture',
        false,
        async () => {
          throw veto;
        },
        { preflightVeto: veto },
      ),
    ).rejects.toBe(veto);
    registry.restorePackageAdmissions(['fixture']);
    expect(registry.snapshot()[0].state).toBe('active');
    expect(await registry.invoke(request())).toEqual({ success: true });
    invoke.mockClear();

    await expect(
      registry.mutate(
        'fixture',
        false,
        async () => {
          readable = false;
          await expect(registry.preparePackageMutation()).rejects.toThrow(
            'appPluginCleanupUnresolved',
          );
          throw veto;
        },
        { preflightVeto: veto },
      ),
    ).rejects.toBe(veto);
    registry.restorePackageAdmissions(['fixture']);
    registry.refresh();
    expect(registry.snapshot()[0].state).toBe('blocked');
    expect(await registry.invoke(request())).toEqual({
      success: false,
      error: AppPluginError.Unavailable,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(() => registry.assertResourceOwners(['source'])).toThrow(AppPluginError.Unavailable);
    registry.dispose();
  });

  it('gates the runtime client at the effect boundary after a delayed read', async () => {
    let enabled = true;
    let resume: () => void = () => undefined;
    const effect = vi.fn();
    const registry = new AppPluginRegistry(() => ({ enabled, confirmed: true, binding }));
    await registry.prepare(
      artifact,
      {
        getRuntime: () => ({ getGatewayClient: () => ({ request: effect }) }),
      } as unknown as AppHostResources,
      async () => ({
        register: host => ({
          commands: [
            {
              id: 'read',
              invoke: async () => {
                const client = host.getRuntime()!.getGatewayClient()!;
                await new Promise<void>(resolve => {
                  resume = resolve;
                });
                return client.request('workflow.resume', {});
              },
            },
          ],
        }),
      }),
    );
    registry.activate();
    const pending = registry.invoke({
      id: 'fixture',
      epoch: registry.snapshot()[0].epoch,
      command: 'read',
      args: [],
    });
    await registry.mutate('fixture', false, async () => {
      enabled = false;
    });
    await registry.mutate('fixture', true, async () => {
      enabled = true;
    });
    resume();
    expect(await pending).toEqual({ success: false, error: AppPluginError.Unavailable });
    expect(effect).not.toHaveBeenCalled();
  });
  it('rejects old replies after disable and same-artifact re-enable while retaining cleanup', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const dispose = vi.fn();
    const beforeDisable = vi.fn(async () => vi.fn());
    const { registry, setEnabled, request } = await setup(() => ({
      commands: [
        {
          id: 'read',
          invoke: () =>
            new Promise(value => {
              resolve = value;
            }),
        },
      ],
      dispose,
      beforeDisable,
    }));
    const oldRequest = request();
    const pending = registry.invoke(oldRequest);
    await registry.mutate('fixture', false, async () => {
      setEnabled(false);
    });
    expect(registry.snapshot()[0].state).toBe('cleanup');
    expect(dispose).not.toHaveBeenCalled();
    await registry.mutate('fixture', true, async () => {
      setEnabled(true);
    });
    resolve({ success: true, value: 'late' });
    expect(await pending).toEqual({ success: false, error: AppPluginError.Retired });
    expect(request().epoch).not.toBe(oldRequest.epoch);
    expect(beforeDisable).toHaveBeenCalledOnce();
    registry.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps a failed durable disable fence and never calls the native mutation', async () => {
    const nativeMutation = vi.fn();
    const { registry } = await setup(() => ({
      commands: [],
      beforeDisable: async () => {
        throw new Error('unknown');
      },
    }));
    await expect(registry.mutate('fixture', false, nativeMutation)).rejects.toThrow('unknown');
    expect(nativeMutation).not.toHaveBeenCalled();
    expect(registry.snapshot()[0].state).toBe('blocked');
  });

  it('checks an in-flight command scope before a late native effect after re-enable', async () => {
    let resume: () => void = () => undefined;
    const effect = vi.fn();
    const { registry, setEnabled, request } = await setup(host => ({
      commands: [
        {
          id: 'read',
          invoke: async () => {
            await new Promise<void>(resolve => {
              resume = resolve;
            });
            host.assertActive();
            effect();
            return { success: true };
          },
        },
      ],
    }));
    const pending = registry.invoke(request());
    await registry.mutate('fixture', false, async () => {
      setEnabled(false);
    });
    await registry.mutate('fixture', true, async () => {
      setEnabled(true);
    });
    resume();
    expect(await pending).toEqual({ success: false, error: AppPluginError.Unavailable });
    expect(effect).not.toHaveBeenCalled();
  });

  it('rejects undeclared commands and stale epochs before invoking business code', async () => {
    const invoke = vi.fn();
    const { registry, request } = await setup(() => ({ commands: [{ id: 'read', invoke }] }));
    expect(await registry.invoke({ ...request(), command: 'delete' })).toEqual({
      success: false,
      error: AppPluginError.Invalid,
    });
    expect(await registry.invoke({ ...request(), epoch: 'retired' })).toEqual({
      success: false,
      error: AppPluginError.Retired,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('isolates a broken schema without publishing its commands', async () => {
    const registry = new AppPluginRegistry(() => ({ enabled: true, confirmed: true, binding }));
    const invoke = vi.fn();
    const projectNativeConfig = vi.fn(() => {
      throw new Error('must not run');
    });
    await registry.prepare(artifact, {} as AppHostResources, async () => ({
      register: () => ({
        commands: [{ id: 'read', invoke }],
        schemas: [
          {
            id: 'metadata',
            initialize: () => {
              throw new Error('broken schema');
            },
          },
        ],
        projectNativeConfig,
      }),
    }));
    const database = {
      exec: vi.fn(),
      prepare: () => ({ all: () => [], run: vi.fn() }),
      transaction: (operation: () => void) => operation,
    } as unknown as Database.Database;
    registry.initializeDatabase(database);
    registry.activate();
    expect(registry.snapshot()[0].state).toBe('blocked');
    expect(
      await registry.invoke({
        id: 'fixture',
        epoch: registry.snapshot()[0].epoch,
        command: 'read',
        args: [],
      }),
    ).toEqual({ success: false, error: AppPluginError.Unavailable });
    expect(invoke).not.toHaveBeenCalled();
    expect(registry.projectNativeConfig([])).toEqual({});
    expect(projectNativeConfig).not.toHaveBeenCalled();
  });

  it('does not allow a config projection to change native enablement or another plugin', async () => {
    const { registry } = await setup(() => ({
      commands: [],
      projectNativeConfig: () => ({ availableAgentIds: ['main'] }),
    }));
    expect(registry.projectNativeConfig([])).toEqual({
      fixture: { config: { availableAgentIds: ['main'] } },
    });
  });
});
