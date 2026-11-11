import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  StorageMaintenancePhase,
  type StorageMaintenanceStatus,
  StorageRelocationIpc,
} from '../../shared/storage/storageRelocation';
import { StorageProcessesStillRunningError } from './relocationProcessRetirement';
import { runStorageMaintenance } from './storageMaintenance';
import { StorageStartupFailure } from './storageStartupFailure';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  handle: vi.fn(),
  frame: { url: 'http://127.0.0.1/maintenance' },
  retire: vi.fn(),
  forcedRetire: vi.fn(),
  execute: vi.fn(),
  findLockers: vi.fn(),
  journal: vi.fn(),
  locator: vi.fn(),
  removeJournal: vi.fn(),
  relaunch: vi.fn(),
  exit: vi.fn(),
  removeMenu: vi.fn(),
}));

const contents = {
  mainFrame: mocks.frame,
  send: mocks.send,
  setWindowOpenHandler: () => {},
  on: () => {},
};
vi.mock('electron', () => ({
  app: {
    whenReady: async () => {},
    getAppPath: () => 'app',
    getPath: () => 'app.exe',
    relaunch: mocks.relaunch,
    exit: mocks.exit,
    getAppMetrics: () => [{ pid: 3200 }],
    getSystemLocale: () => 'zh-CN',
  },
  ipcMain: { handle: mocks.handle },
  BrowserWindow: class {
    webContents = contents;
    removeMenu = mocks.removeMenu;
    isDestroyed() { return false; }
    async loadURL() {}
    on() {}
  },
}));

vi.mock('../core/window/renderer/applicationRendererHost', () => ({
  startApplicationRendererHost: async () => ({ url: mocks.frame.url }),
}));
vi.mock('../core/filesystem/windowsFileLockDiagnostics', () => ({
  findWindowsLockingProcesses: mocks.findLockers,
}));
vi.mock('./relocationProcessRetirement', async importOriginal => ({
  ...await importOriginal<typeof import('./relocationProcessRetirement')>(),
  assertStorageProcessesRetired: mocks.retire,
  waitForForcedStorageRetirement: mocks.forcedRetire,
}));
vi.mock('./relocationState', async importOriginal => ({
  ...await importOriginal<typeof import('./relocationState')>(),
  readRelocationJournal: mocks.journal,
  readStorageLocator: mocks.locator,
  removeRelocationJournal: mocks.removeJournal,
}));
vi.mock('./relocationTransaction', () => ({ executeStorageRelocation: mocks.execute }));

const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
let root: string;
let sourceRoot: string;
let targetRoot: string;
beforeEach(() => {
  vi.resetAllMocks();
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'storage-lock-test-')));
  sourceRoot = path.join(root, 'source');
  targetRoot = path.join(root, 'target');
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(targetRoot);
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root });
  mocks.journal.mockReturnValue({
    transactionId: 'request-id',
    sourceRoot,
    targetRoot,
    sourceProcesses: [{ pid: 45, creationTime: 1 }],
    cleanShutdown: { processes: [{ pid: 45, creationTime: 1 }] },
  });
  mocks.locator.mockReturnValue({ activeRoot: sourceRoot });
});
afterEach(() => {
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath);
  else Reflect.deleteProperty(process, 'resourcesPath');
  fs.rmSync(root, { recursive: true, force: true });
});

function lastStatus() {
  return mocks.send.mock.lastCall?.[1] as StorageMaintenanceStatus | undefined;
}

test('identifies exact file users and marks the maintenance app separately', async () => {
  const filename = path.join(sourceRoot, 'history.sqlite');
  fs.writeFileSync(filename, '');
  mocks.execute.mockRejectedValue(Object.assign(new Error('private native text'), {
    code: 'EBUSY', path: filename,
  }));
  let report!: (value: unknown) => void;
  mocks.findLockers.mockReturnValue(new Promise(resolve => { report = resolve; }));

  await runStorageMaintenance({ bootstrapRoot: sourceRoot });
  await vi.waitFor(() => expect(lastStatus()).toMatchObject({
    errorPath: filename,
    blocking: { kind: 'file', checking: true, processes: [] },
    canRetry: false,
  }));
  expect(mocks.findLockers).toHaveBeenCalledExactlyOnceWith(filename, {
    exact: true, signal: expect.any(AbortSignal),
  });

  report({ available: true, processes: [{ name: 'Backup App', pid: 1234 }, { name: 'node', pid: 3200 }] });

  await vi.waitFor(() => expect(mocks.send.mock.lastCall).toEqual([
    StorageRelocationIpc.MaintenanceChanged,
    expect.objectContaining({
      errorPath: filename,
      canRetry: false,
      canCancel: true,
      blocking: {
        kind: 'file',
        processes: [
          { name: 'Backup App', pid: 1234, appOwned: false },
          { name: 'node', pid: 3200, appOwned: true },
        ],
      },
    }),
  ]));
  expect(JSON.stringify(lastStatus())).not.toContain('private native text');
});

test('starts offline copy after the forced handoff only once the old processes have exited', async () => {
  const processes = [{ pid: 45, creationTime: 1 }];
  const retired = Promise.withResolvers<void>();
  const copying = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  mocks.journal.mockReturnValue({ sourceRoot, targetRoot, forcedShutdown: { processes } });
  mocks.forcedRetire.mockReturnValue(retired.promise);
  mocks.execute.mockImplementation(async ({ onPhase }) => {
    onPhase(StorageMaintenancePhase.CopyingData);
    await copying.promise;
    onPhase(StorageMaintenancePhase.SwitchingLocation);
    await cleaned.promise;
  });

  await runStorageMaintenance({ bootstrapRoot: sourceRoot });
  expect(mocks.forcedRetire).toHaveBeenCalledExactlyOnceWith(processes);
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.removeMenu).toHaveBeenCalledOnce();
  expect(lastStatus()?.phase).toBe(StorageMaintenancePhase.RetiringProcesses);

  retired.resolve();
  await vi.waitFor(() => expect(lastStatus()).toMatchObject({
    phase: StorageMaintenancePhase.CopyingData, canCancel: true,
  }));
  mocks.send.mockImplementationOnce(() => { throw new Error('Renderer is unavailable.'); });
  copying.resolve();
  await vi.waitFor(() => expect(lastStatus()).toMatchObject({
    phase: StorageMaintenancePhase.SwitchingLocation, canCancel: false,
  }));
  expect(mocks.relaunch).not.toHaveBeenCalled();
  cleaned.resolve();
  await vi.waitFor(() => expect(mocks.relaunch).toHaveBeenCalledOnce());
});

test('shows the verified old process before copying, even without a clean exit record', async () => {
  mocks.journal.mockReturnValue({
    sourceRoot, targetRoot, sourceProcesses: [{ pid: 45, creationTime: 1 }],
  });
  mocks.retire.mockRejectedValue(new StorageProcessesStillRunningError([{ pid: 45, name: 'JustDo' }]));

  await runStorageMaintenance({ bootstrapRoot: sourceRoot });

  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.findLockers).not.toHaveBeenCalled();
  expect(lastStatus()).toMatchObject({
    error: 'failed',
    canRetry: false,
    canCancel: false,
    blocking: { kind: 'retirement', processes: [{ pid: 45, name: 'JustDo', appOwned: true }] },
  });
});

test('does not query a busy path outside the migration roots', async () => {
  const filename = path.join(root, 'outside.txt');
  fs.writeFileSync(filename, '');
  mocks.execute.mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY', path: filename }));

  await runStorageMaintenance({ bootstrapRoot: sourceRoot });
  await vi.waitFor(() => expect(lastStatus()).toMatchObject({
    blocking: { kind: 'file', processes: [] },
    canRetry: false,
    canCancel: true,
  }));

  expect(mocks.findLockers).not.toHaveBeenCalled();
  expect(lastStatus()?.errorPath).toBeUndefined();
});

test('also identifies an exact locked item when opening the saved data path fails', async () => {
  const filename = path.join(sourceRoot, 'storage-root.json');
  fs.writeFileSync(filename, '');
  mocks.findLockers.mockResolvedValue({ available: true, processes: [{ name: 'Sync App', pid: 3210 }] });
  const cause = Object.assign(new Error('private text'), { code: 'EACCES', path: filename });

  await runStorageMaintenance({
    bootstrapRoot: targetRoot,
    initialError: new StorageStartupFailure('data', sourceRoot, cause),
  });

  expect(mocks.execute).not.toHaveBeenCalled();
  expect(lastStatus()).toMatchObject({
    error: 'unavailable', dataPath: sourceRoot, errorPath: filename, canRetry: true,
    blocking: { kind: 'file', processes: [{ name: 'Sync App', pid: 3210, appOwned: false }] },
  });
});

test('preserves the permission reason when no file user can be identified', async () => {
  const filename = path.join(targetRoot, 'protected.txt');
  fs.writeFileSync(filename, '');
  mocks.execute.mockRejectedValue(Object.assign(new Error('private text'), { code: 'EPERM', path: filename }));
  mocks.findLockers.mockResolvedValue({ available: false, processes: [] });

  await runStorageMaintenance({ bootstrapRoot: sourceRoot });

  await vi.waitFor(() => expect(lastStatus()).toMatchObject({
    errorPath: filename,
    errorDetail: expect.stringContaining('(EPERM)'),
    blocking: { kind: 'file', processes: [] },
    canRetry: false,
    canCancel: true,
  }));
});

test('admits an exact item in temporary storage created by this attempt', async () => {
  const scratch = path.join(root, 'storage-snapshot');
  fs.mkdirSync(scratch);
  const filename = path.join(scratch, '0.sqlite');
  fs.writeFileSync(filename, '');
  mocks.execute.mockImplementationOnce(async ({ onTemporaryDirectory }) => {
    onTemporaryDirectory(scratch);
    throw Object.assign(new Error('busy'), { code: 'EBUSY', path: filename });
  });
  mocks.findLockers.mockResolvedValue({ available: true, processes: [{ name: 'Backup App', pid: 1234 }] });

  await runStorageMaintenance({ bootstrapRoot: sourceRoot });

  await vi.waitFor(() => expect(lastStatus()).toMatchObject({
    errorPath: filename,
    blocking: { kind: 'file', processes: [{ name: 'Backup App', pid: 1234, appOwned: false }] },
  }));
});

test('shows disk space failure and returns to the unchanged source without retrying the partial target', async () => {
  mocks.execute.mockRejectedValue(Object.assign(new Error('Disk full.'), { code: 'ENOSPC' }));
  const event = { sender: contents, senderFrame: mocks.frame };

  await runStorageMaintenance({ bootstrapRoot: sourceRoot });
  await vi.waitFor(() => expect(lastStatus()).toMatchObject({
    dataPath: sourceRoot,
    targetPath: targetRoot,
    errorDetail: expect.stringContaining('(ENOSPC)'),
    canRetry: false,
    canCancel: true,
  }));
  const handler = (channel: string) => mocks.handle.mock.calls.find(call => call[0] === channel)![1];

  await handler(StorageRelocationIpc.MaintenanceRetry)(event);
  await handler(StorageRelocationIpc.MaintenanceCancel)(event);

  expect(mocks.execute).toHaveBeenCalledOnce();
  expect(mocks.removeJournal).toHaveBeenCalledExactlyOnceWith(sourceRoot, 'request-id');
  expect(mocks.relaunch).toHaveBeenCalledOnce();
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(0);
});
