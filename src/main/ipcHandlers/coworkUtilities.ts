import { ipcMain } from 'electron';

import { saveCoworkApiConfig } from '../libs/cowork/coworkConfigStore';
import { probeCoworkModelReadiness } from '../libs/cowork/coworkUtil';
import { getCurrentApiConfig, resolveCurrentApiConfig } from '../libs/cowork/providerApiConfig';

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
    // Use Gateway-based title generation (reuses session authentication)
    console.log('[main] generate-session-title: attempting Gateway-based generation...');
    try {
      const router = getTitleGenerator();
      console.log(
        '[main] generate-session-title: router exists, hasGenerateTitle=',
        !!router.generateTitle,
      );
      if (router.generateTitle) {
        console.log('[main] generate-session-title: calling router.generateTitle...');
        const title = await router.generateTitle(userInput);
        console.log('[main] generate-session-title: Gateway result=', title);
        return title;
      }
      console.warn(
        '[main] generate-session-title: router.generateTitle not available, using simple fallback',
      );
    } catch (error) {
      console.warn('[main] Gateway-based title generation failed:', error);
    }
    // Simple fallback when Gateway is completely unavailable (no HTTP method)
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
