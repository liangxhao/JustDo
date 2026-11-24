import { type BrowserWindow, dialog, ipcMain } from 'electron';

import {
  HistoryRecoveryIpc,
  type HistoryWorkspaceResult,
} from '../../../shared/app/startup/history';
import { isHistoryWorkspaceAvailable } from '../../cowork/sessions/historyWorkspace';
import type { CoworkStore } from '../../data/coworkStore';
import type { SqliteStore } from '../../data/sqliteStore';

export function registerHistoryRecoveryHandlers(deps: {
  getWindow: () => BrowserWindow | null;
  isReady: () => boolean;
  getStore: () => SqliteStore;
  getCoworkStore: () => CoworkStore;
}): void {
  ipcMain.handle(
    HistoryRecoveryIpc.SelectWorkspace,
    async (event, input: unknown): Promise<HistoryWorkspaceResult> => {
      try {
        const window = deps.getWindow();
        const isAllowed = (window: BrowserWindow): boolean =>
          deps.isReady() && !window.isDestroyed() && event.sender === window.webContents &&
          event.senderFrame === window.webContents.mainFrame;
        if (!window || !isAllowed(window)) throw new Error('Invalid history recovery caller.');
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).length !== 1 ||
          !('sessionId' in input) ||
          typeof input.sessionId !== 'string' ||
          !input.sessionId.trim()
        )
          throw new Error('Invalid conversation identity.');
        const id = input.sessionId;
        const store = deps.getCoworkStore();
        const validate = () => {
          const session = store.getSession(id);
          const open = deps
            .getStore()
            .getDatabase()
            .prepare(
              'SELECT 1 FROM cowork_session_runs WHERE session_id=? AND ended_at IS NULL LIMIT 1',
            )
            .get(id);
          if (!session?.historyBinding || session.status === 'running' || open)
            throw new Error(
              'This historical conversation cannot change its missing workspace now.',
            );
          return session;
        };
        const before = validate();
        if (await isHistoryWorkspaceAvailable(before.cwd)) {
          throw new Error('This historical conversation cannot change its missing workspace now.');
        }
        if (deps.getWindow() !== window || !isAllowed(window))
          throw new Error('Invalid history recovery caller.');
        const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
        if (selected.canceled || selected.filePaths.length !== 1)
          return { success: false, cancelled: true };
        const cwd = selected.filePaths[0];
        const [oldWorkspaceAvailable, selectedWorkspaceAvailable] = await Promise.all([
          isHistoryWorkspaceAvailable(before.cwd),
          isHistoryWorkspaceAvailable(cwd),
        ]);
        const current = validate();
        if (
          deps.getWindow() !== window ||
          !isAllowed(window) ||
          current.cwd !== before.cwd ||
          current.historyBinding?.sessionKey !== before.historyBinding?.sessionKey ||
          current.historyBinding?.nativeSessionId !== before.historyBinding?.nativeSessionId
        )
          throw new Error('The historical conversation changed while selecting its workspace.');
        if (oldWorkspaceAvailable)
          throw new Error('This historical conversation cannot change its missing workspace now.');
        if (!selectedWorkspaceAvailable)
          throw new Error('The selected workspace is unavailable.');
        store.updateSession(id, { cwd });
        return { success: true, cwd };
      } catch (error) {
        console.warn('[HistoryRecovery] Workspace selection failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Workspace selection failed.',
        };
      }
    },
  );
}
