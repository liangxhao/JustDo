import { BrowserWindow, ipcMain } from 'electron';

import type { CoworkAttachmentPayload } from '../../../shared/cowork/attachments';
import { resolvePermissionMode } from '../../../shared/openclaw/approvals';
import { resolveTaskWorkingDirectory } from '../../core/taskWorkspace';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';
import type { PermissionModeOperationResult } from '../../openclaw/permissions/sessionPermissionModeCoordinator';
import type { OpenClawEngineStatus } from '../../openclaw/runtime/openclawEngineManager';

interface SessionExecutionHandlerDependencies {
  ensureEngineRunning: () => Promise<OpenClawEngineStatus>;
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  acquirePermissionModeForTurn: (
    permissionMode: ReturnType<typeof resolvePermissionMode>,
  ) => Promise<PermissionModeOperationResult>;
  getEngineNotReadyResponse: (status: OpenClawEngineStatus) => {
    success: boolean;
    code: string;
    error: string;
    engineStatus: OpenClawEngineStatus;
  };
}

interface StartSessionOptions {
  prompt: string;
  cwd?: string;
  title?: string;
  activeSkillIds?: string[];
  attachments?: CoworkAttachmentPayload[];
  agentId?: string;
  permissionMode?: unknown;
}

interface ContinueSessionOptions {
  sessionId: string;
  prompt: string;
  activeSkillIds?: string[];
  attachments?: CoworkAttachmentPayload[];
}

const broadcastSessionError = (sessionId: string, error: unknown): void => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  BrowserWindow.getAllWindows().forEach(window => {
    if (window.isDestroyed()) return;
    window.webContents.send('cowork:stream:error', { sessionId, error: errorMessage });
  });
};

export const registerCoworkSessionExecutionHandlers = ({
  ensureEngineRunning,
  getCoworkStore,
  getCoworkEngineRouter,
  acquirePermissionModeForTurn,
  getEngineNotReadyResponse,
}: SessionExecutionHandlerDependencies): void => {
  ipcMain.handle('cowork:session:start', async (_event, options: StartSessionOptions) => {
    try {
      const permissionMode = resolvePermissionMode(options.permissionMode);
      const permissionResult = await acquirePermissionModeForTurn(permissionMode);
      if ('error' in permissionResult) {
        return {
          success: false,
          error: permissionResult.error,
          ...(permissionResult.status
            ? { code: 'ENGINE_NOT_READY', engineStatus: permissionResult.status }
            : {}),
        };
      }
      const engineStatus = await ensureEngineRunning();
      if (engineStatus.phase !== 'running') {
        return getEngineNotReadyResponse(engineStatus);
      }

      const store = getCoworkStore();
      const config = store.getConfig();
      const selectedWorkspaceRoot = (options.cwd || config.workingDirectory || '').trim();
      if (!selectedWorkspaceRoot) {
        return { success: false, error: 'Please select a task folder before submitting.' };
      }

      const fallbackTitle = options.prompt.split('\n')[0].slice(0, 50) || 'New Session';
      const agentId = options.agentId || 'main';
      const initialModelRef = store.getAgent(agentId)?.model.trim() || undefined;
      const session = store.createSession(
        options.title?.trim() || fallbackTitle,
        resolveTaskWorkingDirectory(selectedWorkspaceRoot),
        config.executionMode || 'local',
        options.activeSkillIds || [],
        agentId,
        permissionMode,
        initialModelRef,
      );
      store.updateSession(session.id, { status: 'running' });

      const messageMetadata: Record<string, unknown> = {};
      if (options.activeSkillIds?.length) messageMetadata.skillIds = options.activeSkillIds;
      if (options.attachments?.length) {
        messageMetadata.attachments = options.attachments;
      }
      store.addMessage(session.id, {
        type: 'user',
        content: options.prompt,
        metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
      });

      const run = getCoworkEngineRouter()
        .startSession(session.id, options.prompt, {
          skipInitialUserMessage: true,
          skillIds: options.activeSkillIds,
          workspaceRoot: selectedWorkspaceRoot,
          confirmationMode: 'modal',
          attachments: options.attachments,
          agentId: options.agentId,
        })
        .catch(error => {
          console.error('[Cowork] session error:', error);
          try {
            if (store.getSession(session.id)?.status !== 'error') {
              broadcastSessionError(session.id, error);
            }
          } catch (handlerError) {
            console.error('[Cowork] failed to send error notification to renderer:', handlerError);
          }
        });
      void run;

      return {
        success: true,
        session: store.getSession(session.id) || { ...session, status: 'running' as const },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start session',
      };
    }
  });

  ipcMain.handle('cowork:session:continue', async (_event, options: ContinueSessionOptions) => {
    try {
      const session = getCoworkStore().getSession(options.sessionId);
      if (!session) return { success: false, error: 'Session not found.' };
      const permissionResult = await acquirePermissionModeForTurn(session.permissionMode);
      if ('error' in permissionResult) {
        return {
          success: false,
          error: permissionResult.error,
          ...(permissionResult.status
            ? { code: 'ENGINE_NOT_READY', engineStatus: permissionResult.status }
            : {}),
        };
      }
      const engineStatus = await ensureEngineRunning();
      if (engineStatus.phase !== 'running') {
        return getEngineNotReadyResponse(engineStatus);
      }

      const run = getCoworkEngineRouter()
        .continueSession(options.sessionId, options.prompt, {
          skillIds: options.activeSkillIds,
          attachments: options.attachments,
        })
        .catch(error => {
          console.error('[Cowork] continue error:', error);
          try {
            if (getCoworkStore().getSession(options.sessionId)?.status !== 'error') {
              broadcastSessionError(options.sessionId, error);
            }
          } catch (handlerError) {
            console.error('[Cowork] failed to send error notification to renderer:', handlerError);
          }
        });
      void run;

      return { success: true, session: getCoworkStore().getSession(options.sessionId) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to continue session',
      };
    }
  });
};
