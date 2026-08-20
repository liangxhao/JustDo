import { ipcMain } from 'electron';

import {
  type ExternalAgentDiagnosticsResult,
  ExternalAgentIpc,
  type ExternalAgentTestResult,
  isExternalAgentId,
} from '../../../shared/openclaw/externalAgents';
import type { ExternalAgentDiagnosticsService } from '../../openclaw/acp/externalAgentDiagnostics';

export const registerExternalAgentHandlers = (
  service: ExternalAgentDiagnosticsService,
): void => {
  ipcMain.handle(ExternalAgentIpc.List, async (): Promise<ExternalAgentDiagnosticsResult> => {
    try {
      return await service.list();
    } catch {
      return {
        success: false,
        backendAvailable: false,
        agents: [],
        error: 'Failed to inspect external agents',
      };
    }
  });

  ipcMain.handle(
    ExternalAgentIpc.Test,
    async (_event, agentId: unknown): Promise<ExternalAgentTestResult> => {
      if (!isExternalAgentId(agentId)) {
        return { success: false, error: 'Unsupported external agent' };
      }
      try {
        const diagnostic = await service.test(agentId);
        return { success: diagnostic.state === 'connected', diagnostic };
      } catch {
        return {
          success: false,
          error: 'Failed to test external agent',
        };
      }
    },
  );
};
