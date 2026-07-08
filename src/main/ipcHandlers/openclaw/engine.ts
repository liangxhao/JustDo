import { ipcMain } from 'electron';

import type {
  OpenClawEngineManager,
  OpenClawEngineStatus,
} from '../../libs/openclaw/runtime/openclawEngineManager';

interface OpenClawEngineHandlerDependencies {
  getManager: () => OpenClawEngineManager;
}

const isAvailable = (status: OpenClawEngineStatus): boolean =>
  status.phase === 'running' || status.phase === 'ready';

export const registerOpenClawEngineHandlers = ({
  getManager,
}: OpenClawEngineHandlerDependencies): void => {
  let restartGatewayPromise: Promise<OpenClawEngineStatus> | null = null;

  ipcMain.handle('openclaw:engine:getStatus', async () => {
    try {
      return { success: true, status: getManager().getStatus() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw engine status',
      };
    }
  });

  ipcMain.handle('openclaw:engine:restartGateway', async () => {
    if (restartGatewayPromise) {
      const status = await restartGatewayPromise;
      return { success: isAvailable(status), status };
    }
    try {
      restartGatewayPromise = getManager().restartGateway();
      const status = await restartGatewayPromise;
      return { success: isAvailable(status), status };
    } catch (error) {
      return {
        success: false,
        status: getManager().getStatus(),
        error: error instanceof Error ? error.message : 'Failed to restart OpenClaw gateway',
      };
    } finally {
      restartGatewayPromise = null;
    }
  });

  ipcMain.handle('openclaw:engine:getPort', () => {
    try {
      return { success: true, port: getManager().getGatewayPort() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw gateway port',
      };
    }
  });

  ipcMain.handle('openclaw:engine:getToken', () => {
    try {
      const manager = getManager();
      let token = manager.getGatewayToken();
      const status = manager.getStatus();
      if (token === null && status.phase === 'running') {
        console.log('[OpenClawEngine] Gateway running but token is null, checking connection info');
        token = manager.getGatewayConnectionInfo().token;
      }
      if (token === null) {
        if (status.phase !== 'running') {
          return { success: false, error: 'Gateway not running' };
        }
        console.warn('[OpenClawEngine] Gateway is running but token is unavailable');
        return {
          success: false,
          error: 'Gateway token not available. Try restarting the gateway.',
        };
      }
      return { success: true, token };
    } catch (error) {
      console.error('[OpenClawEngine] Failed to get gateway token:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw gateway token',
      };
    }
  });

  ipcMain.handle('openclaw:engine:setPort', (_event, port: number) => {
    try {
      return getManager().setGatewayPort(port);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set OpenClaw gateway port',
      };
    }
  });
};
