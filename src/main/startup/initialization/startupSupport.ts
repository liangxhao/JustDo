import { type BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  AppInitializationPhase,
  type AppInitializationState,
} from '../../../shared/app/initialization';
import {
  StartupSupportAction,
  StartupSupportIpc,
  type StartupSupportResult,
} from '../../../shared/app/startup/history';

/** Main resolves every target; Renderer never supplies a filesystem or executable path. */
export function registerStartupSupportHandlers(deps: {
  getWindow: () => BrowserWindow | null;
  getState: () => AppInitializationState;
  getBackupDirectory: () => string | null;
  platform?: NodeJS.Platform;
}): void {
  ipcMain.handle(
    StartupSupportIpc.Open,
    async (event, input: unknown): Promise<StartupSupportResult> => {
      try {
        const window = deps.getWindow();
        if (
          !window ||
          window.isDestroyed() ||
          event.sender !== window.webContents ||
          event.senderFrame !== event.sender.mainFrame
        )
          return { success: false };
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).length !== 1 ||
          !('action' in input)
        )
          return { success: false };
        const state = deps.getState();
        let target: string | null = null;
        if (input.action === StartupSupportAction.OpenBackup && state.historySummary)
          target = deps.getBackupDirectory();
        else if (state.phase === AppInitializationPhase.Failed) {
          if (input.action === StartupSupportAction.OpenData) target = state.userDataPath;
          else if (
            input.action === StartupSupportAction.OpenTaskManager &&
            (deps.platform ?? process.platform) === 'win32'
          )
            target = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'Taskmgr.exe');
        }
        if (!target || !fs.existsSync(target)) return { success: false };
        return { success: !(await shell.openPath(target)) };
      } catch (error) {
        console.warn('[StartupSupport] Could not open startup support target:', error);
        return { success: false };
      }
    },
  );
}
