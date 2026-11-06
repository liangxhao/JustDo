import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine/cowork/coworkEngineRouter';
import type { GatewayClientLike } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import { createExternalAgentExecution } from './externalAgentExecution';
import { ExternalAgentStreamError } from './externalAgentTypes';

function fixture(progressTimeoutMs?: number) {
  const runtime = new EventEmitter();
  const identity: { sessionId: string; lifecycleRevision: string; activeRunIds?: string[] } = {
    sessionId: 'native',
    lifecycleRevision: 'incarnation',
    activeRunIds: ['run'],
  };
  const store = {
    getSession: vi.fn(() => ({
      id: 'local',
      agentId: 'main',
      cwd: '/workspace',
      permissionMode: 'ask',
    })),
    beginSessionRun: vi.fn(() => ({ id: 'timing' })),
    finishSessionRun: vi.fn(),
    updateSession: vi.fn(),
  };
  let describeSession = async () => ({ session: { ...identity } });
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'sessions.describe') return describeSession();
    if (method === 'agent' || method === 'agent.wait') return new Promise(() => {});
    return {};
  });
  const client = { request } as unknown as GatewayClientLike;
  const registerUnknownSessionRun = vi.fn();
  Object.assign(runtime, {
    getGatewayClient: () => client,
    ensureReady: async () => {},
    registerUnknownSessionRun,
  });
  const execute = createExternalAgentExecution(
    {
      getStore: () => store as unknown as CoworkStore,
      getRouter: () =>
        ({
          isSessionActive: () => false,
          prepareSession: async () => ({ sessionKey: 'key', gatewaySessionId: 'native' }),
        }) as unknown as CoworkEngineRouter,
      getRuntime: () => runtime as OpenClawRuntimeAdapter,
      ensureReady: async () => ({ phase: 'running' }),
    },
    { progressTimeoutMs },
  );
  const onEvent = vi.fn();
  const result = execute({
    sessionId: 'local',
    runId: 'run',
    message: 'test',
    signal: new AbortController().signal,
    onEvent,
  });
  const emit = (
    seq: number,
    stream: string,
    data: Record<string, unknown>,
    sessionId?: string,
    generation = 'generation',
  ) => {
    runtime.emit('gatewayEvent', {
      event: 'agent',
      payload: {
        runId: 'run',
        sessionKey: 'key',
        ...(sessionId ? { sessionId } : {}),
        lifecycleGeneration: generation,
        seq,
        stream,
        data,
      },
    });
  };
  const terminal = (seq = 20, sessionId: string | undefined = 'native') =>
    emit(
      seq,
      'lifecycle',
      {
        phase: 'end',
        executionSettled: true,
        terminalReply: { disposition: 'visible', text: 'Answer' },
      },
      sessionId,
    );
  const ready = () =>
    vi.waitFor(() => expect(request.mock.calls.some(([method]) => method === 'agent')).toBe(true));
  return {
    result,
    onEvent,
    request,
    store,
    identity,
    emit,
    terminal,
    ready,
    registerUnknownSessionRun,
    describeWith: (read: typeof describeSession) => {
      describeSession = read;
    },
  };
}

describe('external native progress admission', () => {
  it('uses an exact native start when a projected owner omits the active-run list', async () => {
    const f = fixture();
    await f.ready();
    delete f.identity.activeRunIds;
    f.emit(0, 'item', { phase: 'preparation' });
    f.emit(1, 'lifecycle', { phase: 'start' }, 'native');
    f.emit(2, 'assistant', { text: 'Live text' });
    f.emit(3, 'tool', {
      phase: 'start',
      name: 'tool_call',
      toolCallId: 'outer',
      args: { id: 'external_mcp' },
    });
    f.emit(4, 'tool', {
      phase: 'start',
      name: 'external_mcp',
      toolCallId: 'inner',
      parentToolCallId: 'outer',
      args: { action: 'list' },
    });
    await vi.waitFor(() => expect(f.onEvent).toHaveBeenCalledTimes(4));
    expect(f.onEvent.mock.calls.map(([event]) => [event.agentSeq, event.sessionId])).toEqual([
      [1, 'native'],
      [2, 'native'],
      [3, 'native'],
      [4, 'native'],
    ]);
    f.terminal();
    await expect(f.result).resolves.toBe('Answer');
  });

  it('restores missing native IDs for live assistant and nested MCP progress through the exact run proof', async () => {
    const f = fixture();
    await f.ready();
    f.emit(1, 'assistant', { text: 'Live text' });
    f.emit(2, 'tool', {
      phase: 'start',
      name: 'tool_call',
      toolCallId: 'outer',
      args: { id: 'external_mcp' },
    });
    f.emit(3, 'tool', {
      phase: 'start',
      name: 'external_mcp',
      toolCallId: 'inner',
      parentToolCallId: 'outer',
      args: { action: 'list' },
    });
    f.emit(4, 'tool', {
      phase: 'result',
      name: 'external_mcp',
      toolCallId: 'inner',
      parentToolCallId: 'outer',
      result: {},
    });
    await vi.waitFor(() => expect(f.onEvent).toHaveBeenCalledTimes(4));
    expect(f.onEvent.mock.calls.map(([event]) => [event.agentSeq, event.sessionId])).toEqual([
      [1, 'native'],
      [2, 'native'],
      [3, 'native'],
      [4, 'native'],
    ]);
    expect(f.onEvent.mock.calls[2][0].data.args).toEqual({ action: 'list' });
    f.terminal();
    await expect(f.result).resolves.toBe('Answer');
  });

  it('drains earlier verified progress after an exact terminal clears the live-run list', async () => {
    const f = fixture();
    await f.ready();
    let resolveProof!: (value: { session: typeof f.identity }) => void;
    let first = true;
    f.describeWith(() => {
      if (first) {
        first = false;
        return new Promise(resolve => {
          resolveProof = resolve;
        });
      }
      return Promise.resolve({ session: { ...f.identity } });
    });
    f.emit(1, 'assistant', { text: 'Before terminal' });
    await vi.waitFor(() => expect(resolveProof).toBeTypeOf('function'));
    f.identity.activeRunIds = [];
    f.terminal(2);
    resolveProof({ session: { ...f.identity } });
    await expect(f.result).resolves.toBe('Answer');
    expect(f.onEvent.mock.calls.map(([event]) => event.agentSeq)).toEqual([1, 2]);
    expect(f.registerUnknownSessionRun).not.toHaveBeenCalled();
  });

  it('rejects missing-SID progress without an active run proof while retaining the exact completed outcome', async () => {
    const f = fixture();
    const rejected = expect(f.result).rejects.toBeInstanceOf(ExternalAgentStreamError);
    await f.ready();
    f.identity.activeRunIds = ['different-run'];
    f.emit(1, 'tool', {
      phase: 'start',
      name: 'external_mcp',
      toolCallId: 'inner',
      args: { action: 'call' },
    });
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(true),
    );
    f.terminal();
    await rejected;
    expect(f.onEvent).not.toHaveBeenCalled();
    expect(f.store.finishSessionRun).toHaveBeenCalledWith(
      'timing',
      'completed',
      expect.any(Number),
    );
    expect(f.registerUnknownSessionRun).not.toHaveBeenCalled();
    expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
  });

  it('never fills in a missing terminal identity or overwrites an explicit conflicting identity', async () => {
    const f = fixture();
    let settled = false;
    void f.result.then(() => {
      settled = true;
    });
    await f.ready();
    f.emit(1, 'assistant', { text: 'Wrong native session' }, 'other-native');
    f.emit(2, 'lifecycle', { phase: 'end', executionSettled: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(f.onEvent).not.toHaveBeenCalled();
    f.terminal();
    await expect(f.result).resolves.toBe('Answer');
    expect(f.onEvent.mock.calls.map(([event]) => event.agentSeq)).toEqual([20]);
  });

  it('settles an exact terminal while progress verification hangs, then reports a bounded output failure', async () => {
    const f = fixture(100);
    let returned = false;
    const rejected = expect(
      f.result.finally(() => {
        returned = true;
      }),
    ).rejects.toBeInstanceOf(ExternalAgentStreamError);
    await f.ready();
    let proofStarted = false;
    f.describeWith(() => {
      if (!proofStarted) {
        proofStarted = true;
        return new Promise(() => {});
      }
      return Promise.resolve({ session: { ...f.identity } });
    });
    f.emit(1, 'assistant', { text: 'Unverified progress' });
    await vi.waitFor(() => expect(proofStarted).toBe(true), { interval: 1 });
    f.terminal(2);
    await vi.waitFor(
      () =>
        expect(f.store.finishSessionRun).toHaveBeenCalledWith(
          'timing',
          'completed',
          expect.any(Number),
        ),
      { interval: 1 },
    );
    expect(returned).toBe(false);
    await rejected;
    expect(f.onEvent).not.toHaveBeenCalled();
    expect(f.registerUnknownSessionRun).not.toHaveBeenCalled();
    expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
  });

  it.each([
    { sequence: 1, generation: 'unproven-generation' },
    { sequence: 1000, generation: 'generation' },
  ])(
    'keeps unverified progress $sequence/$generation out of the terminal control frontier',
    async ({ sequence, generation }) => {
      const f = fixture();
      const rejected = expect(f.result).rejects.toBeInstanceOf(ExternalAgentStreamError);
      await f.ready();
      f.identity.activeRunIds = ['other-run'];
      f.emit(sequence, 'assistant', { text: 'Unproven' }, undefined, generation);
      await vi.waitFor(() =>
        expect(f.request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(true),
      );
      f.terminal(2);
      await rejected;
      expect(f.store.finishSessionRun).toHaveBeenCalledWith(
        'timing',
        'completed',
        expect.any(Number),
      );
      expect(f.registerUnknownSessionRun).not.toHaveBeenCalled();
      expect(f.onEvent).not.toHaveBeenCalled();
      expect(f.request.mock.calls.filter(([method]) => method === 'agent')).toHaveLength(1);
    },
  );

  it.each(['missing start ID', 'conflicting start ID', 'progress before start'])(
    'does not infer a run certificate from %s',
    async kind => {
      const f = fixture();
      const rejected = expect(f.result).rejects.toBeInstanceOf(ExternalAgentStreamError);
      await f.ready();
      delete f.identity.activeRunIds;
      if (kind === 'progress before start') {
        f.emit(0, 'assistant', { text: 'Unbound progress' });
        f.emit(1, 'lifecycle', { phase: 'start' }, 'native');
      } else {
        f.emit(
          0,
          'lifecycle',
          { phase: 'start' },
          kind === 'missing start ID' ? undefined : 'other',
        );
        f.emit(1, 'assistant', { text: 'Unbound progress' });
      }
      await vi.waitFor(() =>
        expect(f.request.mock.calls.some(([method]) => method === 'sessions.abort')).toBe(true),
      );
      f.terminal();
      await rejected;
      expect(f.store.finishSessionRun).toHaveBeenCalledWith(
        'timing',
        'completed',
        expect.any(Number),
      );
      expect(f.onEvent).not.toHaveBeenCalled();
    },
  );

  it('rejects progress beyond an exact terminal even when the activity snapshot still lists the run', async () => {
    const f = fixture();
    const rejected = expect(f.result).rejects.toBeInstanceOf(ExternalAgentStreamError);
    await f.ready();
    f.emit(1, 'lifecycle', { phase: 'start' }, 'native');
    f.terminal(2);
    f.emit(3, 'assistant', { text: 'After terminal' });
    await rejected;
    expect(f.store.finishSessionRun).toHaveBeenCalledWith(
      'timing',
      'completed',
      expect.any(Number),
    );
    expect(f.onEvent).not.toHaveBeenCalled();
  });
});
