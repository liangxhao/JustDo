import { ipcMain } from 'electron';

import { AppPluginIpc } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import type { AppPluginManager } from '../../plugins/app/manager';

export const registerAppPluginHandlers = (
  getManager: () => AppPluginManager,
  isApplicationRenderer: (contents: Electron.WebContents) => boolean,
): void => {
  const authorized = (event: Electron.IpcMainInvokeEvent): boolean => {
    return event.senderFrame === event.sender.mainFrame && isApplicationRenderer(event.sender);
  };
  ipcMain.handle(AppPluginIpc.Snapshot, async event => {
    if (!authorized(event)) return [];
    await getManager().refresh();
    return getManager().snapshot();
  });
  ipcMain.handle(AppPluginIpc.Invoke, (event, input: unknown) =>
    authorized(event)
      ? getManager().invoke(input)
      : { success: false, error: 'appPluginUnavailable' },
  );
  ipcMain.handle(AppPluginIpc.Review, (event, id: string) =>
    authorized(event) ? getManager().review(id) : null,
  );
  ipcMain.handle(
    AppPluginIpc.Approve,
    async (event, input: { id: string; hash: string; token: string }) => {
      if (!authorized(event)) return { success: false };
      try {
        return await getManager().approve(input);
      } catch {
        return { success: false };
      }
    },
  );
};
