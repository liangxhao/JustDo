import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CompleteAcpxRuntime } from './runtime-proxy.js';

const { prepareAuth } = vi.hoisted(() => ({
  prepareAuth: vi.fn(async ({ pluginConfig }: { pluginConfig: unknown }) => pluginConfig),
}));
vi.mock('./codex-auth-bridge.js', () => ({ prepareAcpxCodexAuthConfig: prepareAuth }));

import { createAcpxRuntimeService, createManagedAcpxAgentRegistry } from './service.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  prepareAuth.mockClear();
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(shutdown = vi.fn(async () => {})) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acpx-service-'));
  directories.push(root);
  const namespaces = new Map<string, Map<string, unknown>>();
  const runtime = {
    doctor: vi.fn(async () => ({ ok: true, message: 'ready' })),
    doctorAgent: vi.fn(async () => ({ ok: true, message: 'ready' })),
    isHealthy: vi.fn(() => true),
    shutdown,
  } as unknown as CompleteAcpxRuntime & { isHealthy(): boolean };
  const lifecycle = { publish: vi.fn(), retract: vi.fn() };
  const service = createAcpxRuntimeService({
    pluginConfig: { diagnosticAgents: ['codex', 'claude'] },
    backendLifecycle: lifecycle,
    openKeyedStore: (({ namespace }: { namespace: string }) => {
      const store = namespaces.get(namespace) ?? new Map<string, unknown>();
      namespaces.set(namespace, store);
      return {
        lookup: async (key: string) => store.get(key),
        register: async (key: string, value: unknown) => {
          store.set(key, value);
        },
        entries: async () => [...store].map(([key, value]) => ({ key, value })),
        delete: async (key: string) => {
          store.delete(key);
        },
      };
    }) as never,
    runtimeFactory: () => runtime,
  });
  const ctx = {
    workspaceDir: path.join(root, 'project'),
    stateDir: path.join(root, 'state'),
    config: { acp: { allowedAgents: [] } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  return { service, runtime, lifecycle, ctx };
}

describe('managed ACPX service lifecycle', () => {
  it('prepares disabled diagnostic adapters without enabling or probing them', async () => {
    const { service, runtime, lifecycle, ctx } = await fixture();
    await service.start(ctx as never);
    expect(prepareAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledAgents: new Set(['codex', 'claude']),
        stateDir: ctx.stateDir,
      }),
    );
    expect(ctx.config.acp.allowedAgents).toEqual([]);
    expect(runtime.doctor).not.toHaveBeenCalled();
    expect(lifecycle.publish).toHaveBeenCalledWith({ runtime });
    await service.stop?.(ctx as never);
  });

  it('retracts admission and waits for asynchronous shutdown', async () => {
    let release!: () => void;
    const shutdown = vi.fn(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );
    const { service, runtime, lifecycle, ctx } = await fixture(shutdown);
    await service.start(ctx as never);
    let settled = false;
    const stopping = Promise.resolve(service.stop!(ctx as never)).then(() => {
      settled = true;
    });
    expect(lifecycle.retract).toHaveBeenCalledWith(runtime);
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await stopping;
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('reports aggregate cleanup failure after revoking the backend', async () => {
    const failure = new AggregateError(
      [new Error('flush failed'), new Error('close failed')],
      'cleanup failed',
    );
    const { service, runtime, lifecycle, ctx } = await fixture(
      vi.fn(async () => {
        throw failure;
      }),
    );
    await service.start(ctx as never);
    await expect(service.stop!(ctx as never)).rejects.toBe(failure);
    expect(lifecycle.retract).toHaveBeenCalledWith(runtime);
  });

  it('rejects unregistered agents before ACPX can choose a package runner', () => {
    const argv = [process.execPath, 'C:\\Managed Adapters\\adapter.mjs', '  argument  '];
    const registry = createManagedAcpxAgentRegistry({ fixture: argv });
    expect(registry.list()).toEqual(['fixture']);
    expect(registry.resolve('fixture')).toEqual(argv);
    expect(() => registry.resolve('claude')).toThrow('no managed adapter command');
    expect(() => registry.resolve('codex')).toThrow('no managed adapter command');
  });
});
