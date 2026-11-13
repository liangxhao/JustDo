import { ipcMain } from 'electron';

import {
  type AutomaticErrorRetryActivitySnapshot,
  AutomaticErrorRetryIpc,
} from '../../../shared/cowork/automaticErrorRetry';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';
import { buildRetryHistoryPresentations } from '../../engine/openclaw/automaticErrorRetry/historyPresentation';

export function registerAutomaticErrorRetryHandlers(dependencies: {
  isAllowedSender: (event: Electron.IpcMainInvokeEvent) => boolean;
  getStore: () => CoworkStore;
  getRouter: () => CoworkEngineRouter;
  getActivity: () => AutomaticErrorRetryActivitySnapshot | null;
}): void {
  ipcMain.handle(AutomaticErrorRetryIpc.GetActivity, event => {
    if (!dependencies.isAllowedSender(event)) return null;
    return dependencies.getActivity();
  });
  ipcMain.handle(AutomaticErrorRetryIpc.Get, (event, sessionId: unknown) => {
    if (!dependencies.isAllowedSender(event) || typeof sessionId !== 'string' || !sessionId.trim())
      return { success: false, error: 'Invalid retry presentation request.' };
    const store = dependencies.getStore();
    if (!store.getSession(sessionId)) return { success: false, error: 'Conversation not found.' };
    const presentation = dependencies.getRouter().getAutomaticErrorRetry(sessionId);
    const historical = buildRetryHistoryPresentations(sessionId, store.getSessionRuns(sessionId));
    return {
      success: true,
      presentation,
      presentations: [
        ...historical.filter(item => item.chainId !== presentation?.chainId),
        ...(presentation ? [presentation] : []),
      ],
    };
  });
}
