import { BrowserWindow, ipcMain } from 'electron';

import type { CoworkStore } from '../../coworkStore';
import { t } from '../../i18n';
import { sanitizeCoworkMessageForIpc } from '../../ipcPayloadSanitizer';
import type { CoworkEngineRouter } from '../../libs/agentEngine';
import type { PermissionResult } from '../../libs/agentEngine/types';
import type { OpenClawExtensionHostController } from '../../libs/plugins/extensions';

interface Dependencies {
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  getExtensionHostController: () => OpenClawExtensionHostController | null;
  askUserSessionByRequestId: Map<string, string>;
}

const formatAnswer = (value: string): string =>
  value
    .split('|||')
    .map(item => item.trim())
    .filter(Boolean)
    .join(', ');

export const registerCoworkPermissionHandlers = ({
  getCoworkStore,
  getCoworkEngineRouter,
  getExtensionHostController,
  askUserSessionByRequestId,
}: Dependencies): void => {
  ipcMain.handle(
    'cowork:permission:respond',
    async (_event, options: { requestId: string; result: PermissionResult }) => {
      try {
        const extensionHost = getExtensionHostController();
        if (extensionHost && options.requestId) {
          const result = options.result;
          const updatedInput =
            result.behavior === 'allow' &&
            result.updatedInput &&
            typeof result.updatedInput === 'object'
              ? (result.updatedInput as Record<string, unknown>)
              : undefined;
          const response = extensionHost.respondToInteraction(options.requestId, {
            behavior: result.behavior === 'allow' ? 'allow' : 'deny',
            updatedInput,
          });
          const sessionId = response.handled
            ? typeof updatedInput?.sessionId === 'string'
              ? updatedInput.sessionId.trim()
              : (askUserSessionByRequestId.get(options.requestId) ?? '')
            : '';
          if (sessionId && sessionId !== '__askuser__') {
            const content =
              result.behavior === 'allow' &&
              response.answers &&
              Object.keys(response.answers).length > 0
                ? Object.entries(response.answers)
                    .map(
                      ([question, answer]) =>
                        `${question}\n${t('askUserAnswerLabel')}：${formatAnswer(answer)}`,
                    )
                    .join('\n\n')
                : t(
                    result.behavior === 'allow' ? 'askUserApprovedMessage' : 'askUserDeniedMessage',
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

        getCoworkEngineRouter().respondToPermission(options.requestId, options.result);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to respond to permission',
        };
      }
    },
  );
};
