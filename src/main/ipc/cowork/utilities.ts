import { ipcMain } from 'electron';

import { type CoworkApiConfig, saveCoworkApiConfig } from '../../cowork/coworkConfigStore';
import { probeCoworkModelReadiness } from '../../providers/modelReadiness';
import { resolveRendererApiConfig } from '../../providers/providerApiConfig';

interface CoworkUtilitiesHandlerOptions {
  listRecentCwds: (limit: number) => unknown;
}

export const registerCoworkUtilityHandlers = ({
  listRecentCwds,
}: CoworkUtilitiesHandlerOptions): void => {
  ipcMain.handle('get-recent-cwds', async (_event, limit?: number) => {
    const boundedLimit = limit ? Math.min(Math.max(limit, 1), 20) : 8;
    return listRecentCwds(boundedLimit);
  });

  ipcMain.handle('get-api-config', async () => {
    return resolveRendererApiConfig().config;
  });

  ipcMain.handle('check-api-config', async (_event, options?: { probeModel?: boolean }) => {
    const { config, error } = resolveRendererApiConfig();
    if (config && options?.probeModel) {
      const probe = await probeCoworkModelReadiness();
      if (probe.ok === false) {
        return { hasConfig: false, config: null, error: probe.error };
      }
    }
    return { hasConfig: config !== null, config, error };
  });

  ipcMain.handle('save-api-config', async (_event, config: CoworkApiConfig) => {
    try {
      saveCoworkApiConfig(config);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save API config',
      };
    }
  });
};
