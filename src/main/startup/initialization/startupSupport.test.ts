import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import {
  AppInitializationPhase,
  type AppInitializationState,
} from '../../../shared/app/initialization';
import { StartupSupportAction, StartupSupportIpc } from '../../../shared/app/startup/history';
import { registerStartupSupportHandlers } from './startupSupport';

const { handlers, openPath } = vi.hoisted(() => ({ handlers: new Map(), openPath: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: unknown) => handlers.set(name, fn) },
  shell: { openPath },
}));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  openPath.mockReset();
  handlers.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(phase: AppInitializationState['phase'] = AppInitializationPhase.Failed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-support-'));
  roots.push(root);
  const backup = path.join(root, 'backups', 'history');
  fs.mkdirSync(backup, { recursive: true });
  const webContents = { mainFrame: {} };
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const state = {
    phase,
    userDataPath: root,
    historySummary: { conversations: 3 },
  } as AppInitializationState;
  registerStartupSupportHandlers({
    getWindow: () => ({ webContents, isDestroyed: () => false }) as never,
    getState: () => state,
    getBackupDirectory: () => backup,
    platform: 'win32',
  });
  openPath.mockResolvedValue('');
  return {
    root,
    backup,
    event,
    state,
    call: (input: unknown, caller = event) => handlers.get(StartupSupportIpc.Open)(caller, input),
  };
}
test('rejects arbitrary paths, invalid actions, subframes and other windows before opening anything', async () => {
  const h = fixture();
  for (const input of [
    null,
    {},
    { action: 'unknown' },
    { action: StartupSupportAction.OpenData, path: 'C:/other' },
  ])
    expect(await h.call(input)).toEqual({ success: false });
  expect(
    await h.call({ action: StartupSupportAction.OpenData }, { ...h.event, senderFrame: {} }),
  ).toEqual({ success: false });
  expect(
    await h.call(
      { action: StartupSupportAction.OpenData },
      { sender: {} as never, senderFrame: {} },
    ),
  ).toEqual({ success: false });
  expect(openPath).not.toHaveBeenCalled();
});
test('opens the Main-owned backup after success and exposes repair tools only for failed startup', async () => {
  const h = fixture(AppInitializationPhase.Ready);
  expect(await h.call({ action: StartupSupportAction.OpenBackup })).toEqual({ success: true });
  expect(openPath).toHaveBeenCalledWith(h.backup);
  expect(await h.call({ action: StartupSupportAction.OpenData })).toEqual({ success: false });
  h.state.phase = AppInitializationPhase.Failed;
  expect(await h.call({ action: StartupSupportAction.OpenData })).toEqual({ success: true });
  expect(openPath).toHaveBeenLastCalledWith(h.root);
  vi.stubEnv('SystemRoot', h.root);
  fs.mkdirSync(path.join(h.root, 'System32'));
  const taskManager = path.join(h.root, 'System32', 'Taskmgr.exe');
  fs.writeFileSync(taskManager, 'fixture');
  expect(await h.call({ action: StartupSupportAction.OpenTaskManager })).toEqual({ success: true });
  expect(openPath).toHaveBeenLastCalledWith(taskManager);
  openPath.mockResolvedValue('shell failed');
  expect(await h.call({ action: StartupSupportAction.OpenData })).toEqual({ success: false });
});
