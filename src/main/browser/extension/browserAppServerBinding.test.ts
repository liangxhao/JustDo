import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrowserExtensionStreamEvent } from '../../../shared/browser/browserExtensionStream';
import type {
  AppServerBinding,
  AppServerConnectionContext,
} from '../../appServer/appServerProtocol';
import { BrowserAppServerHub } from './browserAppServerBinding';
import type { BrowserExtensionChatApi } from './browserAppServerTypes';

const hubs: BrowserAppServerHub[] = [];
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
};

function fixture() {
  vi.useFakeTimers();
  const thread = {
    id: 'one',
    title: 'Browser',
    cwd: '/workspace',
    permissionMode: 'ask' as const,
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  };
  const turn = { id: 'turn', status: 'unknown' as const, executionSettled: false };
  const api: BrowserExtensionChatApi = {
    listSessions: vi.fn(() => [thread]),
    startThread: vi.fn(async () => thread),
    subscribeThreadEvents: vi.fn(async () => vi.fn()),
    getMessages: vi.fn(async () => [{ role: 'user', text: 'Input' }]),
    getComposerOptions: vi.fn(async () => ({ models: [], permissionMode: 'ask' })),
    getThreadRuntimeStatus: vi.fn(async () => ({ known: true, running: true })),
    consumeTurnError: vi.fn(),
    getTurnState: vi.fn(async () => turn),
    sendMessage: vi.fn(async () => ({ sessionId: thread.id, runId: turn.id })),
    interruptThread: vi.fn(async () => {}),
  };
  const hub = new BrowserAppServerHub(api, 'test');
  hub.activate();
  hubs.push(hub);
  const connect = () => {
    let closed = false;
    const notify = vi.fn();
    const context: AppServerConnectionContext = { isClosed: () => closed, notify };
    const binding = hub.connect(context);
    return {
      binding,
      notify,
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
    running = binding.turns.start({ threadId: 'one', message: 'Input' });
  } else if (kind === 'read') {
    vi.mocked(f.api.getTurnState).mockReturnValueOnce(gate.promise);
    running = binding.threads.read!({ threadId: 'one', turnId: 'turn' });
  } else {
    vi.mocked(f.api.interruptThread).mockReturnValueOnce(gate.promise);
    running = binding.turns.interrupt({ threadId: 'one', turnId: 'turn' });
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
          ? { sessionId: 'one', runId: 'turn' }
          : kind === 'read'
            ? f.turn
            : undefined) as never,
      ),
  };
};

describe('browser app-server observation lifecycle', () => {
  it.each(['start', 'read', 'interrupt'])(
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
          turn: { id: 'turn', status: 'inProgress', executionSettled: false },
        });
      expect(f.api.getMessages).toHaveBeenCalledTimes(historyReads);
      expect(vi.getTimerCount()).toBe(0);
      expect(replacement.notify).not.toHaveBeenCalled();
      expect(old.notify).not.toHaveBeenCalled();
      expect(f.api.interruptThread).toHaveBeenCalledTimes(kind === 'interrupt' ? 1 : 0);
      expect(() => old.binding.threads.list!({})).toThrow('Connection closed.');
    },
  );

  it.each(['start', 'read', 'interrupt'])(
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

  it('does not dispatch a turn whose baseline read finishes after a full stop', async () => {
    const f = fixture();
    const peer = f.connect();
    const gate = deferred<[]>();
    vi.mocked(f.api.getMessages).mockReturnValueOnce(gate.promise);
    const running = peer.binding.turns.start({ threadId: 'one', message: 'Input' });
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
    await peer.binding.turns.start({ threadId: 'one', message: 'Input' });
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
    const listeners: Array<(event: BrowserExtensionStreamEvent) => void> = [];
    vi.mocked(f.api.subscribeThreadEvents).mockImplementation(async (_id, listener) => {
      listeners.push(listener);
      return vi.fn();
    });
    const first = f.connect();
    await first.binding.threads.read!({ threadId: 'one' });
    await first.detach();
    await f.hub.stop();
    f.hub.activate();
    const replacement = f.connect();
    await replacement.binding.threads.read!({ threadId: 'one' });
    const event = { kind: 'agent', event: { text: 'Own stream' } } as never;
    listeners[0](event);
    expect(replacement.notify).not.toHaveBeenCalled();
    listeners[1](event);
    expect(replacement.notify).toHaveBeenCalledOnce();
  });
});
