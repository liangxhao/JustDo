import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { CoworkSessionSource } from '../../../shared/cowork/sessionSource';
import { BrowserExtensionChatController } from './browserExtensionChatController';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
};

describe('browser conversation authority', () => {
  it.each([
    { name: 'desktop', source: 'desktop' },
    { name: 'CLI', external: { origin: 'cli' } },
    { name: 'missing source' },
  ])('rejects $name sessions at every controller entry before native work', async extra => {
    const row = { id: 'foreign', cwd: process.cwd(), agentId: 'main', ...extra };
    const native = vi.fn();
    const store = {
      // A forged summary must not override the actual product row's source.
      listSessions: () => [{ id: row.id, source: CoworkSessionSource.BrowserExtension }],
      getSession: () => row,
      getSessionRunByClientTurnId: native,
    };
    const controller = new BrowserExtensionChatController({
      getStore: () => store as never,
      getRuntime: native,
      getRouter: native,
      ensureEngineRunning: native,
      readAssistantMedia: native,
    });
    expect(controller.listSessions()).toEqual([]);
    for (const read of [
      () => controller.getMessages(row.id),
      () => controller.readManagedImage(row.id, 'media://private'),
      () => controller.subscribeThreadEvents(row.id, vi.fn()),
      () => controller.getComposerOptions(row.id),
      () => controller.getTurnState(row.id, 'turn'),
      () => controller.getThreadRuntimeStatus(row.id),
      () => controller.interruptThread(row.id, 'turn'),
    ])
      await expect(read()).rejects.toThrow('Conversation not found.');
    expect(() => controller.consumeTurnError(row.id, 'turn')).toThrow('Conversation not found.');
    await expect(
      controller.sendMessage({ sessionId: row.id, message: 'Do not send' }),
    ).rejects.toMatchObject({ requestSent: false });
    expect(native).not.toHaveBeenCalled();
  });

  it('reads source from the product row rather than trusting a list summary', () => {
    const rows = [
      { id: 'browser', source: CoworkSessionSource.BrowserExtension },
      { id: 'desktop' },
    ];
    const controller = new BrowserExtensionChatController({
      getStore: () =>
        ({
          listSessions: () => rows.map(row => ({ id: row.id })),
          getSession: (id: string) => rows.find(row => row.id === id),
        }) as never,
      getRuntime: vi.fn(),
      getRouter: vi.fn(),
      ensureEngineRunning: vi.fn(),
    });
    expect(controller.listSessions().map(row => row.id)).toEqual(['browser']);
  });

  it.each(['history', 'image', 'composer', 'runtime status', 'turn receipt'])(
    'rejects a late %s result after the row loses its browser source',
    async operation => {
      const row: { id: string; source?: string } = {
        id: 'one',
        source: CoworkSessionSource.BrowserExtension,
      };
      const gate = deferred<Record<string, unknown>>();
      const pending = vi.fn(() => gate.promise);
      const finishSessionRun = vi.fn();
      const timing = {
        id: 'timing',
        sessionId: 'one',
        clientTurnId: 'turn',
        rootRunId: 'run',
        state: 'running',
      };
      const client = { request: pending };
      const runtime = {
        ensureReady: async () => {},
        getSessionKeysForSession: () => ['key'],
        getGatewayClient: () => client,
        getGatewayClientGeneration: () => 1,
        getRunTerminalReceipt: () => ({
          executionSettled: true,
          runId: 'run',
          sessionKey: 'key',
          sessionId: 'native',
          lifecycleGeneration: 'generation',
          clientGeneration: 1,
          agentSeq: 2,
        }),
        fetchSessionHistoryByKey: pending,
        requestGateway: pending,
      };
      const controller = new BrowserExtensionChatController({
        getStore: () =>
          ({
            getSession: () => row,
            getSessionRunByClientTurnId: () => timing,
            finishSessionRun,
            listAgents: () => [],
            getConfig: () => ({ permissionMode: 'ask' }),
          }) as never,
        getRuntime: () => runtime as never,
        getRouter: () =>
          ({ isSessionActive: () => false, getSessionRuntimeStatus: pending }) as never,
        ensureEngineRunning: vi.fn(),
        readAssistantMedia: pending,
      });
      const running =
        operation === 'history'
          ? controller.getMessages(row.id)
          : operation === 'image'
            ? controller.readManagedImage(row.id, 'media://private')
            : operation === 'composer'
              ? controller.getComposerOptions(row.id)
              : operation === 'runtime status'
                ? controller.getThreadRuntimeStatus(row.id)
                : controller.getTurnState(row.id, 'turn');
      const rejected = expect(running).rejects.toThrow('Conversation not found.');
      await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce());
      delete row.source;
      gate.resolve({
        messages: [],
        session: { sessionId: 'native' },
        models: [],
        known: true,
        running: false,
        success: true,
        dataUrl: 'private',
      });
      await rejected;
      expect(finishSessionRun).not.toHaveBeenCalled();
    },
  );

  it('does not send after ownership changes during native preparation', async () => {
    const row: {
      id: string;
      source?: string;
      cwd: string;
      agentId: string;
      permissionMode: string;
    } = {
      id: 'one',
      source: CoworkSessionSource.BrowserExtension,
      cwd: process.cwd(),
      agentId: 'main',
      permissionMode: 'ask',
    };
    const gate = deferred<{ sessionKey: string; gatewaySessionId: string }>();
    const prepareSession = vi.fn(() => gate.promise);
    const startSession = vi.fn();
    const beginSessionRun = vi.fn();
    const controller = new BrowserExtensionChatController({
      getStore: () => ({ getSession: () => row, beginSessionRun }) as never,
      getRuntime: () => null,
      getRouter: () => ({ isSessionActive: () => false, prepareSession, startSession }) as never,
      ensureEngineRunning: async () => ({ phase: 'running' }) as never,
    });
    const running = controller.sendMessage({ sessionId: row.id, message: 'Do not send' });
    const rejected = expect(running).rejects.toMatchObject({ requestSent: false });
    await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledOnce());
    delete row.source;
    gate.resolve({ sessionKey: 'key', gatewaySessionId: 'native' });
    await rejected;
    expect(startSession).not.toHaveBeenCalled();
    expect(beginSessionRun).not.toHaveBeenCalled();
  });

  it('stops forwarding an existing subscription after the source is revoked', async () => {
    const row: { id: string; source?: string } = {
      id: 'one',
      source: CoworkSessionSource.BrowserExtension,
    };
    const runtime = Object.assign(new EventEmitter(), {
      ensureReady: async () => {},
      getSessionKeysForSession: () => ['key'],
      requestGateway: vi.fn(async () => ({})),
    });
    const controller = new BrowserExtensionChatController({
      getStore: () => ({ getSession: () => row }) as never,
      getRuntime: () => runtime as never,
      getRouter: vi.fn(),
      ensureEngineRunning: vi.fn(),
    });
    const listener = vi.fn();
    const dispose = await controller.subscribeThreadEvents(row.id, listener);
    delete row.source;
    runtime.emit('gatewayEvent', {
      event: 'agent',
      payload: {
        seq: 1,
        sessionKey: 'key',
        runId: 'run',
        stream: 'assistant',
        data: { text: 'private' },
      },
    });
    runtime.emit('gatewayReady');
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    expect(runtime.requestGateway).toHaveBeenCalledTimes(1);
    dispose();
    expect(runtime.listenerCount('gatewayEvent')).toBe(0);
  });

  it('cleans a late subscription acknowledgement after its row loses browser ownership', async () => {
    const row: { id: string; source?: string } = {
      id: 'one',
      source: CoworkSessionSource.BrowserExtension,
    };
    const gate = deferred<object>();
    const requestGateway = vi.fn(async (method: string) =>
      method === 'sessions.messages.subscribe' ? gate.promise : {},
    );
    const runtime = Object.assign(new EventEmitter(), {
      ensureReady: async () => {},
      getSessionKeysForSession: () => ['key'],
      requestGateway,
    });
    const controller = new BrowserExtensionChatController({
      getStore: () => ({ getSession: () => row }) as never,
      getRuntime: () => runtime as never,
      getRouter: vi.fn(),
      ensureEngineRunning: vi.fn(),
    });
    const running = controller.subscribeThreadEvents(row.id, vi.fn());
    const rejected = expect(running).rejects.toThrow('Conversation not found.');
    await vi.waitFor(() => expect(requestGateway).toHaveBeenCalledOnce());
    delete row.source;
    gate.resolve({});
    await rejected;
    expect(runtime.listenerCount('gatewayEvent')).toBe(0);
    expect(runtime.listenerCount('gatewayReady')).toBe(0);
    expect(requestGateway).toHaveBeenCalledWith('sessions.messages.unsubscribe', { key: 'key' });
  });
});
