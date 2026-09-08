import { describe, expect, test, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import { SessionRpc } from './sessionRpc';
import type { GatewayClientLike } from './types';

const sentRequestTimeout = (message = 'request timeout') =>
  Object.assign(new Error(message), { code: 'CLIENT_TIMEOUT', requestSent: true });

const createHarness = () => {
  const session = { id: 'session-1', agentId: 'main', modelRef: 'openai/gpt-4o' };
  let gatewayModelRef = 'openai/gpt-4o';
  const updateSession = vi.fn((_id: string, updates: { modelRef?: string }) => {
    if (updates.modelRef) session.modelRef = updates.modelRef;
  });
  const request = vi.fn((method: string, params?: { model?: string }) => {
    if (method === 'sessions.patch' && params?.model) {
      gatewayModelRef = params.model;
      return Promise.resolve({ resolved: { model: gatewayModelRef } });
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
  test.each([
    Object.assign(new Error('model selection locked'), { gatewayCode: 'INVALID_REQUEST' }),
    Object.assign(new Error('request timeout'), { code: 'CLIENT_TIMEOUT', requestSent: false }),
    new Error('invalid local request'),
  ])('does not confirm an unchanged identity after a definite failure: %s', async failure => {
    const { rpc, request, updateSession } = createHarness();
    request.mockImplementation(async method => {
      if (method === 'sessions.patch') throw failure;
      return { session: { modelProvider: 'openai', model: 'gpt-4o' } };
    });

    await expect(rpc.patchModel('session-1', 'openai/gpt-4o')).resolves.toMatchObject({
      ok: false,
      error: failure.message,
    });
    expect(updateSession).not.toHaveBeenCalled();
  });

  test('recovers a disconnected response when the selected identity confirms the request', async () => {
    const { rpc, request, session } = createHarness();
    request.mockImplementation(async method => {
      if (method === 'sessions.patch') throw new Error('gateway closed (1006): lost connection');
      return { session: { modelProvider: 'openai', model: 'gpt-5' } };
    });

    await expect(rpc.patchModel('session-1', 'openai/gpt-5')).resolves.toMatchObject({
      ok: true,
      modelRef: 'openai/gpt-5',
    });
    expect(session.modelRef).toBe('openai/gpt-5');
  });

  test.each([
    ['openai/gpt-5', 'openai', 'gpt-5'],
    ['builtin_models/hdp/Glm-5.1', 'hdp', 'Glm-5.1'],
  ])('recovers a lost patch response after confirming %s', async (requested, provider, model) => {
    const { rpc, request, session } = createHarness();
    request.mockImplementation(async method => {
      if (method === 'sessions.patch') throw sentRequestTimeout();
      return { session: { modelProvider: provider, model } };
    });

    const update = rpc.patchModel('session-1', requested, undefined, 'subsequent-calls');
    const barrier = rpc.waitForModelUpdate('session-1');

    await expect(update).resolves.toEqual({
      ok: true,
      modelRef: `${provider}/${model}`,
      appliesTo: 'subsequent-calls',
      source: 'gateway',
    });
    await expect(barrier).resolves.toBeUndefined();
    expect(session.modelRef).toBe(`${provider}/${model}`);
  });

  test.each(['builtin_models/hdp/Other', 'custom-provider/hdp/Glm-5.1'])(
    'does not recover %s from a different selected route',
    async requested => {
      const { rpc, request, session, updateSession } = createHarness();
      request.mockImplementation(async method => {
        if (method === 'sessions.patch') throw sentRequestTimeout();
        return { session: { modelProvider: 'hdp', model: 'Glm-5.1' } };
      });

      await expect(rpc.patchModel('session-1', requested)).resolves.toMatchObject({
        ok: false,
        error: 'request timeout',
        modelRef: 'hdp/Glm-5.1',
      });
      expect(session.modelRef).toBe('openai/gpt-4o');
      expect(updateSession).not.toHaveBeenCalled();
    },
  );

  test('rejects a waiting send when Gateway rejects the switch', async () => {
    const { rpc, request } = createHarness();
    request.mockRejectedValue(new Error('model unavailable'));
    const update = rpc.patchModel('session-1', 'openai/gpt-5');
    const barrier = expect(rpc.waitForModelUpdate('session-1')).rejects.toThrow(
      'model unavailable',
    );
    await expect(update).resolves.toMatchObject({ ok: false, error: 'model unavailable' });
    await barrier;
  });

  test('does not confirm a successful transport response with no resolved model', async () => {
    const { rpc, request, updateSession } = createHarness();
    request.mockResolvedValue({});
    await expect(rpc.patchModel('session-1', 'openai/gpt-5')).resolves.toMatchObject({
      ok: false,
      error: 'sessions.patch returned no resolved model',
    });
    expect(updateSession).not.toHaveBeenCalled();
  });

  test('uses the mutation result instead of stale entry execution metadata', async () => {
    const { rpc, request, session } = createHarness();
    request.mockResolvedValue({
      entry: { modelProvider: 'old-provider', model: 'old-model' },
      resolved: { modelProvider: 'custom-provider', model: 'vendor/new-model' },
    });
    await expect(rpc.patchModel('session-1', 'custom-provider/alias')).resolves.toMatchObject({
      ok: true,
      modelRef: 'custom-provider/vendor/new-model',
    });
    expect(session.modelRef).toBe('custom-provider/vendor/new-model');
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('patches and persists the selected model without rejecting stale runtime reads', async () => {
    const { rpc, request, session } = createHarness();

    await expect(
      rpc.patchModel('session-1', 'anthropic/claude-sonnet-4', undefined, 'subsequent-calls'),
    ).resolves.toEqual({
      ok: true,
      modelRef: 'anthropic/claude-sonnet-4',
      appliesTo: 'subsequent-calls',
      source: 'gateway',
    });

    expect(request).toHaveBeenNthCalledWith(1, 'sessions.patch', {
      key: 'agent:main:justdo:session-1',
      model: 'anthropic/claude-sonnet-4',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(session.modelRef).toBe('anthropic/claude-sonnet-4');
  });

  test('accepts the built-in provider alias returned by Gateway', async () => {
    const { rpc, request, session } = createHarness();
    let patchModel = '';
    request.mockImplementation(async (method: string, params?: { model?: string }) => {
      if (method === 'sessions.patch') {
        patchModel = params?.model ?? '';
        return { resolved: { modelProvider: 'hdp', model: 'Glm-5.1' } };
      }
      if (method === 'sessions.describe') {
        return {
          session: patchModel
            ? { modelProvider: 'hdp', model: 'Glm-5.1' }
            : { modelProvider: 'openai', model: 'gpt-4o' },
        };
      }
      return {};
    });

    await expect(rpc.patchModel('session-1', 'builtin_models/hdp/Glm-5.1')).resolves.toMatchObject({
      ok: true,
      modelRef: 'hdp/Glm-5.1',
    });
    expect(request).toHaveBeenCalledWith('sessions.patch', {
      key: 'agent:main:justdo:session-1',
      model: 'builtin_models/hdp/Glm-5.1',
    });
    expect(session.modelRef).toBe('hdp/Glm-5.1');
  });

  test('reads the selected identity from the public session row without fetching transcripts', async () => {
    const session = { id: 'session-1', agentId: 'main', modelRef: 'openai/gpt-4o' };
    const request = vi.fn(async (method: string) =>
      method === 'sessions.describe'
        ? {
            session: {
              modelProvider: 'openai',
              model: 'gpt-5',
              activeModelProvider: 'builtin_models',
              activeModel: 'deepseek-v4-pro',
            },
          }
        : {},
    );
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request }) as unknown as GatewayClientLike,
      store: {
        getSession: () => session,
        getAgent: () => ({ model: session.modelRef }),
        updateSession: vi.fn((_id: string, updates: { modelRef?: string }) => {
          if (updates.modelRef) session.modelRef = updates.modelRef;
        }),
      } as unknown as CoworkStore,
    });

    await expect(rpc.getModel('session-1')).resolves.toMatchObject({
      ok: true,
      modelRef: 'openai/gpt-5',
      source: 'gateway',
    });
    expect(session.modelRef).toBe('openai/gpt-4o');
    expect(request).not.toHaveBeenCalledWith('sessions.get', expect.anything());
  });

  test('does not persist a runtime fallback reported by Gateway as the user selection', async () => {
    const session = { id: 'session-1', agentId: 'main', modelRef: 'openai/gpt-5' };
    const updateSession = vi.fn();
    const request = vi.fn(async (method: string) =>
      method === 'sessions.describe'
        ? {
            session: {
              modelProvider: 'openai',
              model: 'gpt-5',
              activeModelProvider: 'anthropic',
              activeModel: 'claude-sonnet-4',
            },
          }
        : {},
    );
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request }) as unknown as GatewayClientLike,
      store: {
        getSession: () => session,
        getAgent: () => ({ model: session.modelRef }),
        updateSession,
      } as unknown as CoworkStore,
    });

    await expect(rpc.getModel('session-1')).resolves.toMatchObject({
      ok: true,
      modelRef: 'openai/gpt-5',
      source: 'gateway',
    });
    expect(updateSession).not.toHaveBeenCalled();
    expect(session.modelRef).toBe('openai/gpt-5');
  });

  test('accepts a patch even when the immediate runtime read would be stale', async () => {
    const session = { id: 'session-1', agentId: 'main', modelRef: 'openai/gpt-4o' };
    let describeCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'sessions.describe') {
        describeCount += 1;
        return describeCount === 2
          ? { session: { modelProvider: 'anthropic', model: 'claude-sonnet-4' } }
          : { session: { modelProvider: 'openai', model: 'gpt-4o' } };
      }
      return { resolved: { model: 'openai/gpt-5' } };
    });
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request }) as unknown as GatewayClientLike,
      store: {
        getSession: () => session,
        getAgent: () => ({ model: session.modelRef }),
        updateSession: vi.fn((_id: string, updates: { modelRef?: string }) => {
          if (updates.modelRef) session.modelRef = updates.modelRef;
        }),
      } as unknown as CoworkStore,
    });

    await expect(rpc.patchModel('session-1', 'openai/gpt-5')).resolves.toEqual({
      ok: true,
      modelRef: 'openai/gpt-5',
      appliesTo: 'next-turn',
      source: 'gateway',
    });
    expect(session.modelRef).toBe('openai/gpt-5');
    expect(request).toHaveBeenCalledWith('sessions.patch', {
      key: 'agent:main:justdo:session-1',
      model: 'openai/gpt-5',
    });
  });

  test('blocks a concurrent turn until Gateway confirms the model application', async () => {
    let releasePatch!: () => void;
    const patchPending = new Promise<void>(resolve => {
      releasePatch = resolve;
    });
    const session = { id: 'session-1', agentId: 'main', modelRef: 'openai/gpt-4o' };
    const request = vi.fn(async (method: string) => {
      if (method === 'sessions.patch') {
        await patchPending;
        return { resolved: { modelProvider: 'openai', model: 'gpt-5' } };
      }
      if (method === 'sessions.describe') {
        return { session: { modelProvider: 'openai', model: 'gpt-4o' } };
      }
      return {};
    });
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request }) as unknown as GatewayClientLike,
      store: {
        getSession: () => session,
        getAgent: () => ({ model: session.modelRef }),
        updateSession: vi.fn(),
      } as unknown as CoworkStore,
    });

    const update = rpc.patchModel('session-1', 'openai/gpt-5');
    const barrier = rpc.waitForModelUpdate('session-1');
    releasePatch();

    await expect(update).resolves.toMatchObject({
      ok: true,
      modelRef: 'openai/gpt-5',
      appliesTo: 'next-turn',
      source: 'gateway',
    });
    await expect(barrier).resolves.toBeUndefined();
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
      if (method === 'sessions.patch' && params?.model) {
        gatewayModelRef = params.model;
        return { resolved: { model: gatewayModelRef } };
      }
      return {};
    });
    const session = { id: 'session-1', agentId: 'main', modelRef: 'openai/gpt-4o' };
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request }) as unknown as GatewayClientLike,
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

  test('confirms an ambiguous patch response when the current Gateway model matches', async () => {
    const session = { id: 'session-1', agentId: 'main', modelRef: 'local/cached' };
    let gatewayModelRef = 'openai/gpt-4o';
    let patchCount = 0;
    const request = vi.fn(async (method: string, params?: { model?: string }) => {
      if (method === 'sessions.patch' && params?.model) {
        gatewayModelRef = params.model;
        patchCount += 1;
        if (patchCount === 1) throw sentRequestTimeout('patch response timed out');
      }
      if (method === 'sessions.describe') {
        const [modelProvider, model] = gatewayModelRef.split('/', 2);
        return { session: { modelProvider, model } };
      }
      return {};
    });
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request }) as unknown as GatewayClientLike,
      store: {
        getSession: () => session,
        getAgent: () => ({ model: session.modelRef }),
        updateSession: vi.fn((_id: string, updates: { modelRef?: string }) => {
          if (updates.modelRef) session.modelRef = updates.modelRef;
        }),
      } as unknown as CoworkStore,
    });

    await expect(rpc.patchModel('session-1', 'openai/gpt-5')).resolves.toEqual({
      ok: true,
      appliesTo: 'next-turn',
      modelRef: 'openai/gpt-5',
      source: 'gateway',
    });
    expect(gatewayModelRef).toBe('openai/gpt-5');
    expect(session.modelRef).toBe('openai/gpt-5');
  });

  test('does not replace the user selection when a failed patch reads another model', async () => {
    const session = { id: 'session-1', agentId: 'main', modelRef: 'openai/gpt-4o' };
    const updateSession = vi.fn();
    const request = vi.fn(async (method: string) => {
      if (method === 'sessions.patch') throw new Error('patch failed');
      if (method === 'sessions.describe') {
        return {
          session: {
            modelProvider: 'anthropic',
            model: 'claude-sonnet-4',
            providerOverride: 'anthropic',
            modelOverride: 'claude-sonnet-4',
            modelOverrideSource: 'auto',
          },
        };
      }
      return {};
    });
    const rpc = new SessionRpc({
      getGatewayClient: () => ({ request }) as unknown as GatewayClientLike,
      store: {
        getSession: () => session,
        getAgent: () => ({ model: session.modelRef }),
        updateSession,
      } as unknown as CoworkStore,
    });

    await expect(rpc.patchModel('session-1', 'openai/gpt-5')).resolves.toMatchObject({
      ok: false,
      modelRef: 'anthropic/claude-sonnet-4',
    });
    expect(updateSession).not.toHaveBeenCalled();
    expect(session.modelRef).toBe('openai/gpt-4o');
  });
});
