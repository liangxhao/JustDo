import { BrowserWindow } from 'electron';

import type { CoworkMessage, CoworkStore } from '../../coworkStore';
import {
  sanitizeCoworkMessageForIpc,
  sanitizePermissionRequestForIpc,
  truncateIpcString,
} from '../../ipcPayloadSanitizer';
import { resolveCurrentApiConfig } from '../cowork/providerApiConfig';
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
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value);
    const enrichedMessage =
      messageType === 'assistant' && isRecord(message)
        ? (() => {
            const session = getCoworkStore().getSession(sessionId);
            const agent = getCoworkStore().getAgent(session?.agentId || 'main');
            const rawModel = agent?.model || '';
            const modelName = rawModel.includes('/')
              ? rawModel.slice(rawModel.indexOf('/') + 1)
              : rawModel;
            return {
              ...message,
              ...(modelName ? { modelName } : {}),
            } as CoworkMessage;
          })()
        : (message as CoworkMessage);

    if (
      messageType === 'subagent_completion' ||
      messageType === 'assistant' ||
      messageType === 'system' ||
      messageType === 'user'
    ) {
      try {
        getCoworkStore().insertMessageWithId(sessionId, enrichedMessage);
      } catch (error) {
        console.error('[CoworkForwarder] Failed to persist message:', error);
      }
    }

    broadcast('cowork:stream:message', {
      sessionId,
      message: {
        ...(safeMessage as Record<string, unknown>),
        ...(enrichedMessage.modelName ? { modelName: enrichedMessage.modelName } : {}),
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
      metadata: Record<string, unknown>,
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

  runtime.on('permissionRequest', (sessionId: string, request: unknown) => {
    if (runtime.getSessionConfirmationMode(sessionId) === 'text') return;
    broadcast('cowork:stream:permission', {
      sessionId,
      request: sanitizePermissionRequestForIpc(request),
    });
  });

  runtime.on(
    'complete',
    (sessionId: string, claudeSessionId: string | null, finalStatus?: string) => {
      broadcast('cowork:stream:complete', { sessionId, claudeSessionId, finalStatus });
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
