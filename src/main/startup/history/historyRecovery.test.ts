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
    cwd: path.join(process.execPath, 'history-workspace'),
    status: 'idle',
    historyBinding: {
      sessionKey: 'agent:main:justdo:history',
      nativeSessionId: 'native-1',
    },
  };
  let open = false;
  const update = vi.fn();
  const blocksWorkspaceChange = vi.fn<(id: string, cwd: string) => boolean>(() => false);
  registerHistoryRecoveryHandlers({
    getWindow: () => currentWindow as never,
    isReady: () => true,
    getStore: () =>
      ({
        getDatabase: () => ({ prepare: () => ({ get: () => (open ? {} : undefined) }) }),
      }) as never,
    getCoworkStore: () => ({ getSession: () => session, updateSession: update }) as never,
    blocksWorkspaceChange,
  });
  return {
    event,
    update,
    blocksWorkspaceChange,
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
    const cwd = fs.realpathSync.native(dir);
    select.mockResolvedValue({ canceled: false, filePaths: [dir] });
    expect(await h.call({ sessionId: 'history' })).toEqual({ success: true, cwd });
    expect(h.update).toHaveBeenCalledWith('history', { cwd });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('keeps a plugin-bound history session on its original project during missing directory recovery', async () => {
  const h = fixture();
  const selected = os.tmpdir();
  select.mockImplementation(async () => {
    h.blocksWorkspaceChange.mockReturnValue(true);
    return { canceled: false, filePaths: [selected] };
  });

  await expect(h.call({ sessionId: 'history' })).resolves.toMatchObject({ success: false });
  expect(h.blocksWorkspaceChange).toHaveBeenCalledExactlyOnceWith(
    'history',
    fs.realpathSync.native(selected),
  );
  expect(h.update).not.toHaveBeenCalled();
});
test.each(['busy', 'identity', 'window', 'directory-check'])(
  'a %s change during workspace recovery prevents a stale update',
  async kind => {
    const h = fixture();
    select.mockImplementation(async () => {
      if (kind === 'busy') h.makeBusy();
      else if (kind === 'window') h.replaceWindow();
      else if (kind === 'identity') h.replace();
      else {
        vi.spyOn(fs.promises, 'stat').mockImplementationOnce(async () => {
          await Promise.resolve();
          h.makeBusy();
          throw Object.assign(new Error('Workspace not found'), { code: 'ENOENT' });
        });
      }
      return { canceled: false, filePaths: [os.tmpdir()] };
    });
    expect((await h.call({ sessionId: 'history' })).success).toBe(false);
    expect(h.update).not.toHaveBeenCalled();
  },
);
