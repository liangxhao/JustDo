import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppServerConnectionContext } from '../clients/appServer/protocol/appServerProtocol';
import { ChromeAppServerHub } from './chromeAppServerBinding';
import { ChromeAppServerMethod, ChromeAppServerNotificationMethod } from './chromeAppServerProtocol';
import type { ChromeExtensionChatApi } from './chromeAppServerTypes';

const hubs: ChromeAppServerHub[] = [];
afterEach(async () => { await Promise.all(hubs.splice(0).map(hub => hub.stop())); });

function fixture() {
  const thread = { id: 'one', title: 'Chrome', cwd: '/task', permissionMode: 'ask' as const,
    status: 'idle', modelRef: 'provider/default', createdAt: 1, updatedAt: 1 };
  let changed!: () => void;
  const disposeQuestions = vi.fn();
  const api: ChromeExtensionChatApi = {
    listSessions: () => [thread], startThread: async () => thread,
    getMessages: async () => [], getComposerOptions: async () => ({ models: [], permissionMode: 'ask' }),
    getThreadRuntimeStatus: async () => ({ known: true, running: false }),
    getTurnState: async () => null, consumeTurnError: () => undefined,
    sendMessage: vi.fn(), interruptThread: vi.fn(),
    subscribeThreadEvents: async () => vi.fn(),
    subscribeQuestions: vi.fn(async (_id, listener) => { changed = listener; return disposeQuestions; }),
    listQuestions: vi.fn(async () => []), respondQuestion: vi.fn(async () => {}),
  };
  const hub = new ChromeAppServerHub(api, 'test');
  hub.activate();
  hubs.push(hub);
  const connect = () => {
    const notify = vi.fn();
    const context: AppServerConnectionContext = { notify, isClosed: () => false };
    return { binding: hub.connect(context), notify };
  };
  return { api, connect, changed: () => changed(), disposeQuestions };
}

describe('Chrome question protocol subscription boundaries', () => {
  it('requires explicit subscription and only invalidates viewers of the selected thread', async () => {
    const f = fixture();
    const viewer = f.connect();
    const outsider = f.connect();
    const list = viewer.binding.extensions![ChromeAppServerMethod.QuestionsList];
    await expect(list({ threadId: 'one' })).rejects.toThrow('Subscribe');
    expect(f.api.listQuestions).not.toHaveBeenCalled();
    await viewer.binding.threads.start({});
    await expect(list({ threadId: 'one' })).resolves.toEqual({ questions: [] });
    f.changed();
    expect(viewer.notify).toHaveBeenCalledWith(ChromeAppServerNotificationMethod.QuestionsChanged, { threadId: 'one' });
    expect(outsider.notify).not.toHaveBeenCalledWith(ChromeAppServerNotificationMethod.QuestionsChanged, expect.anything());
    await viewer.binding.threads.unsubscribe!({ threadId: 'one' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.disposeQuestions).toHaveBeenCalledOnce();
    await expect(list({ threadId: 'one' })).rejects.toThrow('Subscribe');
    expect(f.api.respondQuestion).not.toHaveBeenCalled();
  });

  it('passes rich answers intact and invalidates the response guard on unsubscribe and reload', async () => {
    const f = fixture();
    const viewer = f.connect();
    await viewer.binding.threads.start({});
    const respond = viewer.binding.extensions![ChromeAppServerMethod.QuestionsRespond];
    const answers = { target: { selected: ['dev', 'prod'], optionInputs: { dev: 'Extra' }, other: 'Another' } };
    await respond({ threadId: 'one', requestId: 'ask_pending', behavior: 'submit', answers });
    const [_thread, _request, response, assertCurrent] = vi.mocked(f.api.respondQuestion!).mock.calls[0];
    expect(response).toEqual({ behavior: 'submit', answers });
    assertCurrent();
    await viewer.binding.threads.unsubscribe!({ threadId: 'one' });
    await viewer.binding.threads.start({});
    expect(assertCurrent).toThrow('Subscribe');
  });

  it('rejects late list results and answers after the peer disconnects', async () => {
    const f = fixture();
    const viewer = f.connect();
    await viewer.binding.threads.start({});
    let finish!: () => void;
    vi.mocked(f.api.listQuestions!).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return [];
    });
    const pending = viewer.binding.extensions![ChromeAppServerMethod.QuestionsList]({ threadId: 'one' });
    await viewer.binding.onDisconnect();
    finish();
    await expect(pending).rejects.toThrow('Connection closed');
    expect(f.api.respondQuestion).not.toHaveBeenCalled();
  });
});
