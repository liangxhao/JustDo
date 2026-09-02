import { BrowserWindow, ipcMain } from 'electron';

import { CoworkInteractionIpc } from '../../../shared/openclaw/extensions';
import type { OpenClawExtensionHostController } from '../../plugins/extensions';
import type { AskUserInteractionEnvelope } from '../../plugins/extensions/openclawExtensionHostLifecycle';

interface Dependencies {
  getExtensionHostController: () => OpenClawExtensionHostController | null;
  getPendingInteractions: () => AskUserInteractionEnvelope[];
  askUserSessionByRequestId: Map<string, string>;
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

export const registerCoworkInteractionHandlers = ({
  getExtensionHostController,
  getPendingInteractions,
  askUserSessionByRequestId,
}: Dependencies): void => {
  ipcMain.handle(CoworkInteractionIpc.Replay, event => {
    const interactions = getPendingInteractions();
    interactions.forEach(interaction => {
      event.sender.send(CoworkInteractionIpc.Stream, interaction);
    });
    return { success: true, count: interactions.length };
  });

  ipcMain.handle(
    CoworkInteractionIpc.Respond,
    async (_event, options: { requestId: string; result: CoworkInteractionResult }) => {
      try {
        const extensionHost = getExtensionHostController();
        if (extensionHost && options.requestId) {
          const result = options.result;
          const updatedInput =
            result.behavior === 'submit' &&
            result.updatedInput &&
            typeof result.updatedInput === 'object'
              ? (result.updatedInput as Record<string, unknown>)
              : undefined;
          // The extension callback protocol still uses allow/deny for ask-user responses.
          const response = extensionHost.respondToInteraction(options.requestId, {
            behavior: result.behavior === 'submit' ? 'allow' : 'deny',
            updatedInput,
          });
          const sessionId = response.handled
            ? (askUserSessionByRequestId.get(options.requestId) ?? '')
            : '';
          if (sessionId && sessionId !== '__askuser__') {
            BrowserWindow.getAllWindows().forEach(window => {
              if (!window.isDestroyed()) {
                window.webContents.send('cowork:session:activity', {
                  sessionId,
                  kind: 'user',
                  timestamp: Date.now(),
                });
              }
            });
          }
          askUserSessionByRequestId.delete(options.requestId);
        }

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to respond to interaction',
        };
      }
    },
  );
};
