import { ipcMain } from 'electron';

import { saveCoworkApiConfig } from '../../cowork/coworkConfigStore';
import { probeCoworkModelReadiness } from '../../cowork/coworkModelReadiness';
import { getCurrentApiConfig, resolveCurrentApiConfig } from '../../cowork/providerApiConfig';

interface TitleGenerator {
  generateTitle?: (userInput: string | null) => Promise<string>;
}

interface CoworkUtilitiesHandlerOptions {
  getTitleGenerator: () => TitleGenerator;
  listRecentCwds: (limit: number) => unknown;
}

export const registerCoworkUtilityHandlers = ({
  getTitleGenerator,
  listRecentCwds,
}: CoworkUtilitiesHandlerOptions): void => {
  ipcMain.handle('generate-session-title', async (_event, userInput: string | null) => {
    try {
      const router = getTitleGenerator();
      if (router.generateTitle) {
        return await router.generateTitle(userInput);
      }
      console.warn('[CoworkUtilities] title generator unavailable; using fallback title');
    } catch (error) {
      console.warn('[CoworkUtilities] title generation failed:', error);
    }
    const fallback = 'New Session';
    const normalizedInput = typeof userInput === 'string' ? userInput.trim() : '';
    if (!normalizedInput) return fallback;
    const firstLine =
      normalizedInput
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(Boolean) || '';
    return firstLine.slice(0, 50).trim() || fallback;
  });

  ipcMain.handle('get-recent-cwds', async (_event, limit?: number) => {
    const boundedLimit = limit ? Math.min(Math.max(limit, 1), 20) : 8;
    return listRecentCwds(boundedLimit);
  });

  ipcMain.handle('get-api-config', async () => {
    return getCurrentApiConfig();
  });

  ipcMain.handle('check-api-config', async (_event, options?: { probeModel?: boolean }) => {
    const { config, error } = resolveCurrentApiConfig();
    if (config && options?.probeModel) {
      const probe = await probeCoworkModelReadiness();
      if (probe.ok === false) {
        return { hasConfig: false, config: null, error: probe.error };
      }
    }
    return { hasConfig: config !== null, config, error };
  });

  ipcMain.handle(
    'save-api-config',
    async (
      _event,
      config: {
        apiKey: string;
        baseURL: string;
        model: string;
        apiType?: 'openai';
      },
    ) => {
      try {
        saveCoworkApiConfig(config);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save API config',
        };
      }
    },
  );
};
