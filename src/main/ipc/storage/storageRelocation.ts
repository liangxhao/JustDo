import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { StorageRelocationIpc } from '../../../shared/storage/storageRelocation';
import type { StorageRelocationController } from '../../storage/storageRelocationController';

export function registerStorageRelocationHandlers(deps: {
  getMainWindow: () => BrowserWindow | null;
  getController: () => StorageRelocationController;
}): void {
  const allowed = (event: IpcMainInvokeEvent): boolean => {
    const window = deps.getMainWindow();
    return (
      !!window &&
      !window.isDestroyed() &&
      !event.sender.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame
    );
  };
  for (const channel of [
    StorageRelocationIpc.Status,
    StorageRelocationIpc.Prepare,
    StorageRelocationIpc.Commit,
    StorageRelocationIpc.Discard,
  ]) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (
        !allowed(event) ||
        (channel === StorageRelocationIpc.Commit || channel === StorageRelocationIpc.Discard
          ? args.length !== 1 || typeof args[0] !== 'string' || !/^[a-f0-9-]{36}$/.test(args[0])
          : args.length !== 0)
      )
        return { success: false, code: 'unavailable' };
      const controller = deps.getController();
      if (channel === StorageRelocationIpc.Status) return controller.status();
      if (channel === StorageRelocationIpc.Prepare) return controller.prepare();
      if (channel === StorageRelocationIpc.Discard) return controller.discard(args[0] as string);
      return controller.commit(args[0] as string);
    });
  }
}
