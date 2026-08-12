import { describe, expect, test, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import { SessionRpc } from './sessionRpc';
import type { GatewayClientLike } from './types';

const createHarness = () => {
  const session = { id: 'session-1', agentId: 'main', modelRef: 'openai/gpt-4o' };
  let gatewayModelRef = 'openai/gpt-4o';
  const updateSession = vi.fn((_id: string, updates: { modelRef?: string }) => {
    if (updates.modelRef) session.modelRef = updates.modelRef;
  });
  const request = vi.fn((method: string, params?: { model?: string }) => {
    if (method === 'sessions.patch' && params?.model) {
      gatewayModelRef = params.model;
    }
    if (method === 'sessions.describe') {
      const separator = gatewayModelRef.indexOf('/');
      return Promise.resolve({
        session: {
          modelProvider: gatewayModelRef.slice(0, separator),
          model: gatewayModelRef.slice(separator + 1),
        },
      });
    }
    return Promise.resolve({});
  });
  const client = { request } as unknown as GatewayClientLike;
  const store = {
    getSession: () => session,
    getAgent: () => ({ model: 'openai/gpt-4o' }),
    updateSession,
  } as unknown as CoworkStore;
  return {
    rpc: new SessionRpc({ getGatewayClient: () => client, store }),
    request,
    session,
    updateSession,
  };
};

describe('SessionRpc model coordination', () => {
  test('patches, confirms, and persists the qualified gateway model', async () => {
    const { rpc, request, session } = createHarness();

    await expect(
      rpc.patchModel('session-1', 'anthropic/claude-sonnet-4', undefined, 'subsequent-calls'),
    ).resolves.toEqual({
      ok: true,
      modelRef: 'anthropic/claude-sonnet-4',
      appliesTo: 'subsequent-calls',
      source: 'gateway',
    });

    expect(request).toHaveBeenNthCalledWith(1, 'sessions.describe', {
      key: 'agent:main:justdo:session-1',
    });
    expect(request).toHaveBeenNthCalledWith(2, 'sessions.patch', {
      key: 'agent:main:justdo:session-1',
      model: 'anthropic/claude-sonnet-4',
    });
    expect(request).toHaveBeenNthCalledWith(3, 'sessions.describe', {
      key: 'agent:main:justdo:session-1',
    });
    expect(session.modelRef).toBe('anthropic/claude-sonnet-4');
  });

  test('does not persist a model when gateway confirmation differs', async () => {
    const session = { id: 'session-1', agentId: 'main', modelRef: 'openai/gpt-4o' };
    let describeCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'sessions.describe') {
        describeCount += 1;
        return describeCount === 2
          ? { session: { modelProvider: 'anthropic', model: 'claude-sonnet-4' } }
          : { session: { modelProvider: 'openai', model: 'gpt-4o' } };
      }
      return {};
    });
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request } as unknown as GatewayClientLike),
      store: {
        getSession: () => session,
        getAgent: () => ({ model: session.modelRef }),
        updateSession: vi.fn((_id: string, updates: { modelRef?: string }) => {
          if (updates.modelRef) session.modelRef = updates.modelRef;
        }),
      } as unknown as CoworkStore,
    });

    await expect(rpc.patchModel('session-1', 'openai/gpt-5')).resolves.toEqual({
      ok: false,
      error: 'Gateway confirmed unexpected model: anthropic/claude-sonnet-4',
      modelRef: 'openai/gpt-4o',
      source: 'gateway',
    });
    expect(session.modelRef).toBe('openai/gpt-4o');
    expect(request).toHaveBeenCalledWith('sessions.patch', {
      key: 'agent:main:justdo:session-1',
      model: 'openai/gpt-4o',
    });
  });

  test('blocks a concurrent turn and rejects the barrier when model application fails', async () => {
    let releasePatch!: () => void;
    const patchPending = new Promise<void>(resolve => {
      releasePatch = resolve;
    });
    const session = { id: 'session-1', agentId: 'main', modelRef: 'openai/gpt-4o' };
    const request = vi.fn(async (method: string) => {
      if (method === 'sessions.patch') await patchPending;
      if (method === 'sessions.describe') {
        return { session: { modelProvider: 'openai', model: 'gpt-4o' } };
      }
      return {};
    });
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request } as unknown as GatewayClientLike),
      store: {
        getSession: () => session,
        getAgent: () => ({ model: session.modelRef }),
        updateSession: vi.fn(),
      } as unknown as CoworkStore,
    });

    const update = rpc.patchModel('session-1', 'openai/gpt-5');
    const barrier = rpc.waitForModelUpdate('session-1');
    releasePatch();

    await expect(update).resolves.toEqual({
      ok: false,
      error: 'Gateway confirmed unexpected model: openai/gpt-4o',
      modelRef: 'openai/gpt-4o',
      source: 'gateway',
    });
    await expect(barrier).rejects.toThrow(
      'Gateway confirmed unexpected model: openai/gpt-4o',
    );
  });

  test('serializes an authoritative read with a following model patch', async () => {
    let releaseRead!: () => void;
    const readPending = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    let gatewayModelRef = 'openai/gpt-4o';
    let describeCount = 0;
    const request = vi.fn(async (method: string, params?: { model?: string }) => {
      if (method === 'sessions.describe') {
        describeCount += 1;
        if (describeCount === 1) await readPending;
        const [modelProvider, model] = gatewayModelRef.split('/', 2);
        return { session: { modelProvider, model } };
      }
      if (method === 'sessions.patch' && params?.model) gatewayModelRef = params.model;
      return {};
    });
    const session = { id: 'session-1', agentId: 'main', modelRef: 'openai/gpt-4o' };
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request } as unknown as GatewayClientLike),
      store: {
        getSession: () => session,
        getAgent: () => ({ model: session.modelRef }),
        updateSession: vi.fn((_id: string, updates: { modelRef?: string }) => {
          if (updates.modelRef) session.modelRef = updates.modelRef;
        }),
      } as unknown as CoworkStore,
    });

    const read = rpc.getModel('session-1');
    const patch = rpc.patchModel('session-1', 'openai/gpt-5');
    await Promise.resolve();
    expect(request).not.toHaveBeenCalledWith('sessions.patch', expect.anything());

    releaseRead();
    await expect(read).resolves.toMatchObject({ ok: true, modelRef: 'openai/gpt-4o' });
    await expect(patch).resolves.toMatchObject({ ok: true, modelRef: 'openai/gpt-5' });
    expect(session.modelRef).toBe('openai/gpt-5');
  });

  test('rolls back an ambiguous patch rejection and returns the authoritative model', async () => {
    const session = { id: 'session-1', agentId: 'main', modelRef: 'local/cached' };
    let gatewayModelRef = 'openai/gpt-4o';
    let patchCount = 0;
    const request = vi.fn(async (method: string, params?: { model?: string }) => {
      if (method === 'sessions.patch' && params?.model) {
        gatewayModelRef = params.model;
        patchCount += 1;
        if (patchCount === 1) throw new Error('patch response timed out');
      }
      if (method === 'sessions.describe') {
        const [modelProvider, model] = gatewayModelRef.split('/', 2);
        return { session: { modelProvider, model } };
      }
      return {};
    });
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request } as unknown as GatewayClientLike),
      store: {
        getSession: () => session,
        getAgent: () => ({ model: session.modelRef }),
        updateSession: vi.fn((_id: string, updates: { modelRef?: string }) => {
          if (updates.modelRef) session.modelRef = updates.modelRef;
        }),
      } as unknown as CoworkStore,
    });

    await expect(rpc.patchModel('session-1', 'openai/gpt-5')).resolves.toEqual({
      ok: false,
      error: 'patch response timed out',
      modelRef: 'openai/gpt-4o',
      source: 'gateway',
    });
    expect(gatewayModelRef).toBe('openai/gpt-4o');
    expect(session.modelRef).toBe('openai/gpt-4o');
  });
});
