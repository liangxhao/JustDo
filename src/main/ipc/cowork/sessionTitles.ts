import { ipcMain } from 'electron';

import { normalizeSessionDisplayName } from '../../../../plugins/extensions/runtime-services/contracts/session-display-name';
import {
  type GenerateSessionTitleRequest,
  type RenameSessionRequest,
  SessionTitleIpc,
} from '../../../shared/cowork/sessionTitle';
import { createSessionTitleOperations } from '../../cowork/sessions/sessionTitles';

export function registerSessionTitleHandlers({
  isAllowedSender,
  ...deps
}: Parameters<typeof createSessionTitleOperations>[0] & {
  isAllowedSender: (event: Electron.IpcMainInvokeEvent) => boolean;
}): void {
  const operations = createSessionTitleOperations(deps);
  ipcMain.handle(SessionTitleIpc.Generate, async (event, request: GenerateSessionTitleRequest) => {
    if (
      !isAllowedSender(event) ||
      typeof request?.sessionId !== 'string' ||
      typeof request.expectedTitle !== 'string' ||
      typeof request.userInput !== 'string'
    )
      return null;
    const { nativeTarget } = request;
    if (
      typeof nativeTarget?.sessionKey !== 'string' ||
      typeof nativeTarget.nativeSessionId !== 'string' ||
      (nativeTarget.lifecycleRevision !== null &&
        typeof nativeTarget.lifecycleRevision !== 'string')
    )
      return null;
    try {
      return await operations.generate(request);
    } catch {
      console.warn('[SessionTitles] Automatic title could not be saved.');
      return null;
    }
  });

  ipcMain.handle(SessionTitleIpc.Rename, async (event, request: RenameSessionRequest) => {
    const title = normalizeSessionDisplayName(request?.title);
    if (!isAllowedSender(event) || typeof request?.sessionId !== 'string' || !title) {
      return { success: false };
    }
    try {
      const savedTitle = await operations.rename(request.sessionId, title);
      return savedTitle === null ? { success: false } : { success: true, title: savedTitle };
    } catch {
      console.warn('[SessionTitles] Manual title could not be saved.');
      return { success: false };
    }
  });
}
