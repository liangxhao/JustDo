import { BrowserWindow, ipcMain } from 'electron';

import type { AskUserQuestion, AskUserQuestionAnswer } from '../../../shared/openclaw/extensions';
import { CoworkInteractionIpc } from '../../../shared/openclaw/extensions';
import { t } from '../../core/i18n';
import type { CoworkStore } from '../../data/coworkStore';
import type { OpenClawExtensionHostController } from '../../plugins/extensions';
import type { AskUserInteractionEnvelope } from '../../plugins/extensions/openclawExtensionHostLifecycle';
import { sanitizeCoworkMessageForIpc } from '../payloadSanitizer';

interface Dependencies {
  getCoworkStore: () => CoworkStore;
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

export const formatAnswer = (answer: AskUserQuestionAnswer, question?: AskUserQuestion): string => {
  if (answer.skipped) return t('askUserSkippedAnswer');
  const optionsById = new Map(question?.options.map(option => [option.id, option]) ?? []);
  const parts = answer.selected.map(optionId => {
    const label = optionsById.get(optionId)?.label ?? optionId;
    const input = answer.optionInputs?.[optionId];
    return input ? `${label}: ${input}` : label;
  });
  if (answer.other) parts.push(answer.other);
  return parts.join(', ');
};

export const registerCoworkInteractionHandlers = ({
  getCoworkStore,
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
            const questions = response.questions ?? [];
            const questionsById = new Map(questions.map(question => [question.id, question]));
            const content =
              response.behavior === 'allow' &&
              response.answers &&
              Object.keys(response.answers).length > 0
                ? Object.entries(response.answers)
                    .map(([questionId, answer]) => {
                      const question = questionsById.get(questionId);
                      return `${question?.question ?? questionId}\n${t('askUserAnswerLabel')}：${formatAnswer(answer, question)}`;
                    })
                    .join('\n\n')
                : t(
                    response.behavior === 'allow'
                      ? 'askUserSubmittedMessage'
                      : 'askUserCanceledMessage',
                  );
            const message = getCoworkStore().addMessage(sessionId, {
              type: 'user',
              content,
              metadata: {
                source: 'AskUserQuestion',
                requestId: options.requestId,
                behavior: response.behavior ?? null,
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
