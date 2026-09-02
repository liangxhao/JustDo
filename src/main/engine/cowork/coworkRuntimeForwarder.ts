import { BrowserWindow } from 'electron';

import { resolveCurrentApiConfig } from '../../cowork/providerApiConfig';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from './coworkEngineRouter';

const broadcast = (channel: string, payload: unknown): void => {
  BrowserWindow.getAllWindows().forEach(window => {
    if (window.isDestroyed()) return;
    try {
      window.webContents.send(channel, payload);
    } catch (error) {
      console.error(`[CoworkForwarder] Failed to broadcast ${channel}:`, error);
    }
  });
};

export const bindCoworkRuntimeForwarder = (
  runtime: CoworkEngineRouter,
  getCoworkStore: () => CoworkStore,
): void => {
  runtime.on('activity', (sessionId: string, kind: 'user' | 'other', timestamp: number) => {
    broadcast('cowork:session:activity', {
      sessionId,
      kind,
      timestamp,
    });
  });

  runtime.on(
    'complete',
    (sessionId: string, finalStatus?: string) => {
      broadcast('cowork:stream:complete', { sessionId, finalStatus });
      try {
        if (resolveCurrentApiConfig().providerMetadata?.providerName === 'justdo-server') {
          broadcast('auth:quotaChanged', undefined);
        }
      } catch {
        // Quota refresh is best effort.
      }
    },
  );

  runtime.on('error', (sessionId: string, error: string) => {
    try {
      getCoworkStore().updateSession(sessionId, { status: 'error' });
    } catch {
      // The stream error still needs to reach the renderer.
    }
    broadcast('cowork:stream:error', { sessionId, error });
  });
};
