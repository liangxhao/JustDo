import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { HistoryRecoveryIpc } from '../../../shared/app/startup/history';
import { registerHistoryRecoveryHandlers } from './historyRecovery';

const { handlers, select } = vi.hoisted(() => ({ handlers: new Map(), select: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: (key: string, handler: unknown) => handlers.set(key, handler) },
  dialog: { showOpenDialog: select },
}));
afterEach(() => {
  handlers.clear();
  vi.restoreAllMocks();
  select.mockReset();
});
function fixture() {
  const webContents = { mainFrame: {} };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const window = { webContents, isDestroyed: () => false };
  let currentWindow = window;
  let session = {
    id: 'history',
    cwd: path.join(os.tmpdir(), 'missing-startup-workspace'),
    status: 'idle',
    historyBinding: {
      sessionKey: 'agent:main:justdo:history',
      nativeSessionId: 'native-1',
      workspaceUnavailable: true,
    },
  };
  let open = false;
  const update = vi.fn();
  registerHistoryRecoveryHandlers({
    getWindow: () => currentWindow as never,
    isReady: () => true,
    getStore: () =>
      ({
        getDatabase: () => ({ prepare: () => ({ get: () => (open ? {} : undefined) }) }),
      }) as never,
    getCoworkStore: () => ({ getSession: () => session, updateSession: update }) as never,
  });
  return {
    event,
    update,
    call: (input: unknown, caller = event) =>
      handlers.get(HistoryRecoveryIpc.SelectWorkspace)(caller, input),
    makeBusy: () => {
      open = true;
    },
    replaceWindow: () => {
      currentWindow = { webContents: { mainFrame: {} }, isDestroyed: () => false };
    },
    replace: () => {
      session = {
        ...session,
        historyBinding: { ...session.historyBinding, nativeSessionId: 'replaced' },
      };
    },
  };
}
test('history workspace IPC rejects invalid identities, untrusted windows and subframes before opening a dialog', async () => {
  const h = fixture();
  for (const input of [null, {}, { sessionId: '' }, { sessionId: 'history', cwd: 'unapproved' }])
    expect((await h.call(input)).success).toBe(false);
  expect(
    (await h.call({ sessionId: 'history' }, { sender: {} as never, senderFrame: {} })).success,
  ).toBe(false);
  expect((await h.call({ sessionId: 'history' }, { ...h.event, senderFrame: {} })).success).toBe(
    false,
  );
  expect(select).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
});
test('only a selected existing directory updates a still-idle imported conversation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-workspace-'));
  try {
    const h = fixture();
    select.mockResolvedValue({ canceled: false, filePaths: [dir] });
    expect(await h.call({ sessionId: 'history' })).toEqual({ success: true, cwd: dir });
    expect(h.update).toHaveBeenCalledWith('history', { cwd: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test.each(['busy', 'identity', 'window'])(
  'a %s change during folder selection prevents a stale update',
  async kind => {
    const h = fixture();
    select.mockImplementation(async () => {
      if (kind === 'busy') h.makeBusy();
      else if (kind === 'window') h.replaceWindow();
      else h.replace();
      return { canceled: false, filePaths: [os.tmpdir()] };
    });
    expect((await h.call({ sessionId: 'history' })).success).toBe(false);
    expect(h.update).not.toHaveBeenCalled();
  },
);
