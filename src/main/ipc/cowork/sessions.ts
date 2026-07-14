import { ipcMain } from 'electron';

import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';

interface SessionHandlerDependencies {
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
}

export const registerCoworkSessionHandlers = ({
  getCoworkStore,
  getCoworkEngineRouter,
}: SessionHandlerDependencies): void => {
  ipcMain.handle('cowork:session:stop', async (_event, sessionId: string) => {
    try {
      getCoworkEngineRouter().stopSession(sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop session',
      };
    }
  });

  ipcMain.handle('cowork:session:delete', async (_event, sessionId: string) => {
    try {
      getCoworkEngineRouter().stopSession(sessionId);
      const store = getCoworkStore();
      const agentId = store.getSession(sessionId)?.agentId || 'main';
      store.deleteSession(sessionId);
      try {
        getCoworkEngineRouter().onSessionDeleted(sessionId, agentId);
      } catch {
        // The persisted deletion succeeded; cache cleanup is best effort.
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete session',
      };
    }
  });

  ipcMain.handle('cowork:message:delete', async (_event, sessionId: string, messageId: string) => {
    try {
      return { success: getCoworkStore().deleteMessage(sessionId, messageId) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete message',
      };
    }
  });

  ipcMain.handle(
    'cowork:message:deleteFrom',
    async (_event, sessionId: string, messageId: string) => {
      try {
        return { success: getCoworkStore().deleteMessagesFrom(sessionId, messageId) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete messages',
        };
      }
    },
  );

  ipcMain.handle('cowork:session:deleteBatch', async (_event, sessionIds: string[]) => {
    try {
      const router = getCoworkEngineRouter();
      const store = getCoworkStore();
      const agentIds = new Map(
        sessionIds.map(sessionId => [sessionId, store.getSession(sessionId)?.agentId || 'main']),
      );
      sessionIds.forEach(sessionId => router.stopSession(sessionId));
      store.deleteSessions(sessionIds);
      sessionIds.forEach(sessionId => {
        try {
          router.onSessionDeleted(sessionId, agentIds.get(sessionId) || 'main');
        } catch {
          // The persisted deletion succeeded; cache cleanup is best effort.
        }
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to batch delete sessions',
      };
    }
  });

  ipcMain.handle(
    'cowork:session:pin',
    async (_event, options: { sessionId: string; pinned: boolean }) => {
      try {
        getCoworkStore().setSessionPinned(options.sessionId, options.pinned);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update session pin',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:session:rename',
    async (_event, options: { sessionId: string; title: string }) => {
      try {
        const title = options.title.trim();
        if (!title) return { success: false, error: 'Title is required' };
        getCoworkStore().updateSession(options.sessionId, { title });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to rename session',
        };
      }
    },
  );

  ipcMain.handle('cowork:session:get', async (_event, sessionId: string) => {
    try {
      return { success: true, session: getCoworkStore().getSession(sessionId) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session',
      };
    }
  });

  ipcMain.handle('cowork:session:list', async (_event, agentId?: string) => {
    try {
      return { success: true, sessions: getCoworkStore().listSessions(agentId) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list sessions',
      };
    }
  });

  ipcMain.handle('cowork:session:remoteManaged', async (_event, sessionId: string) => {
    try {
      const agentId = getCoworkStore().getSession(sessionId)?.agentId;
      return { success: true, remoteManaged: !!agentId && agentId !== 'main' };
    } catch (error) {
      return {
        success: false,
        remoteManaged: false,
        error: error instanceof Error ? error.message : 'Failed to check remote managed status',
      };
    }
  });

  ipcMain.handle(
    'cowork:session:runtimeStatus',
    async (_event, sessionId: string, options?: { includeSubagents?: boolean }) => {
      try {
        return {
          success: true,
          ...(await getCoworkEngineRouter().getSessionRuntimeStatus(sessionId, options)),
        };
      } catch (error) {
        return {
          success: false,
          mainRunning: false,
          subagentRunning: false,
          running: false,
          error: error instanceof Error ? error.message : 'Failed to get session runtime status',
        };
      }
    },
  );
};
