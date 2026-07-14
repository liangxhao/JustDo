import { BrowserWindow, ipcMain } from 'electron';

import { t } from '../../core/i18n';
import type { CoworkStore } from '../../data/coworkStore';
import type { OpenClawExtensionHostController } from '../../plugins/extensions';
import { sanitizeCoworkMessageForIpc } from '../payloadSanitizer';

interface Dependencies {
  getCoworkStore: () => CoworkStore;
  getExtensionHostController: () => OpenClawExtensionHostController | null;
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

const formatAnswer = (value: string): string =>
  value
    .split('|||')
    .map(item => item.trim())
    .filter(Boolean)
    .join(', ');

export const registerCoworkInteractionHandlers = ({
  getCoworkStore,
  getExtensionHostController,
  askUserSessionByRequestId,
}: Dependencies): void => {
  ipcMain.handle(
    'cowork:interaction:respond',
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
            ? typeof updatedInput?.sessionId === 'string'
              ? updatedInput.sessionId.trim()
              : (askUserSessionByRequestId.get(options.requestId) ?? '')
            : '';
          if (sessionId && sessionId !== '__askuser__') {
            const content =
              result.behavior === 'submit' &&
              response.answers &&
              Object.keys(response.answers).length > 0
                ? Object.entries(response.answers)
                    .map(
                      ([question, answer]) =>
                        `${question}\n${t('askUserAnswerLabel')}：${formatAnswer(answer)}`,
                    )
                    .join('\n\n')
                : t(
                    result.behavior === 'submit' ? 'askUserSubmittedMessage' : 'askUserCanceledMessage',
                  );
            const message = getCoworkStore().addMessage(sessionId, {
              type: 'user',
              content,
              metadata: {
                source: 'AskUserQuestion',
                requestId: options.requestId,
                answers: response.answers ?? null,
              },
            });
            BrowserWindow.getAllWindows().forEach(window => {
              if (!window.isDestroyed()) {
                window.webContents.send('cowork:stream:message', {
                  sessionId,
                  message: sanitizeCoworkMessageForIpc(message),
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
