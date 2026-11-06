import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChromeExtensionStreamEvent } from '../../shared/chrome/chromeExtensionStream';
import type {
  AppServerBinding,
  AppServerConnectionContext,
} from '../appServer/appServerProtocol';
import { AppServerNotificationMethod } from '../appServer/appServerProtocol';
import { ChromeAppServerHub } from './chromeAppServerBinding';
import { ChromeAppServerNotificationMethod } from './chromeAppServerProtocol';
import type { ChromeExtensionChatApi, ChromeExtensionTurnState } from './chromeAppServerTypes';

const hubs: ChromeAppServerHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  vi.useRealTimers();
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
};
const microtasks = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
};

function fixture() {
  vi.useFakeTimers();
  const thread = {
    id: 'one',
    title: 'Browser',
    cwd: '/workspace',
    permissionMode: 'ask' as const,
    modelRef: 'provider/default',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  };
  const turn = { id: '11111111-1111-4111-8111-111111111111', status: 'unknown' as const, executionSettled: false };
  const api: ChromeExtensionChatApi = {
    listSessions: vi.fn(() => [thread]),
    startThread: vi.fn(async () => thread),
    subscribeThreadEvents: vi.fn(async () => vi.fn()),
    getMessages: vi.fn(async () => [{ role: 'user', text: 'Input' }]),
    getComposerOptions: vi.fn(async () => ({ models: [], permissionMode: 'ask' })),
    getModels: vi.fn(async () => [{ id: 'provider/default', name: 'Default', isDefault: true }]),
    getThreadRuntimeStatus: vi.fn(async () => ({ known: true, running: true })),
    consumeTurnError: vi.fn(),
    getTurnState: vi.fn(async () => turn),
    sendMessage: vi.fn(async () => ({ sessionId: thread.id, runId: turn.id })),
    interruptThread: vi.fn(async () => {}),
  };
  const hub = new ChromeAppServerHub(api, 'test');
  hub.activate();
  hubs.push(hub);
  const connect = (request?: AppServerConnectionContext['request']) => {
    let closed = false;
    const notify = vi.fn();
    const context: AppServerConnectionContext = { isClosed: () => closed, notify, ...(request ? { request } : {}) };
    const binding = hub.connect(context);
    return {
      binding,
      notify,
      context,
      detach: async () => {
        closed = true;
        await binding.onDisconnect();
      },
    };
  };
  return { api, hub, turn, connect };
}

const pendingOperation = async (
  f: ReturnType<typeof fixture>,
  binding: AppServerBinding,
  kind: string,
) => {
  const gate = deferred<never>();
  let running: ReturnType<NonNullable<AppServerBinding['threads']['read']>>;
  if (kind === 'start') {
    vi.mocked(f.api.sendMessage).mockReturnValueOnce(gate.promise);
    running = binding.turns.start({ threadId: 'one', input: [{ type: 'text', text: 'Input' }], chrome: { clientTurnId: f.turn.id } });
  } else if (kind === 'read') {
    vi.mocked(f.api.getTurnState).mockReturnValueOnce(gate.promise);
    running = binding.threads.read!({ threadId: 'one', chrome: { turnId: f.turn.id } });
  } else {
    vi.mocked(f.api.interruptThread).mockReturnValueOnce(gate.promise);
    running = binding.turns.interrupt({ threadId: 'one', turnId: f.turn.id });
  }
  await microtasks();
  if (kind === 'start') expect(f.api.sendMessage).toHaveBeenCalledOnce();
  else if (kind === 'read') expect(f.api.getTurnState).toHaveBeenCalledOnce();
  else expect(f.api.interruptThread).toHaveBeenCalledOnce();
  return {
    running,
    release: () =>
      gate.resolve(
        (kind === 'start'
          ? { sessionId: 'one', runId: f.turn.id }
          : kind === 'read'
            ? f.turn
            : undefined) as never,
      ),
  };
};

describe('browser app-server observation lifecycle', () => {
  it('prepares standard image-only input and withdraws only its sender approval scope on unsubscribe', async () => {
    const f = fixture();
    Object.assign(f.api, { supportsClientApprovals: true });
    const peer = f.connect(vi.fn(async () => ({ decision: 'decline' })));
    const created = await peer.binding.threads.start({});
    expect(created).toHaveProperty('approvalPolicy', 'on-request');
    const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6tmAAAAAASUVORK5CYII=';
    await peer.binding.turns.start({
      threadId: 'one', input: [{ type: 'image', url }], chrome: { clientTurnId: f.turn.id },
    });
    const [sent, trusted] = vi.mocked(f.api.sendMessage).mock.calls[0];
    expect(sent.message).toBe('');
    expect(sent.attachments).toEqual([{ name: 'image-1.png', mimeType: 'image/png', base64Data: url.split(',')[1] }]);
    expect(trusted?.approvals?.context).toBe(peer.context);
    expect(trusted?.approvals?.signal.aborted).toBe(false);
    expect(trusted?.approvals?.scope).toBeDefined();
    trusted?.assertCurrent();
    await peer.binding.threads.unsubscribe!({ threadId: 'one' });
    expect(trusted?.approvals?.signal.aborted).toBe(true);
    expect(() => trusted?.assertCurrent()).toThrow('ownership changed');
    expect(f.api.interruptThread).not.toHaveBeenCalled();
  });

  it('preserves document-only browser input without adding text and keeps standard local paths disabled', async () => {
    const f = fixture();
    const peer = f.connect();
    const file = { name: 'note.txt', mimeType: 'text/plain', base64Data: 'bm90ZQ==' };
    await peer.binding.turns.start({ threadId: 'one', input: [], chrome: { attachments: [file], clientTurnId: f.turn.id } });
    expect(f.api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ message: '', attachments: [file] }),
      expect.objectContaining({ assertCurrent: expect.any(Function) }));
    vi.mocked(f.api.sendMessage).mockClear();
    for (const input of [[], [{ type: 'localImage', path: 'local.png' }], [{ type: 'text', text: 'a'.repeat(32_001) }]])
      await expect(peer.binding.turns.start({ threadId: 'one', input })).rejects.toMatchObject({ code: -32602, requestSent: false });
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['start', 'interrupt'])(
    'does not restart observation from a late %s receipt after full stop and reactivation',
    async kind => {
      const f = fixture();
      const old = f.connect();
      const pending = await pendingOperation(f, old.binding, kind);
      await old.detach();
      await f.hub.stop();
      const historyReads = vi.mocked(f.api.getMessages).mock.calls.length;
      f.hub.activate();
      const replacement = f.connect();
      pending.release();
      const result = await pending.running;
      await microtasks();
      if (kind === 'start')
        expect(result).toMatchObject({
          turn: { id: f.turn.id, status: 'inProgress' }, chrome: { activeTurn: { executionSettled: false } },
        });
      expect(f.api.getMessages).toHaveBeenCalledTimes(historyReads);
      expect(vi.getTimerCount()).toBe(0);
      expect(replacement.notify).not.toHaveBeenCalled();
      expect(old.notify).not.toHaveBeenCalled();
      expect(f.api.interruptThread).toHaveBeenCalledTimes(kind === 'interrupt' ? 1 : 0);
      expect(() => old.binding.threads.list!({})).toThrow('Connection closed.');
    },
  );

  it.each(['start', 'interrupt'])(
    'registers a late %s receipt while paused and resumes observation exactly once',
    async kind => {
      const f = fixture();
      const peer = f.connect();
      const pending = await pendingOperation(f, peer.binding, kind);
      await peer.detach();
      await f.hub.stop({ preserveActiveTurns: true });
      const historyReads = vi.mocked(f.api.getMessages).mock.calls.length;
      pending.release();
      await pending.running;
      await microtasks();
      expect(f.api.getMessages).toHaveBeenCalledTimes(historyReads);
      expect(vi.getTimerCount()).toBe(0);
      f.hub.activate();
      await microtasks();
      expect(f.api.getMessages).toHaveBeenCalledTimes(historyReads + 1);
      expect(vi.getTimerCount()).toBe(1);
      f.hub.activate();
      await microtasks();
      expect(f.api.getMessages).toHaveBeenCalledTimes(historyReads + 1);
      expect(vi.getTimerCount()).toBe(1);
      expect(peer.notify).not.toHaveBeenCalled();
    },
  );

  it('keeps observing an accepted turn after an ordinary peer detach without cancelling it', async () => {
    const f = fixture();
    const peer = f.connect();
    const pending = await pendingOperation(f, peer.binding, 'start');
    const historyReads = vi.mocked(f.api.getMessages).mock.calls.length;
    await peer.detach();
    pending.release();
    await pending.running;
    await microtasks();
    expect(f.api.getMessages).toHaveBeenCalledTimes(historyReads + 1);
    expect(vi.getTimerCount()).toBe(1);
    expect(f.api.interruptThread).not.toHaveBeenCalled();
    expect(peer.notify).not.toHaveBeenCalled();
  });

  it('keeps observed items and completion behind the original start response, including a rejected duplicate', async () => {
    const f = fixture();
    let listener: Parameters<ChromeExtensionChatApi['subscribeThreadEvents']>[1] | undefined;
    vi.mocked(f.api.subscribeThreadEvents).mockImplementation(async (_id, accept) => {
      listener = accept;
      return vi.fn();
    });
    const owner = f.connect();
    const pending = await pendingOperation(f, owner.binding, 'start');
    listener!({ kind: 'agent', turnId: f.turn.id, event: {
      agentSeq: 1, stream: 'lifecycle', data: { phase: 'start' }, runId: 'native-run', sessionId: 'physical-session',
    } } as never);
    listener!({ kind: 'agent', turnId: f.turn.id, event: {
      agentSeq: 2, stream: 'assistant', data: { text: 'Answer' }, runId: 'native-run', sessionId: 'physical-session',
    } } as never);
    const viewer = f.connect();
    await viewer.binding.threads.resume!({ threadId: 'one', excludeTurns: true });
    await microtasks();
    vi.mocked(f.api.getTurnState).mockResolvedValue({
      id: f.turn.id, status: 'completed', executionSettled: true, startedAt: 1_000, completedAt: 2_000,
    });
    vi.mocked(f.api.getThreadRuntimeStatus).mockResolvedValue({ known: true, running: false });
    vi.mocked(f.api.getMessages).mockResolvedValue([{ role: 'assistant', text: 'Answer' }]);
    await expect(owner.binding.turns.start({
      threadId: 'one', input: [{ type: 'text', text: 'Duplicate' }], chrome: { clientTurnId: f.turn.id },
    })).rejects.toMatchObject({ code: -32602, requestSent: false });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.api.sendMessage).toHaveBeenCalledOnce();
    for (const peer of [owner, viewer])
      expect(peer.notify.mock.calls.some(([method]) => [AppServerNotificationMethod.TurnStarted,
        AppServerNotificationMethod.ItemStarted, AppServerNotificationMethod.TurnCompleted].includes(method)))
        .toBe(false);

    pending.release();
    await pending.running;
    await microtasks();
    await vi.advanceTimersByTimeAsync(500);
    for (const peer of [owner, viewer]) {
      const methods = peer.notify.mock.calls.map(([method]) => method);
      expect(methods.indexOf(AppServerNotificationMethod.TurnStarted)).toBeLessThan(methods.indexOf(AppServerNotificationMethod.ItemStarted));
      expect(methods.indexOf(AppServerNotificationMethod.ItemStarted)).toBeLessThan(methods.indexOf(AppServerNotificationMethod.TurnCompleted));
      expect(peer.notify.mock.calls.filter(([method]) => method === AppServerNotificationMethod.TurnCompleted)).toHaveLength(1);
      expect(peer.notify).toHaveBeenCalledWith(AppServerNotificationMethod.AgentMessageDelta,
        expect.objectContaining({ turnId: f.turn.id, delta: 'Answer' }));
    }
  });

  it('does not dispatch a turn whose baseline read finishes after a full stop', async () => {
    const f = fixture();
    const peer = f.connect();
    const gate = deferred<[]>();
    vi.mocked(f.api.getMessages).mockReturnValueOnce(gate.promise);
    const running = peer.binding.turns.start({ threadId: 'one', input: [{ type: 'text', text: 'Input' }] });
    const rejected = expect(running).rejects.toMatchObject({ requestSent: false });
    await microtasks();
    expect(f.api.getMessages).toHaveBeenCalledOnce();
    await peer.detach();
    await f.hub.stop();
    f.hub.activate();
    gate.resolve([]);
    await rejected;
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards an old in-flight poll after pause/resume instead of scheduling a second timer', async () => {
    const f = fixture();
    const peer = f.connect();
    const oldHistory = deferred<[]>();
    vi.mocked(f.api.getMessages).mockResolvedValueOnce([]).mockReturnValueOnce(oldHistory.promise);
    await peer.binding.turns.start({ threadId: 'one', input: [{ type: 'text', text: 'Input' }], chrome: { clientTurnId: f.turn.id } });
    await microtasks();
    expect(f.api.getMessages).toHaveBeenCalledTimes(2);
    await peer.detach();
    await f.hub.stop({ preserveActiveTurns: true });
    f.hub.activate();
    await microtasks();
    expect(f.api.getMessages).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    oldHistory.resolve([]);
    await microtasks();
    expect(f.api.getMessages).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('never forwards an old native stream into a new same-ID subscription after full stop', async () => {
    const f = fixture();
    vi.mocked(f.api.getTurnState).mockResolvedValue(null);
    const listeners: Array<(event: ChromeExtensionStreamEvent) => void> = [];
    vi.mocked(f.api.subscribeThreadEvents).mockImplementation(async (_id, listener) => {
      listeners.push(listener);
      return vi.fn();
    });
    const first = f.connect();
    await first.binding.threads.resume!({ threadId: 'one', excludeTurns: true });
    await first.detach();
    await f.hub.stop();
    f.hub.activate();
    const replacement = f.connect();
    await replacement.binding.threads.resume!({ threadId: 'one', excludeTurns: true });
    const event = { kind: 'agent', event: { text: 'Own stream' } } as never;
    listeners[0](event);
    expect(replacement.notify).not.toHaveBeenCalled();
    listeners[1](event);
    expect(replacement.notify).toHaveBeenCalledOnce();
  });

  it('keeps metadata reads pure and rejects late results without installing observation', async () => {
    const f = fixture();
    const peer = f.connect();
    await peer.binding.threads.read!({ threadId: 'one' });
    expect(f.api.subscribeThreadEvents).not.toHaveBeenCalled();
    expect(f.api.getMessages).not.toHaveBeenCalled();
    const gate = deferred<never>();
    vi.mocked(f.api.getTurnState).mockReturnValueOnce(gate.promise);
    const reading = peer.binding.threads.read!({ threadId: 'one' });
    const rejected = expect(reading).rejects.toThrow('Connection closed.');
    await microtasks();
    await peer.detach();
    gate.resolve(f.turn as never);
    await rejected;
    expect(f.api.subscribeThreadEvents).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates a broken viewer while other subscribers and native observation continue', async () => {
    const f = fixture();
    vi.mocked(f.api.getTurnState).mockResolvedValue(null);
    const broken = f.connect();
    const healthy = f.connect();
    await broken.binding.threads.resume!({ threadId: 'one', excludeTurns: true });
    await healthy.binding.threads.resume!({ threadId: 'one', excludeTurns: true });
    broken.notify.mockImplementation(() => { throw new Error('Viewer output failed'); });

    await healthy.binding.turns.start({
      threadId: 'one', input: [{ type: 'text', text: 'Independent output' }], chrome: { clientTurnId: f.turn.id },
    });
    await microtasks();

    expect(healthy.notify).toHaveBeenCalledWith(AppServerNotificationMethod.TurnStarted,
      expect.objectContaining({ threadId: 'one', turnId: f.turn.id }));
    expect(f.api.getMessages).toHaveBeenCalledTimes(2);
    expect(f.api.interruptThread).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    expect(() => broken.binding.threads.list!({})).toThrow('Connection closed');
  });

  it('publishes exact turn-state changes even when the display message body has not changed', async () => {
    const f = fixture();
    const peer = f.connect();
    await peer.binding.turns.start({
      threadId: 'one', input: [{ type: 'text', text: 'Input' }], chrome: { clientTurnId: f.turn.id },
    });
    await microtasks();
    vi.mocked(f.api.getTurnState).mockResolvedValue({ id: f.turn.id, status: 'inProgress', executionSettled: false });

    await vi.advanceTimersByTimeAsync(500);

    const updates = peer.notify.mock.calls.filter(([method]) => method === ChromeAppServerNotificationMethod.ThreadUpdated);
    expect(updates).toHaveLength(2);
    expect(updates[1][1]).toMatchObject({ threadId: 'one', activeTurn: { status: 'inProgress', executionSettled: false } });
    expect(peer.notify.mock.calls.some(([method]) => method === AppServerNotificationMethod.TurnCompleted)).toBe(false);
  });

  it('does not promote historical commentary into a final answer after exact settlement', async () => {
    const f = fixture();
    vi.mocked(f.api.getMessages).mockResolvedValue([{ role: 'assistant', text: 'Only commentary' }]).mockResolvedValueOnce([]);
    let listener!: Parameters<ChromeExtensionChatApi['subscribeThreadEvents']>[1];
    vi.mocked(f.api.subscribeThreadEvents).mockImplementation(async (_id, callback) => {
      listener = callback;
      return vi.fn();
    });
    vi.mocked(f.api.getTurnState).mockResolvedValue({
      id: f.turn.id, status: 'completed', executionSettled: true, startedAt: 1_000, completedAt: 2_000,
    });
    f.api.getHistory = vi.fn(async () => ({
      threadId: 'one', runs: [{ id: 'receipt', sessionId: 'one', clientTurnId: f.turn.id,
        rootRunId: 'native-run', startedAt: 1_000, endedAt: 2_000, state: 'completed' }],
      messages: [{ role: 'assistant', content: 'Only commentary', phase: 'commentary', __openclaw: { id: 'commentary', runId: 'native-run' } }],
    }));
    vi.mocked(f.api.sendMessage).mockImplementation(async request => {
      listener({ kind: 'agent', turnId: request.clientTurnId, event: {
        runId: 'native-run', sessionKey: 'native-key', sessionId: 'physical', lifecycleGeneration: null,
        agentId: 'main', spawnedBy: null, agentSeq: 1, frameSeq: 1, deliveryEvent: 'agent',
        stream: 'assistant', timestamp: 1_000, data: { text: 'Only commentary' },
      } });
      return { sessionId: 'one', runId: f.turn.id };
    });
    const peer = f.connect();

    await peer.binding.turns.start({
      threadId: 'one', input: [{ type: 'text', text: 'Input' }], chrome: { clientTurnId: f.turn.id },
    });
    await microtasks();
    await vi.advanceTimersByTimeAsync(1_000);

    const completed = peer.notify.mock.calls.filter(([method]) => method === AppServerNotificationMethod.ItemCompleted);
    expect(completed).toContainEqual([AppServerNotificationMethod.ItemCompleted,
      expect.objectContaining({ item: expect.objectContaining({ type: 'agentMessage', text: 'Only commentary', phase: 'commentary' }) })]);
    expect(completed.some(([, params]) => (params.item as { phase?: string })?.phase === 'final_answer')).toBe(false);
    expect(peer.notify).toHaveBeenCalledWith(AppServerNotificationMethod.TurnCompleted,
      expect.objectContaining({ turn: expect.objectContaining({ status: 'completed', completedAt: 2 }) }));
  });

  it('rejects unsupported execution overrides and malformed browser input before dispatch with explicit proof', async () => {
    const f = fixture();
    const peer = f.connect();
    await expect(peer.binding.turns.start({ threadId: 'one', input: [{ type: 'text', text: 'Input' }], effort: 'high' }))
      .rejects.toMatchObject({ code: -32602, requestSent: false });
    await expect(peer.binding.turns.start({ threadId: 'one', input: [{ type: 'text', text: 'Input' }], chrome: [] }))
      .rejects.toMatchObject({ code: -32602, requestSent: false });
    await expect(peer.binding.threads.start({ sandbox: 'read-only' })).rejects.toMatchObject({ code: -32602 });
    await expect(peer.binding.threads.resume!({ threadId: 'one', config: { unsafe: true } })).rejects.toMatchObject({ code: -32602 });
    expect(f.api.sendMessage).not.toHaveBeenCalled();
    expect(f.api.startThread).not.toHaveBeenCalled();
  });

  it('preserves an uncertain native dispatch failure rather than adding a false unsent marker', async () => {
    const f = fixture();
    const failure = new Error('Native admission response unavailable');
    vi.mocked(f.api.sendMessage).mockRejectedValueOnce(failure);
    const peer = f.connect();

    await expect(peer.binding.turns.start({ threadId: 'one', input: [{ type: 'text', text: 'Input' }] })).rejects.toBe(failure);
    expect(failure).not.toHaveProperty('requestSent');
  });

  it('does not let a late unsubscribed resume remove a newer same-thread subscription', async () => {
    const f = fixture();
    const setup = deferred<() => void>();
    const dispose = vi.fn();
    vi.mocked(f.api.subscribeThreadEvents).mockReturnValueOnce(setup.promise);
    const peer = f.connect();
    const first = peer.binding.threads.resume!({ threadId: 'one', excludeTurns: true });
    const rejected = expect(first).rejects.toThrow('Connection closed');
    await microtasks();
    await peer.binding.threads.unsubscribe!({ threadId: 'one' });
    const replacement = peer.binding.threads.resume!({ threadId: 'one', excludeTurns: true });
    await microtasks();

    setup.resolve(dispose);
    await rejected;
    await replacement;

    expect(await peer.binding.threads.loadedList!({})).toMatchObject({ data: ['one'] });
    expect(dispose).not.toHaveBeenCalled();
    expect(f.api.interruptThread).not.toHaveBeenCalled();
  });

  it('bounds simultaneous thread openings before creating additional product metadata', async () => {
    const f = fixture();
    const setup = deferred<Awaited<ReturnType<ChromeExtensionChatApi['startThread']>>>();
    vi.mocked(f.api.startThread).mockReturnValue(setup.promise);
    const peer = f.connect();
    const openings = Array.from({ length: 32 }, () => peer.binding.threads.start({}));
    const drained = Promise.allSettled(openings);
    await microtasks();
    await expect(peer.binding.threads.start({})).rejects.toMatchObject({ code: -32602 });
    expect(f.api.startThread).toHaveBeenCalledTimes(32);
    await f.hub.stop();
    setup.resolve({
      id: 'late-thread', title: 'Late', status: 'idle', cwd: '/workspace',
      createdAt: 1, updatedAt: 1, permissionMode: 'ask', modelRef: 'provider/default',
    });
    expect((await drained).every(result => result.status === 'rejected')).toBe(true);
    expect(f.api.subscribeThreadEvents).not.toHaveBeenCalled();
  });

  it('returns loaded metadata after first resume and publishes the observed idle status after its response', async () => {
    const f = fixture();
    (await f.api.listSessions())[0].status = 'idle';
    vi.mocked(f.api.getTurnState).mockResolvedValue(null);
    vi.mocked(f.api.getThreadRuntimeStatus).mockResolvedValue({ known: true, running: false });
    const peer = f.connect();

    const result = await peer.binding.threads.resume!({ threadId: 'one', excludeTurns: true });

    expect(result).toMatchObject({ thread: { status: { type: 'idle' } } });
    expect(await peer.binding.threads.loadedList!({})).toMatchObject({ data: ['one'] });
    expect(peer.notify).not.toHaveBeenCalled();
    await microtasks();
    expect(peer.notify).toHaveBeenCalledWith(AppServerNotificationMethod.ThreadStatusChanged,
      { threadId: 'one', status: { type: 'idle' } });
  });

  it('closes only the final idle unsubscriber and leaves other viewers loaded', async () => {
    const f = fixture();
    vi.mocked(f.api.getTurnState).mockResolvedValue(null);
    vi.mocked(f.api.getThreadRuntimeStatus).mockResolvedValue({ known: true, running: false });
    const first = f.connect();
    const second = f.connect();
    await first.binding.threads.resume!({ threadId: 'one', excludeTurns: true });
    await second.binding.threads.resume!({ threadId: 'one', excludeTurns: true });
    await microtasks();
    await first.binding.threads.unsubscribe!({ threadId: 'one' });
    await microtasks();
    expect(first.notify.mock.calls.some(([method]) => method === AppServerNotificationMethod.ThreadClosed)).toBe(false);
    expect(second.notify.mock.calls.some(([method]) => method === AppServerNotificationMethod.ThreadClosed)).toBe(false);
    expect(await second.binding.threads.loadedList!({})).toMatchObject({ data: ['one'] });

    await second.binding.threads.unsubscribe!({ threadId: 'one' });
    expect(second.notify.mock.calls.some(([method]) => method === AppServerNotificationMethod.ThreadClosed)).toBe(false);
    await microtasks();

    expect(second.notify).toHaveBeenCalledWith(AppServerNotificationMethod.ThreadClosed, { threadId: 'one' });
    expect(first.notify.mock.calls.some(([method]) => method === AppServerNotificationMethod.ThreadClosed)).toBe(false);
    expect(await second.binding.threads.loadedList!({})).toMatchObject({ data: [] });
  });

  it('keeps a background execution loaded after its final viewer unsubscribes', async () => {
    const f = fixture();
    const peer = f.connect();
    await peer.binding.turns.start({
      threadId: 'one', input: [{ type: 'text', text: 'Input' }], chrome: { clientTurnId: f.turn.id },
    });
    await microtasks();

    await peer.binding.threads.unsubscribe!({ threadId: 'one' });
    await microtasks();

    expect(await peer.binding.threads.loadedList!({})).toMatchObject({ data: ['one'] });
    expect(peer.notify.mock.calls.some(([method]) => method === AppServerNotificationMethod.ThreadClosed)).toBe(false);
    expect(f.api.interruptThread).not.toHaveBeenCalled();
  });

  it('keeps a pending native admission loaded when its viewer unsubscribes before the ACK', async () => {
    const f = fixture();
    const peer = f.connect();
    const pending = await pendingOperation(f, peer.binding, 'start');

    await peer.binding.threads.unsubscribe!({ threadId: 'one' });
    await microtasks();

    expect(await peer.binding.threads.loadedList!({})).toMatchObject({ data: ['one'] });
    expect(peer.notify.mock.calls.some(([method]) => method === AppServerNotificationMethod.ThreadClosed)).toBe(false);
    pending.release();
    await pending.running;
    await microtasks();
    expect(await peer.binding.threads.loadedList!({})).toMatchObject({ data: ['one'] });
    expect(f.api.interruptThread).not.toHaveBeenCalled();
  });

  it('reserves observation capacity before resume, interrupt or a native send can succeed', async () => {
    const f = fixture();
    vi.mocked(f.api.getTurnState).mockImplementation(async (_id, turnId) => ({
      id: turnId ?? f.turn.id, status: 'unknown', executionSettled: false,
    }));
    const peer = f.connect();
    // Queued response callbacks have not run yet: these are all reserved slots.
    for (let index = 0; index < 256; index += 1)
      await peer.binding.threads.resume!({ threadId: 'one', excludeTurns: true, chrome: { turnId: `observed-${index}` } });

    await expect(peer.binding.threads.resume!({ threadId: 'one', excludeTurns: true, chrome: { turnId: 'overflow' } }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(peer.binding.turns.interrupt({ threadId: 'one', turnId: f.turn.id })).rejects.toMatchObject({ code: -32602 });
    await expect(peer.binding.turns.start({ threadId: 'one', input: [{ type: 'text', text: 'Not sent' }] }))
      .rejects.toMatchObject({ code: -32602, requestSent: false });
    expect(f.api.interruptThread).not.toHaveBeenCalled();
    expect(f.api.sendMessage).not.toHaveBeenCalled();
  });

  it('settles the previous turn without publishing idle over a newer admitted turn', async () => {
    const f = fixture();
    const nextTurn = '22222222-2222-4222-8222-222222222222';
    const states = new Map<string, ChromeExtensionTurnState>([
      [f.turn.id, { id: f.turn.id, status: 'completed', executionSettled: true, startedAt: 1_000, completedAt: 2_000 }],
      [nextTurn, { id: nextTurn, status: 'inProgress', executionSettled: false, startedAt: 2_100 }],
    ]);
    let currentTurn = f.turn.id;
    let body = '';
    vi.mocked(f.api.getTurnState).mockImplementation(async (_id, turnId) => states.get(turnId ?? currentTurn) ?? null);
    vi.mocked(f.api.getThreadRuntimeStatus).mockImplementation(async () => ({
      known: true, running: states.get(currentTurn)?.executionSettled !== true,
    }));
    vi.mocked(f.api.getMessages).mockImplementation(async () => body ? [{ role: 'assistant', text: body }] : []);
    vi.mocked(f.api.sendMessage).mockImplementation(async request => {
      currentTurn = request.clientTurnId!;
      body = currentTurn === f.turn.id ? 'First answer' : 'Second turn commentary';
      return { sessionId: 'one', runId: currentTurn };
    });
    const peer = f.connect();
    await peer.binding.turns.start({
      threadId: 'one', input: [{ type: 'text', text: 'First' }], chrome: { clientTurnId: f.turn.id },
    });
    await microtasks();
    await peer.binding.turns.start({
      threadId: 'one', input: [{ type: 'text', text: 'Second' }], chrome: { clientTurnId: nextTurn },
    });
    await microtasks();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(peer.notify).toHaveBeenCalledWith(AppServerNotificationMethod.TurnCompleted,
      expect.objectContaining({ turn: expect.objectContaining({ id: f.turn.id, status: 'completed' }) }));
    const statuses = peer.notify.mock.calls.filter(([method]) => method === AppServerNotificationMethod.ThreadStatusChanged);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every(([, params]) => (params.status as { type: string }).type === 'active')).toBe(true);
    expect(peer.notify.mock.calls.some(([method, params]) => method === AppServerNotificationMethod.TurnCompleted &&
      (params.turn as { id: string }).id === nextTurn)).toBe(false);
    await expect(peer.binding.turns.interrupt({ threadId: 'one', turnId: f.turn.id })).rejects.toThrow('active turn has changed');
    expect(f.api.interruptThread).not.toHaveBeenCalled();
    states.set(nextTurn, { id: nextTurn, status: 'unknown', executionSettled: false, startedAt: 2_100 });
    await peer.binding.turns.interrupt({ threadId: 'one', turnId: nextTurn });
    expect(f.api.interruptThread).toHaveBeenCalledExactlyOnceWith('one', nextTurn);
    expect(peer.notify.mock.calls.some(([method, params]) => method === AppServerNotificationMethod.TurnCompleted &&
      (params.turn as { id: string }).id === nextTurn)).toBe(false);

    states.set(nextTurn, { id: nextTurn, status: 'completed', executionSettled: true, startedAt: 2_100, completedAt: 4_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(peer.notify).toHaveBeenCalledWith(AppServerNotificationMethod.TurnCompleted,
      expect.objectContaining({ turn: expect.objectContaining({ id: nextTurn, status: 'completed' }) }));
    expect(peer.notify.mock.calls.filter(([method]) => method === AppServerNotificationMethod.ThreadStatusChanged).at(-1))
      .toEqual([AppServerNotificationMethod.ThreadStatusChanged, { threadId: 'one', status: { type: 'idle' } }]);
  });
});
