import { EventEmitter } from 'node:events';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { AutomaticErrorRetryDisposition, AutomaticErrorRetryPhase } from '../../shared/cowork/automaticErrorRetry';
import type { SessionRunTiming } from '../../shared/cowork/sessionRun';
import { CoworkSessionSource } from '../../shared/cowork/sessionSource';
import { projectCodexHistory } from '../clients/appServer/protocol/appServerHistory';
import { ChromeExtensionChatController } from './chromeExtensionChatController';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
};

function fixture() {
  const row = {
    id: 'browser-thread', source: CoworkSessionSource.ChromeExtension as string,
    agentId: 'main', cwd: process.cwd(), title: 'Browser thread', status: 'idle',
    createdAt: 1_000, updatedAt: 2_000, modelRef: 'provider/model', permissionMode: 'ask',
    nativeSessionKey: 'native-key',
  };
  const runs: SessionRunTiming[] = [{
    id: 'private-receipt', sessionId: row.id, clientTurnId: 'logical-turn', rootRunId: 'native-run',
    startedAt: 1_000, endedAt: 2_000, state: 'completed',
  }];
  const messages = [{ role: 'user', content: 'Native input', idempotencyKey: 'logical-turn:user' }];
  const request = vi.fn(async () => ({ session: {
    key: row.nativeSessionKey, sessionId: 'private-physical', lifecycleRevision: 'private-revision',
  } }));
  const client = { request };
  let generation = 1;
  const runtime = Object.assign(new EventEmitter(), {
    getGatewayClient: () => client,
    getGatewayClientGeneration: () => generation,
    getSessionKeysForSession: () => [row.nativeSessionKey],
    ensureReady: vi.fn(async () => {}),
    requestGateway: vi.fn(async () => ({})),
    getRunTerminalReceipt: vi.fn(),
    getAutomaticErrorRetryTurn: vi.fn(),
    fetchSessionHistoryByKey: vi.fn(async () => ({ sessionKey: row.nativeSessionKey, messages })),
  });
  const updateSession = vi.fn((_id: string, patch: object) => Object.assign(row, patch));
  const store = {
    getSession: () => row, getSessionRuns: () => runs, updateSession,
    getLatestSessionRun: () => runs.at(-1),
    getSessionRunByClientTurnId: (turnId: string) => runs.find(run => run.clientTurnId === turnId),
    finishSessionRun: vi.fn(),
    getConfig: () => ({ workingDirectory: process.cwd(), permissionMode: 'ask' }),
    createSession: vi.fn(),
  };
  const ensureEngineRunning = vi.fn();
  const onSessionsChanged = vi.fn();
  const controller = new ChromeExtensionChatController({
    getStore: () => store as never, getRuntime: () => runtime as never,
    getRouter: () => ({ isSessionActive: () => false }) as never,
    ensureEngineRunning, onSessionsChanged, getDefaultModelRef: () => 'provider/model',
  });
  return { controller, row, runs, messages, runtime, request, client, store, updateSession,
    ensureEngineRunning, onSessionsChanged, changeGeneration: () => { generation += 1; } };
}

describe('browser standard app-server data access', () => {
  it('reads raw authenticated native history with physical identity fences and no runtime startup', async () => {
    const f = fixture();

    const history = await f.controller.getHistory(f.row.id);

    expect(history).toMatchObject({ threadId: f.row.id, messages: f.messages, runs: f.runs });
    expect(history.identityRevision).toEqual(expect.any(String));
    expect(JSON.stringify(history)).not.toMatch(/private-physical|private-revision/);
    expect(f.runtime.fetchSessionHistoryByKey).toHaveBeenCalledExactlyOnceWith('native-key', undefined, {
      forceFullSnapshot: true, signal: expect.any(AbortSignal),
    });
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.ensureEngineRunning).not.toHaveBeenCalled();
    expect(f.runtime.ensureReady).not.toHaveBeenCalled();
  });

  it('rejects an old native snapshot if the product binding changes while its body is read', async () => {
    const f = fixture();
    const pending = deferred<{ sessionKey: string; messages: typeof f.messages }>();
    f.runtime.fetchSessionHistoryByKey.mockReturnValueOnce(pending.promise);
    const reading = f.controller.getHistory(f.row.id);
    const rejected = expect(reading).rejects.toThrow('identity changed');
    await vi.waitFor(() => expect(f.runtime.fetchSessionHistoryByKey).toHaveBeenCalledOnce());
    f.row.nativeSessionKey = 'replacement-key';
    pending.resolve({ sessionKey: 'native-key', messages: f.messages });
    await rejected;
  });

  it('does not promote persisted terminal timings without a matching whole-run receipt', async () => {
    const f = fixture();
    const unverified = await f.controller.getHistory(f.row.id);
    expect(unverified.unknownRunIds).toEqual(['logical-turn']);
    expect(projectCodexHistory(unverified).turns[0]).toMatchObject({
      status: 'failed', completedAt: null, error: { message: expect.stringMatching(/^EXECUTION_UNKNOWN:/) },
    });
    f.runtime.getRunTerminalReceipt.mockReturnValue({
      runId: 'native-run', sessionKey: 'native-key', sessionId: 'private-physical',
      clientGeneration: 1, executionSettled: true, status: 'completed', endedAt: 2_000,
    });
    const verified = await f.controller.getHistory(f.row.id);
    expect(verified.unknownRunIds).toEqual([]);
    expect(projectCodexHistory(verified).turns[0]).toMatchObject({ status: 'completed', completedAt: 2 });
  });

  it('keeps a completed logical turn settled from its successor after a new turn replaces the live chain', async () => {
    const f = fixture();
    const root = f.runs[0];
    const identity = {
      chainId: root.clientTurnId, maxContinuations: 1, sessionKey: f.row.nativeSessionKey,
      nativeSessionId: 'private-physical', lifecycleRevision: 'private-revision',
    };
    root.state = 'failed';
    root.automaticErrorRetry = { ...identity, attempt: 0, disposition: AutomaticErrorRetryDisposition.Superseded };
    f.runs.push({
      id: 'successor-receipt', sessionId: f.row.id, clientTurnId: 'successor-run', rootRunId: 'successor-run',
      state: 'completed', startedAt: 3_000, endedAt: 4_000,
      automaticErrorRetry: { ...identity, attempt: 1, predecessorRunId: 'native-run', disposition: AutomaticErrorRetryDisposition.Final },
    }, { id: 'new-user-receipt', sessionId: f.row.id, clientTurnId: 'new-user', startedAt: 5_000, state: 'running' });
    f.runtime.getRunTerminalReceipt.mockImplementation(runId => ({
      runId, sessionKey: identity.sessionKey, sessionId: identity.nativeSessionId, clientGeneration: 1,
      executionSettled: true, agentSeq: 15, endedAt: runId === 'successor-run' ? 4_000 : 2_000,
      status: runId === 'successor-run' ? 'completed' : 'failed',
    }));

    await expect(f.controller.getTurnState(f.row.id, root.clientTurnId)).resolves.toMatchObject({
      id: root.clientTurnId, nativeRunId: 'successor-run', retryAttempt: 1, status: 'completed', executionSettled: true,
    });
    f.changeGeneration();
    await expect(f.controller.getTurnState(f.row.id, root.clientTurnId)).resolves.toMatchObject({
      id: root.clientTurnId, status: 'unknown', executionSettled: false,
    });
  });

  it('returns true empty history for a new unbound thread without looking up runtime services', async () => {
    const getRuntime = vi.fn();
    const controller = new ChromeExtensionChatController({
      getStore: () => ({
        getSession: () => ({ id: 'new', source: CoworkSessionSource.ChromeExtension }),
        getSessionRuns: () => [],
      }) as never,
      getRuntime, getRouter: vi.fn(), ensureEngineRunning: vi.fn(),
    });

    await expect(controller.getHistory('new')).resolves.toEqual({ threadId: 'new', messages: [], runs: [] });
    expect(getRuntime).not.toHaveBeenCalled();
  });

  it('persists trimmed names and rejects another source before any metadata mutation', () => {
    const f = fixture();
    expect(f.controller.setThreadName(f.row.id, '  Renamed  ')).toMatchObject({ title: 'Renamed' });
    expect(f.onSessionsChanged).toHaveBeenCalledOnce();
    expect(() => f.controller.setThreadName(f.row.id, ' ')).toThrow('1 to 500');
    f.row.source = 'desktop';
    expect(() => f.controller.getThread(f.row.id)).toThrow('Conversation not found');
    expect(() => f.controller.setThreadName(f.row.id, 'Foreign')).toThrow('Conversation not found');
    expect(f.updateSession).toHaveBeenCalledTimes(1);
  });

  it('uses the real model catalog and rejects a replaced Gateway instead of advertising stored fallback models', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ models: [{ id: 'model', name: 'Configured', provider: 'provider' }] } as never);
    await expect(f.controller.getModels()).resolves.toEqual([
      { id: 'provider/model', name: 'provider/Configured', isDefault: true },
    ]);
    f.request.mockImplementationOnce(async () => {
      f.changeGeneration();
      return { models: [{ id: 'other', name: 'Stale', provider: 'provider' }] } as never;
    });
    await expect(f.controller.getModels()).rejects.toThrow('Gateway changed');
    expect(f.ensureEngineRunning).not.toHaveBeenCalled();
  });

  it('advertises image input only for the corresponding live native catalog entry', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ models: [
      { id: 'model', name: 'Configured', provider: 'provider', input: ['text', 'image'] },
      { id: 'plain', name: 'Plain', provider: 'provider' },
    ] } as never);
    await expect(f.controller.getModels()).resolves.toEqual([
      { id: 'provider/model', name: 'provider/Configured', isDefault: true, inputModalities: ['text', 'image'] },
      { id: 'provider/plain', name: 'provider/Plain', isDefault: false },
    ]);
  });

  it('validates explicit cwd after the asynchronous catalog read, before creating a thread', async () => {
    const f = fixture();
    let cwd = process.cwd();
    f.store.getConfig = () => ({ workingDirectory: cwd, permissionMode: 'ask' });
    const catalog = deferred<never>();
    f.request.mockReturnValueOnce(catalog.promise);
    const starting = f.controller.startThread('New', { cwd, model: 'provider/model' });
    const rejected = expect(starting).rejects.toMatchObject({ code: -32602 });
    cwd = path.dirname(cwd);
    catalog.resolve({ models: [{ id: 'model', name: 'Configured', provider: 'provider' }] } as never);
    await rejected;
    expect(f.store.createSession).not.toHaveBeenCalled();
  });

  it('stamps core stream events only with a captured physical identity and current client generation', async () => {
    const f = fixture();
    const binding = { runId: 'logical-turn', sessionKey: 'native-key', nativeSessionId: '', clientGeneration: 1 };
    (f.controller as unknown as { activeTurns: Map<string, typeof binding> }).activeTurns.set(f.row.id, binding);
    const listener = vi.fn();
    const dispose = await f.controller.subscribeThreadEvents(f.row.id, listener);
    const emit = (runId = 'native-run') => f.runtime.emit('gatewayEvent', { event: 'agent', payload: {
      sessionKey: 'native-key', runId, seq: 1, stream: 'assistant', data: { text: 'Visible output' },
    } });
    emit();
    expect(listener.mock.calls[0][0]).not.toHaveProperty('turnId');
    binding.nativeSessionId = 'private-physical';
    emit('logical-turn');
    expect(listener.mock.calls[1][0]).not.toHaveProperty('turnId');
    emit();
    expect(listener.mock.calls[2][0]).toMatchObject({ turnId: 'logical-turn', startedAt: 1_000 });
    f.changeGeneration();
    emit();
    expect(listener.mock.calls[3][0]).not.toHaveProperty('turnId');
    dispose();
  });

  it('withholds the native unscoped failure snapshot for the exact retry attempt before settlement', async () => {
    const f = fixture();
    const message = 'OpenClaw stopped this turn after 3 consecutive identical tool failures. Check the tool arguments or switch to a model with native tool calling before retrying.';
    const binding = {
      runId: 'logical-turn', physicalRunId: 'native-run', sessionKey: 'native-key',
      nativeSessionId: 'private-physical', clientGeneration: 1, lifecycleRevision: 'private-revision',
    };
    (f.controller as unknown as { activeTurns: Map<string, typeof binding> }).activeTurns.set(f.row.id, binding);
    const attempt = {
      runId: binding.physicalRunId, clientTurnId: binding.runId, chainId: binding.runId,
      attempt: 0, maxContinuations: 1, sessionKey: binding.sessionKey, nativeSessionId: binding.nativeSessionId,
      lifecycleRevision: binding.lifecycleRevision, disposition: AutomaticErrorRetryDisposition.Candidate,
    };
    f.runtime.getAutomaticErrorRetryTurn.mockReturnValue({ currentPhysicalRunId: binding.physicalRunId,
      presentation: { phase: AutomaticErrorRetryPhase.Eligible, runs: [attempt] } });
    const listener = vi.fn();
    const dispose = await f.controller.subscribeThreadEvents(f.row.id, listener);
    const emit = (seq: number, data: object) => f.runtime.emit('gatewayEvent', { event: 'agent', payload: {
      sessionKey: binding.sessionKey, runId: binding.physicalRunId, seq, stream: 'assistant', data,
    } });

    emit(40, { text: 'Existing work remains useful.', delta: 'Existing work remains useful.' });
    f.runtime.emit('gatewayEvent', { event: 'chat', payload: {
      sessionKey: binding.sessionKey, runId: binding.physicalRunId, seq: 42, state: 'delta',
      message: { role: 'assistant', content: [{ type: 'text', text: message }], timestamp: 2_000 },
    } });
    emit(42, { text: message, delta: message, itemId: 'native-message:4' });
    f.runtime.emit('gatewayEvent', { event: 'agent', payload: {
      sessionKey: binding.sessionKey, runId: binding.physicalRunId, seq: 43, stream: 'lifecycle',
      data: { phase: 'finishing', livenessState: 'blocked', error: message, endedAt: 2_000 },
    } });
    emit(44, { text: message, delta: message, assistantTextScope: { id: 'actual-model-text' } });
    emit(45, { text: message, delta: message, mediaUrls: ['safe-artifact.pdf'] });

    expect(listener.mock.calls.map(([value]) => value.event.agentSeq)).toEqual([40, 43, 44, 45]);
    expect(listener.mock.calls[1][0].event.data).toEqual({ phase: 'finishing', livenessState: 'blocked', endedAt: 2_000 });
    dispose();
  });
});
