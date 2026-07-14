import { ipcMain } from 'electron';

import type { OpenClawRuntimeAdapter } from '../../engine';

export const registerCoworkSubtaskHandlers = (
  getRuntime: () => OpenClawRuntimeAdapter | null,
): void => {
  ipcMain.handle('cowork:subTask:status', async (_event, sessionId?: string) => {
    try {
      const runtime = getRuntime();
      if (!runtime) return { success: true, subagents: [] };
      const result = await runtime.getSubagentStatuses(sessionId);
      return { success: true, subagents: result.subagents || [] };
    } catch {
      return { success: false, subagents: [] };
    }
  });

  ipcMain.handle('cowork:subTask:session', async (_event, sessionKey: string) => {
    try {
      const runtime = getRuntime();
      if (!runtime) {
        return { success: false, session: null, error: 'OpenClaw runtime is not ready' };
      }
      if (!sessionKey || typeof sessionKey !== 'string') {
        return { success: false, session: null, error: 'Session key is required' };
      }
      return { success: true, session: await runtime.fetchSessionByKey(sessionKey) };
    } catch (error) {
      return {
        success: false,
        session: null,
        error: error instanceof Error ? error.message : 'Failed to get subagent session',
      };
    }
  });
};
