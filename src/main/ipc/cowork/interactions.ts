import { BrowserWindow, ipcMain } from 'electron';

import {
  type AskUserInteractionEnvelope,
  CoworkInteractionIpc,
} from '../../../shared/openclaw/extensions';

type AskUserRuntime = {
  listPendingAskUserInteractions: () => Promise<AskUserInteractionEnvelope[]>;
  resolveAskUserInteraction: (
    requestId: string,
    response: { behavior: 'submit'; answers: unknown } | { behavior: 'cancel' },
  ) => Promise<{ sessionId: string }>;
};

interface Dependencies {
  getRuntime: () => AskUserRuntime | null;
}

type CoworkInteractionResult =
  | {
      behavior: 'submit';
      updatedInput?: Record<string, unknown>;
      toolUseID?: string;
    }
  | {
      behavior: 'cancel';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseInteractionResponse = (
  value: unknown,
): {
  requestId: string;
  response: { behavior: 'submit'; answers: unknown } | { behavior: 'cancel' };
} | null => {
  if (!isRecord(value) || typeof value.requestId !== 'string' || !value.requestId.trim()) {
    return null;
  }
  if (!isRecord(value.result)) return null;
  const result = value.result as CoworkInteractionResult;
  if (result.behavior === 'cancel') {
    return { requestId: value.requestId.trim(), response: { behavior: 'cancel' } };
  }
  if (
    result.behavior !== 'submit' ||
    !isRecord(result.updatedInput) ||
    !Object.prototype.hasOwnProperty.call(result.updatedInput, 'answers')
  ) {
    return null;
  }
  return {
    requestId: value.requestId.trim(),
    response: { behavior: 'submit', answers: result.updatedInput.answers },
  };
};

export const registerCoworkInteractionHandlers = ({ getRuntime }: Dependencies): void => {
  ipcMain.handle(CoworkInteractionIpc.Replay, async event => {
    const interactions = (await getRuntime()?.listPendingAskUserInteractions()) ?? [];
    interactions.forEach(interaction => {
      event.sender.send(CoworkInteractionIpc.Stream, interaction);
    });
    return { success: true, count: interactions.length };
  });

  ipcMain.handle(CoworkInteractionIpc.Respond, async (_event, options: unknown) => {
    try {
      const parsed = parseInteractionResponse(options);
      if (!parsed) throw new Error('Invalid interaction response.');
      const runtime = getRuntime();
      if (!runtime) throw new Error('OpenClaw Gateway is unavailable.');
      const response = await runtime.resolveAskUserInteraction(parsed.requestId, parsed.response);
      if (response.sessionId && response.sessionId !== '__askuser__') {
        BrowserWindow.getAllWindows().forEach(window => {
          if (!window.isDestroyed()) {
            window.webContents.send('cowork:session:activity', {
              sessionId: response.sessionId,
              kind: 'user',
              timestamp: Date.now(),
            });
          }
        });
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to respond to interaction',
      };
    }
  });
};
