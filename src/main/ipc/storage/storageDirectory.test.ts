import fs from 'node:fs';
import path from 'node:path';

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import ts from 'typescript';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { USER_DATA_DIRECTORY_NAME } from '../../../shared/productMetadata';
import {
  StorageCleanupPhase,
  type StorageCleanupProgressUpdate,
  StorageDirectoryError,
  StorageDirectoryIpc,
} from '../../../shared/storage/storageDirectory';
import type { StorageBootstrapContext } from '../../storage/relocationState';
import { registerStorageDirectoryHandlers } from './storageDirectory';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  getPath: vi.fn((name: string) => name === 'appData' ? 'app-data' : 'current-profile'),
  openPath: vi.fn().mockResolvedValue(''),
  scan: vi.fn().mockResolvedValue({ complete: true }),
  backupStatus: vi.fn(),
  deleteBackup: vi.fn(),
  backupStop: vi.fn(),
  backupBusy: vi.fn(),
  clearCache: vi.fn(),
  cacheStop: vi.fn(),
  cacheBusy: vi.fn(),
  collectSessions: vi.fn(),
  stopSessions: vi.fn(),
  showMessageBox: vi.fn(),
  confirmDelete: undefined as ((directory: string) => Promise<boolean>) | undefined,
  backupReady: undefined as ((backupRoot: string) => boolean) | undefined,
  backupRoot: undefined as string | undefined,
  getStorageBootstrapContext: vi.fn<() => StorageBootstrapContext | undefined>(),
  cacheReady: undefined as (() => boolean) | undefined,
  cacheOptions: undefined as {
    getDirectory: () => string;
    collectSessions: (root: string) => Promise<unknown[]>;
    stopSessions?: () => void;
  } | undefined,
}));
const { handlers, getPath, openPath, scan } = mocks;
vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  dialog: { showMessageBox: mocks.showMessageBox },
  shell: { openPath: mocks.openPath },
  ipcMain: {
    handle: (channel: string, handler: typeof handlers extends Map<string, infer H> ? H : never) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock('../../storage/upgradeBackupService', () => ({
  UpgradeBackupService: class {
    constructor(options: {
      confirmDelete: (directory: string) => Promise<boolean>;
      isReady: (backupRoot: string) => boolean;
      backupRoot?: string;
    }) {
      mocks.confirmDelete = options.confirmDelete;
      mocks.backupReady = options.isReady;
      mocks.backupRoot = options.backupRoot;
    }
    status = mocks.backupStatus;
    delete = mocks.deleteBackup;
    stop = mocks.backupStop;
    isBusy = mocks.backupBusy;
  },
}));
vi.mock('../../storage/relocationState', async importOriginal => ({
  ...await importOriginal<typeof import('../../storage/relocationState')>(),
  getStorageBootstrapContext: mocks.getStorageBootstrapContext,
}));
vi.mock('../../browser/data/browserCacheSessions', () => ({
  createBrowserCacheSessions: () => ({ collect: mocks.collectSessions, stop: mocks.stopSessions }),
}));
vi.mock('../../storage/browserCacheService', () => ({
  BrowserCacheService: class {
    constructor(options: NonNullable<typeof mocks.cacheOptions> & { isReady: () => boolean }) {
      mocks.cacheOptions = options;
      mocks.cacheReady = options.isReady;
    }
    clear = mocks.clearCache;
    stop = mocks.cacheStop;
    isBusy = mocks.cacheBusy;
  },
}));
vi.mock('../../storage/storageDirectoryService', async importOriginal => {
  const original = await importOriginal<typeof import('../../storage/storageDirectoryService')>();
  return {
    ...original,
    StorageDirectoryService: class extends original.StorageDirectoryService {
      constructor(dependencies: ConstructorParameters<typeof original.StorageDirectoryService>[0]) {
        super({ ...dependencies, scan });
      }
    },
  };
});
beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  mocks.backupStatus.mockResolvedValue({ success: true, value: { exists: true, canDelete: true } });
  mocks.deleteBackup.mockResolvedValue({ success: true, value: null });
  mocks.clearCache.mockResolvedValue({ success: true, value: null });
  mocks.backupStop.mockResolvedValue(undefined);
  mocks.cacheStop.mockResolvedValue(undefined);
  mocks.backupBusy.mockReturnValue(false);
  mocks.cacheBusy.mockReturnValue(false);
  mocks.collectSessions.mockResolvedValue([]);
  mocks.showMessageBox.mockResolvedValue({ response: 0 });
  mocks.getStorageBootstrapContext.mockReturnValue(undefined);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const mainFrame = {};
  const contents = { mainFrame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  const controller = registerStorageDirectoryHandlers({
    getMainWindow: () => window as unknown as BrowserWindow,
    isReady: () => true,
    isCacheReady: () => true,
  });
  return {
    event: { sender: contents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent,
    controller,
  };
}
const setup = () => fixture().event;

test('the main frame can query, scan and open only the Main-owned data and configuration folders', async () => {
  const event = setup();

  expect(await handlers.get(StorageDirectoryIpc.Info)!(event)).toEqual({
    success: true,
    value: {
      path: 'current-profile',
      bootstrapPath: path.join('app-data', USER_DATA_DIRECTORY_NAME),
    },
  });
  expect(await handlers.get(StorageDirectoryIpc.Scan)!(event)).toEqual({
    success: true,
    value: { complete: true },
  });
  expect(await handlers.get(StorageDirectoryIpc.Open)!(event)).toEqual({
    success: true,
    value: null,
  });
  expect(await handlers.get(StorageDirectoryIpc.OpenConfig)!(event)).toEqual({
    success: true,
    value: null,
  });
  expect(getPath).toHaveBeenCalledWith('userData');
  expect(scan).toHaveBeenCalledWith('current-profile', { backupRoot: undefined });
  expect(openPath).toHaveBeenCalledWith('current-profile');
  expect(openPath).toHaveBeenLastCalledWith(path.join('app-data', USER_DATA_DIRECTORY_NAME));
});

test('only the shared profile owner supplies the fixed backup location to statistics and deletion', async () => {
  const bootstrapRoot = path.join('app-data', USER_DATA_DIRECTORY_NAME);
  const context = { bootstrapRoot, activeRoot: 'current-profile' };
  mocks.getStorageBootstrapContext.mockReturnValue({ ...context, singletonOwned: false });
  setup();
  expect(mocks.backupRoot).toBeUndefined();

  mocks.getStorageBootstrapContext.mockReturnValue({ ...context, singletonOwned: true });
  const event = setup();
  expect(mocks.backupRoot).toBe(bootstrapRoot);
  await handlers.get(StorageDirectoryIpc.Scan)!(event);
  expect(scan).toHaveBeenCalledExactlyOnceWith('current-profile', { backupRoot: bootstrapRoot });
  expect(await handlers.get(StorageDirectoryIpc.UpgradeBackupStatus)!(event)).toEqual({
    success: true, value: { exists: true, canDelete: true },
  });
});

test('guest pages, child frames, stale windows and Renderer-supplied paths cannot access storage', async () => {
  const event = setup();
  for (const channel of Object.values(StorageDirectoryIpc)) {
    const handler = handlers.get(channel)!;
    expect(await handler({ ...event, senderFrame: {} } as IpcMainInvokeEvent)).toEqual({
      success: false,
      code: 'forbidden',
    });
    expect(
      await handler({ ...event, sender: { isDestroyed: () => false } } as IpcMainInvokeEvent),
    ).toEqual({ success: false, code: 'forbidden' });
    expect(await handler(event, 'C:\\other-profile')).toEqual({
      success: false,
      code: 'forbidden',
    });
  }
  expect(getPath).not.toHaveBeenCalled();
  expect(scan).not.toHaveBeenCalled();
  expect(openPath).not.toHaveBeenCalled();
  expect(mocks.backupStatus).not.toHaveBeenCalled();
  expect(mocks.deleteBackup).not.toHaveBeenCalled();
  expect(mocks.clearCache).not.toHaveBeenCalled();
});

test('native backup confirmation shows the exact directory, defaults to cancel and rejects a stale approval', async () => {
  const event = setup();
  const directory = 'D:\\data\\backups';
  const status = () => handlers.get(StorageDirectoryIpc.CleanupStatus)!(event);
  expect(await status()).toEqual({ success: true, value: null });

  expect(await mocks.confirmDelete!(directory)).toBe(false);
  const options = mocks.showMessageBox.mock.calls[0][1];
  expect(options).toMatchObject({ type: 'warning', defaultId: 0, cancelId: 0, noLink: true });
  expect(options.detail).toContain(directory);

  mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
  expect(await mocks.confirmDelete!(directory)).toBe(true);

  let finish!: (value: { response: number }) => void;
  mocks.showMessageBox.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  mocks.deleteBackup.mockImplementationOnce(async (caller, report) => {
    report({ phase: StorageCleanupPhase.Confirming });
    const approved = await mocks.confirmDelete!(directory);
    expect(caller()).toBe(false);
    return { success: false, code: approved ? 'unavailable' : 'cancelled' };
  });
  const pending = handlers.get(StorageDirectoryIpc.DeleteUpgradeBackup)!(event);
  expect(await status()).toMatchObject({ value: { phase: 'confirming' } });
  const nextFrame = {};
  Object.assign(event.sender, { mainFrame: nextFrame });
  finish({ response: 1 });
  expect(await pending).toEqual({ success: false, code: 'cancelled' });
  expect(await handlers.get(StorageDirectoryIpc.CleanupStatus)!({
    ...event, senderFrame: nextFrame,
  } as IpcMainInvokeEvent)).toMatchObject({ value: { phase: 'cancelled', errorCode: 'cancelled' } });
});

test('a stale reporter cannot change a later cleanup or forge a terminal result', async () => {
  const f = fixture();
  await handlers.get(StorageDirectoryIpc.DeleteUpgradeBackup)!(f.event);
  const stale = mocks.deleteBackup.mock.calls[0][1] as (update: StorageCleanupProgressUpdate) => void;
  let finish!: (value: unknown) => void;
  mocks.clearCache.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const request = handlers.get(StorageDirectoryIpc.ClearBrowserCache)!(f.event);
  const reporter = mocks.clearCache.mock.calls[0][1] as (update: StorageCleanupProgressUpdate) => void;
  const before = await handlers.get(StorageDirectoryIpc.CleanupStatus)!(f.event);
  stale({ phase: StorageCleanupPhase.Removing });
  reporter({ phase: StorageCleanupPhase.Completed } as unknown as StorageCleanupProgressUpdate);
  expect(await handlers.get(StorageDirectoryIpc.CleanupStatus)!(f.event)).toEqual(before);
  reporter({ phase: StorageCleanupPhase.Clearing, sessionsCompleted: 1, sessionsTotal: 3,
    path: 'private-cache-path' } as StorageCleanupProgressUpdate);
  expect(await handlers.get(StorageDirectoryIpc.DeleteUpgradeBackup)!(f.event)).toEqual({ success: false, code: 'busy' });
  expect(await handlers.get(StorageDirectoryIpc.CleanupStatus)!(f.event)).toEqual({ success: true, value: {
    operationId: expect.any(String), kind: 'cache', phase: 'clearing', sessionsCompleted: 1, sessionsTotal: 3,
  } });

  finish({ success: true, value: null });
  await request;
  expect(await handlers.get(StorageDirectoryIpc.CleanupStatus)!(f.event)).toMatchObject({ value: { phase: 'completed' } });
  expect(mocks.showMessageBox).not.toHaveBeenCalled();
  expect(vi.mocked(console.info).mock.calls.flat().join(' ')).not.toContain('private-cache-path');
});

test('the parameter-free cache action uses only the current Main profile and its owning collector', async () => {
  const { event } = fixture();

  expect(await handlers.get(StorageDirectoryIpc.ClearBrowserCache)!(event)).toEqual({ success: true, value: null });
  expect(mocks.clearCache).toHaveBeenCalledOnce();
  expect(mocks.cacheOptions!.getDirectory()).toBe('current-profile');
  await mocks.cacheOptions!.collectSessions('current-profile');
  expect(mocks.collectSessions).toHaveBeenCalledExactlyOnceWith('current-profile');
  mocks.cacheOptions!.stopSessions!();
  expect(mocks.stopSessions).toHaveBeenCalledOnce();
  expect(mocks.deleteBackup).not.toHaveBeenCalled();
});

test('reserves the shared cleanup slot synchronously during backup preflight', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  mocks.deleteBackup.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const remove = () => handlers.get(StorageDirectoryIpc.DeleteUpgradeBackup)!(f.event);
  const clear = () => handlers.get(StorageDirectoryIpc.ClearBrowserCache)!(f.event);

  const operation = remove();
  expect(await clear()).toEqual({ success: false, code: 'busy' });
  expect(await remove()).toEqual({ success: false, code: 'busy' });
  expect(mocks.clearCache).not.toHaveBeenCalled();
  expect(mocks.cacheReady!()).toBe(false);
  expect(mocks.backupReady!('backup-root')).toBe(true);
  finish({ success: true, value: null });
  await operation;

  expect(await clear()).toEqual({ success: true, value: null });
});

test('a rejected cleanup releases its slot without retrying an uncertain operation', async () => {
  const f = fixture();
  mocks.clearCache.mockRejectedValueOnce(new Error('Uncertain cache response.'));

  expect(await handlers.get(StorageDirectoryIpc.ClearBrowserCache)!(f.event)).toEqual({ success: false, code: 'unavailable' });
  expect(await handlers.get(StorageDirectoryIpc.CleanupStatus)!(f.event)).toMatchObject({
    value: { phase: 'failed', errorCode: StorageDirectoryError.Unavailable },
  });
  expect(mocks.clearCache).toHaveBeenCalledOnce();
  expect(await handlers.get(StorageDirectoryIpc.DeleteUpgradeBackup)!(f.event)).toEqual({ success: true, value: null });
});

test('stop closes both cleanup entries and invalidates pending confirmation without awaiting its modal', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  mocks.deleteBackup.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const deletion = handlers.get(StorageDirectoryIpc.DeleteUpgradeBackup)!(f.event);
  const caller = mocks.deleteBackup.mock.calls[0][0] as () => boolean;
  expect(caller()).toBe(true);

  await f.controller.stop();

  expect(mocks.backupStop).toHaveBeenCalledOnce();
  expect(mocks.cacheStop).toHaveBeenCalledOnce();
  expect(caller()).toBe(false);
  expect(mocks.backupReady!('backup-root')).toBe(false);
  expect(mocks.cacheReady!()).toBe(false);
  const oldReport = mocks.deleteBackup.mock.calls[0][1] as (update: StorageCleanupProgressUpdate) => void;
  const logs = vi.mocked(console.info).mock.calls.length;
  oldReport({ phase: StorageCleanupPhase.Removing });
  expect(vi.mocked(console.info).mock.calls).toHaveLength(logs);
  expect(await handlers.get(StorageDirectoryIpc.CleanupStatus)!(f.event)).toEqual({ success: false, code: 'not-ready' });
  for (const channel of [StorageDirectoryIpc.DeleteUpgradeBackup, StorageDirectoryIpc.ClearBrowserCache])
    expect(await handlers.get(channel)!(f.event)).toEqual({ success: false, code: 'not-ready' });
  mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
  expect(await mocks.confirmDelete!('current-profile/backups')).toBe(false);
  finish({ success: false, code: 'not-ready' });
  await deletion;
});

test('stop synchronously closes both owners and still joins cache when backup stop throws', async () => {
  const f = fixture();
  let finishOther!: () => void;
  mocks.backupStop.mockImplementationOnce(() => { throw new Error('Retirement failed synchronously.'); });
  mocks.cacheStop.mockReturnValueOnce(new Promise<void>(resolve => { finishOther = resolve; }));
  let settled = false;
  const stopping = f.controller.stop();
  // No microtask may create another Session before the cache collector is stopped.
  expect(mocks.backupStop).toHaveBeenCalledOnce();
  expect(mocks.cacheStop).toHaveBeenCalledOnce();
  const rejection = expect(stopping).rejects.toThrow('Storage cleanup retirement failed.');
  void stopping.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(await handlers.get(StorageDirectoryIpc.ClearBrowserCache)!(f.event)).toEqual({ success: false, code: 'not-ready' });

  finishOther();
  await rejection;
  expect(f.controller.stop()).toBe(stopping);
});

// Exercise the owning Main composition rather than duplicating its admission rules.
const application = ts.createSourceFile('application.ts',
  fs.readFileSync(new URL('../../application.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true);
let maintenanceReadiness = '';
let storageRegistration = '';
const collectComposition = (node: ts.Node) => {
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && declaration.name.text === 'isStorageMaintenanceReady'))
    maintenanceReadiness = node.getText(application);
  if (ts.isCallExpression(node) && node.expression.getText(application) === 'registerStorageDirectoryHandlers')
    storageRegistration = node.getText(application);
  ts.forEachChild(node, collectComposition);
};
collectComposition(application);
if (!maintenanceReadiness || !storageRegistration)
  throw new Error('The Main storage maintenance composition must remain identifiable.');
const executeComposition = (code: string, context: Record<string, unknown>) =>
  new Function(...Object.keys(context), ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(...Object.values(context));

test('Main keeps cache admission independent from backup-only project references and closes both for migration', () => {
  let frozen = false;
  const backupReferences = vi.fn(() => true);
  const controller = executeComposition(`${maintenanceReadiness} return ${storageRegistration};`, {
    registerStorageDirectoryHandlers: (dependencies: unknown) => dependencies,
    mainWindow: {}, startupHistoryAdmissionReady: true,
    appShutdown: { isQuitting: () => false }, isStorageExecutionFrozen: () => frozen,
    getStorageBootstrapContext: () => undefined,
    readRelocationJournal: () => null, RelocationStage: { Activated: 'activated', Cancelled: 'cancelled' },
    isUpgradeBackupWorkingDirectory: backupReferences,
    getCoworkStore: () => ({ listReferencedWorkspaceDirectories: () => ['backup-project'] }),
    app: { getPath: () => 'current-profile' }, path,
  });

  expect(controller.isCacheReady()).toBe(true);
  expect(backupReferences).not.toHaveBeenCalled();
  expect(controller.isReady('selected-backup-root')).toBe(false);
  expect(backupReferences).toHaveBeenCalledExactlyOnceWith('selected-backup-root', 'backup-project');
  frozen = true;
  expect(controller.isCacheReady()).toBe(false);
  expect(controller.isReady('selected-backup-root')).toBe(false);
});
