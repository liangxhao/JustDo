import { afterEach, expect, test, vi } from 'vitest';

import { ChromeAppServerHub } from './chromeAppServerBinding';
import { ChromeAppServerMethod } from './chromeAppServerProtocol';
import type { ChromeExtensionChatApi } from './chromeAppServerTypes';

const hubs: ChromeAppServerHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
});

function setup() {
  const thread = {
    id: 'browser',
    title: 'Browser',
    cwd: '/default',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    permissionMode: 'ask' as const,
    modelRef: 'provider/model',
  };
  const api: ChromeExtensionChatApi = {
    listSessions: () => [thread],
    getThread: () => thread,
    startThread: vi.fn(async () => thread),
    getComposerOptions: vi.fn(async () => ({
      cwd: '/default',
      models: [],
      permissionMode: 'ask' as const,
    })),
    selectWorkspace: vi.fn(async () => '/chosen'),
    setThreadWorkspace: vi.fn(async (input, isCurrent) => {
      if (!isCurrent()) return { success: false as const, reason: 'unsupported' as const };
      thread.cwd = input.cwd;
      return { success: true as const, cwd: input.cwd };
    }),
    subscribeThreadEvents: vi.fn(async () => () => {}),
    getMessages: vi.fn(async () => []),
    getTurnState: vi.fn(async () => null),
    getThreadRuntimeStatus: vi.fn(async () => ({ known: true, running: false })),
    sendMessage: vi.fn(),
    consumeTurnError: vi.fn(),
    interruptThread: vi.fn(),
  };
  const hub = new ChromeAppServerHub(api, 'test');
  hubs.push(hub);
  hub.activate();
  const connect = () => hub.connect({ isClosed: () => false, notify: vi.fn() });
  const binding = connect();
  const select = (params: Record<string, unknown>) =>
    binding.extensions![ChromeAppServerMethod.WorkspaceSelect](params);
  const set = (params: Record<string, unknown>) =>
    binding.extensions![ChromeAppServerMethod.ThreadWorkspaceSet](params);
  return { api, thread, binding, connect, select, set };
}

test('only a choice issued to this draft and peer can create a thread in a selected directory', async () => {
  const f = setup();
  const selected = await f.select({ draftId: 'draft-one' });
  await expect(
    f.connect().threads.start({
      chrome: {
        draftId: 'draft-one',
        workspaceSelectionToken: selected.selectionToken,
      },
    }),
  ).rejects.toThrow('expired');
  await expect(
    f.binding.threads.start({
      chrome: {
        draftId: 'draft-two',
        workspaceSelectionToken: selected.selectionToken,
      },
    }),
  ).rejects.toThrow('another conversation');
  await f.binding.threads.start({
    chrome: {
      draftId: 'draft-one',
      workspaceSelectionToken: selected.selectionToken,
    },
  });
  expect(f.api.startThread).toHaveBeenCalledExactlyOnceWith(undefined, {
    model: undefined,
    cwd: '/chosen',
    selectedWorkspace: { assertCurrent: expect.any(Function) },
  });
  await expect(
    f.binding.threads.start({
      chrome: {
        draftId: 'draft-one',
        workspaceSelectionToken: selected.selectionToken,
      },
    }),
  ).rejects.toThrow('expired');
});

test('changing an existing workspace uses the old-directory guard and invalidates the selection on unsubscribe', async () => {
  const f = setup();
  await f.binding.threads.start({});
  const selected = await f.select({ threadId: f.thread.id, expectedCwd: f.thread.cwd });
  await expect(
    f.set({
      threadId: f.thread.id,
      expectedCwd: '/different',
      selectionToken: selected.selectionToken,
    }),
  ).rejects.toThrow('another conversation');
  await expect(
    f.set({
      threadId: f.thread.id,
      expectedCwd: f.thread.cwd,
      selectionToken: selected.selectionToken,
    }),
  ).resolves.toEqual({ success: true, cwd: '/chosen' });
  expect(f.api.setThreadWorkspace).toHaveBeenCalledWith(
    {
      sessionId: f.thread.id,
      expectedCwd: '/default',
      cwd: '/chosen',
    },
    expect.any(Function),
  );
  const later = await f.select({ threadId: f.thread.id, expectedCwd: f.thread.cwd });
  await f.binding.threads.unsubscribe!({ threadId: f.thread.id });
  await f.binding.threads.start({});
  await expect(
    f.set({
      threadId: f.thread.id,
      expectedCwd: f.thread.cwd,
      selectionToken: later.selectionToken,
    }),
  ).rejects.toThrow('expired');
});

test('disconnect discards an in-flight picker result without applying a directory', async () => {
  const f = setup();
  let finish!: (value: string) => void;
  vi.mocked(f.api.selectWorkspace!).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const selecting = f.select({ draftId: 'draft' });
  const rejected = expect(selecting).rejects.toThrow('closed');
  await vi.waitFor(() => expect(f.api.selectWorkspace).toHaveBeenCalledOnce());
  await f.binding.onDisconnect();
  finish('/late');
  await rejected;
  expect(f.api.startThread).not.toHaveBeenCalled();
  expect(f.api.setThreadWorkspace).not.toHaveBeenCalled();
});
