import { BrowserWindow } from 'electron';

import { resolveCurrentApiConfig } from '../../cowork/providerApiConfig';
import type { CoworkMessage, CoworkStore } from '../../data/coworkStore';
import {
  sanitizeCoworkMessageForIpc,
  truncateIpcString,
} from '../../ipc/payloadSanitizer';
import type { CoworkEngineRouter } from './coworkEngineRouter';

const IPC_UPDATE_CONTENT_MAX_CHARS = 120_000;

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
  runtime.on('message', (sessionId: string, message: unknown) => {
    const safeMessage = sanitizeCoworkMessageForIpc(message);
    const messageType =
      typeof message === 'object' && message && 'type' in message
        ? (message as { type?: unknown }).type
        : undefined;
    const forwardedMessage = message as CoworkMessage;

    if (
      messageType === 'subagent_completion' ||
      messageType === 'assistant' ||
      messageType === 'system' ||
      messageType === 'user'
    ) {
      try {
        getCoworkStore().insertMessageWithId(sessionId, forwardedMessage);
      } catch (error) {
        console.error('[CoworkForwarder] Failed to persist message:', error);
      }
    }

    broadcast('cowork:stream:message', {
      sessionId,
      message: {
        ...(safeMessage as Record<string, unknown>),
        ...(forwardedMessage.modelName ? { modelName: forwardedMessage.modelName } : {}),
      },
    });
  });

  runtime.on('messageUpdate', (sessionId: string, messageId: string, content: string) => {
    broadcast('cowork:stream:messageUpdate', {
      sessionId,
      messageId,
      content: truncateIpcString(content, IPC_UPDATE_CONTENT_MAX_CHARS),
    });
  });

  runtime.on('thinkingUpdate', (sessionId: string, messageId: string, thinkingDelta: string) => {
    broadcast('cowork:stream:thinkingUpdate', {
      sessionId,
      messageId,
      thinkingDelta: truncateIpcString(thinkingDelta, IPC_UPDATE_CONTENT_MAX_CHARS),
    });
  });

  runtime.on(
    'messageMetadataUpdate',
    (
      sessionId: string,
      messageId: string,
      metadata: Partial<NonNullable<CoworkMessage['metadata']>>,
      extra?: {
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      },
    ) => {
      broadcast('cowork:stream:messageMetadataUpdate', {
        sessionId,
        messageId,
        metadata,
        ...extra,
      });
    },
  );

  runtime.on('messageDelete', (sessionId: string, messageId: string) => {
    broadcast('cowork:stream:messageDelete', { sessionId, messageId });
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
