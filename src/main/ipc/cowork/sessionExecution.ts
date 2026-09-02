import { BrowserWindow, ipcMain } from 'electron';

import type { CoworkAttachmentPayload } from '../../../shared/cowork/attachments';
import { resolvePermissionMode } from '../../../shared/openclaw/approvals';
import { resolveTaskWorkingDirectory } from '../../core/taskWorkspace';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';
import type { OpenClawEngineStatus } from '../../openclaw/runtime/openclawEngineManager';

interface SessionExecutionHandlerDependencies {
  ensureEngineRunning: () => Promise<OpenClawEngineStatus>;
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  waitForConfigUpdates: () => Promise<void>;
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
  clientTurnId?: string;
  startedAt?: number;
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
  waitForConfigUpdates,
  getEngineNotReadyResponse,
}: SessionExecutionHandlerDependencies): void => {
  ipcMain.handle('cowork:session:start', async (_event, options: StartSessionOptions) => {
    try {
      if (!options || typeof options.prompt !== 'string' || !options.prompt.trim()) {
        return { success: false, error: 'Prompt is required.' };
      }
      await waitForConfigUpdates();
      const store = getCoworkStore();
      const existingTiming = options.clientTurnId
        ? store.getSessionRunByClientTurnId(options.clientTurnId)
        : undefined;
      if (existingTiming) {
        const existingSession = store.getSession(existingTiming.sessionId);
        if (existingSession) {
          return { success: true, session: existingSession, timing: existingTiming };
        }
      }
      const engineStatus = await ensureEngineRunning();
      if (engineStatus.phase !== 'running') {
        return getEngineNotReadyResponse(engineStatus);
      }

      const config = store.getConfig();
      const permissionMode = resolvePermissionMode(config.permissionMode);
      const selectedWorkspaceRoot = (options.cwd || config.workingDirectory || '').trim();
      if (!selectedWorkspaceRoot) {
        return { success: false, error: 'Please select a task folder before submitting.' };
      }

      const fallbackTitle = options.prompt.split('\n')[0].slice(0, 50) || 'New Session';
      const agentId = options.agentId || 'main';
      const initialModelRef = store.getAgent(agentId)?.model.trim() || undefined;
      const resolvedWorkspaceRoot = resolveTaskWorkingDirectory(selectedWorkspaceRoot);
      const session = store.createSession(
        options.title?.trim() || fallbackTitle,
        resolvedWorkspaceRoot,
        config.executionMode || 'local',
        options.activeSkillIds || [],
        agentId,
        permissionMode,
        initialModelRef,
      );
      store.updateSession(session.id, { status: 'running' });
      const timing =
        options.clientTurnId && Number.isFinite(options.startedAt)
          ? store.beginSessionRun({
              sessionId: session.id,
              clientTurnId: options.clientTurnId,
              startedAt: options.startedAt!,
              modelRef: initialModelRef,
            })
          : undefined;

      const run = getCoworkEngineRouter()
        .startSession(session.id, options.prompt, {
          skillIds: options.activeSkillIds,
          workspaceRoot: resolvedWorkspaceRoot,
          confirmationMode: 'modal',
          attachments: options.attachments,
          agentId: options.agentId,
          clientTurnId: options.clientTurnId,
        })
        .catch(error => {
          console.error('[Cowork] session error:', error);
          try {
            if (store.getSession(session.id)?.status !== 'error') {
              store.updateSession(session.id, { status: 'error' });
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
        ...(timing ? { timing } : {}),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start session',
      };
    }
  });

};
