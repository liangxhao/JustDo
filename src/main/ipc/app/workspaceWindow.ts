import { ipcMain } from 'electron';

import { WorkspaceWindowIpc } from '../../../shared/cowork/workspaceWindow';
import { getWorkspaceWindowManager } from '../../core/window/workspaceWindowManager';

export const registerWorkspaceWindowHandlers = (): void => {
  const resolve = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) =>
    event.senderFrame?.processId === event.sender.mainFrame.processId &&
    event.senderFrame?.routingId === event.sender.mainFrame.routingId
      ? getWorkspaceWindowManager(event.sender.id)
      : undefined;
  ipcMain.handle(WorkspaceWindowIpc.Prepare, event => resolve(event)?.prepare() ?? null);
  ipcMain.on(WorkspaceWindowIpc.Update, (event, update: unknown) =>
    resolve(event)?.updateLayout(update),
  );
  ipcMain.handle(
    WorkspaceWindowIpc.SetDetached,
    (event, generation: unknown, detached: unknown) =>
      resolve(event)?.setDetached(generation, detached) ?? { success: false },
  );
  ipcMain.on(WorkspaceWindowIpc.FocusMain, event => resolve(event)?.focusMain());
  ipcMain.on(WorkspaceWindowIpc.Focus, event => resolve(event)?.focus());
  ipcMain.handle(WorkspaceWindowIpc.GetWindowState, (event, generation: unknown) =>
    resolve(event)?.getWindowState(generation) ?? null,
  );
  ipcMain.on(
    WorkspaceWindowIpc.Control,
    (event, generation: unknown, action: unknown, position: unknown) =>
      resolve(event)?.control(generation, action, position),
  );
};
