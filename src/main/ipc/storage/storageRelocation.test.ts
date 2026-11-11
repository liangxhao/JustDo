import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, expect, test, vi } from 'vitest';

import { StorageRelocationIpc } from '../../../shared/storage/storageRelocation';
import type { StorageRelocationController } from '../../storage/storageRelocationController';
import { registerStorageRelocationHandlers } from './storageRelocation';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => handlers.set(channel, handler),
  },
}));
beforeEach(() => handlers.clear());
function fixture() {
  const mainFrame = {};
  const contents = { mainFrame, isDestroyed: vi.fn(() => false) };
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) };
  const controller = { status: vi.fn(), prepare: vi.fn(), commit: vi.fn(), discard: vi.fn() };
  const getController = vi.fn(() => controller as unknown as StorageRelocationController);
  registerStorageRelocationHandlers({
    getMainWindow: () => window as unknown as BrowserWindow,
    getController,
  });
  return {
    controller,
    getController,
    window,
    contents,
    event: { sender: contents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent,
  };
}

test('accepts only fixed operations and opaque plan identities from the main frame', () => {
  const f = fixture();
  const planId = '5fbaab80-1046-4ab1-b018-3c94fe54778e';
  handlers.get(StorageRelocationIpc.Status)!(f.event);
  handlers.get(StorageRelocationIpc.Prepare)!(f.event);
  handlers.get(StorageRelocationIpc.Commit)!(f.event, planId);
  handlers.get(StorageRelocationIpc.Discard)!(f.event, planId);
  expect(f.controller.status).toHaveBeenCalledWith();
  expect(f.controller.prepare).toHaveBeenCalledWith();
  expect(f.controller.commit).toHaveBeenCalledWith(planId);
  expect(f.controller.discard).toHaveBeenCalledWith(planId);
  expect(handlers.size).toBe(4);
});

test('rejects embedded senders, subframes and Renderer path payloads before resolving the controller', () => {
  const f = fixture();
  for (const channel of [
    StorageRelocationIpc.Status,
    StorageRelocationIpc.Prepare,
    StorageRelocationIpc.Commit,
    StorageRelocationIpc.Discard,
  ]) {
    const handler = handlers.get(channel)!;
    expect(handler({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent)).toEqual({
      success: false,
      code: 'unavailable',
    });
    expect(
      handler({ ...f.event, sender: { isDestroyed: () => false } } as IpcMainInvokeEvent),
    ).toEqual({ success: false, code: 'unavailable' });
    expect(handler(f.event, { targetPath: 'C:\\untrusted' })).toEqual({
      success: false,
      code: 'unavailable',
    });
  }
  expect(handlers.get(StorageRelocationIpc.Commit)!(f.event, 'C:\\untrusted')).toEqual({
    success: false,
    code: 'unavailable',
  });
  expect(handlers.get(StorageRelocationIpc.Discard)!(f.event)).toEqual({
    success: false,
    code: 'unavailable',
  });
  expect(f.getController).not.toHaveBeenCalled();
});
