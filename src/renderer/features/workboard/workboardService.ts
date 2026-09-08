import type {
  WorkboardCardInput,
  WorkboardCardPatch,
  WorkboardStatus,
  WorkboardStopIdentity,
} from '@shared/openclaw/workboard';

import { i18nService } from '@/services/i18n';

export const workboardErrorMessage = (error?: string): string => {
  if (
    error &&
    /gateway(?: client)? (?:is )?(?:not connected|unavailable|disconnected)/i.test(error)
  ) {
    return i18nService.t('workboardGatewayUnavailable');
  }
  return error || i18nService.t('workboardOperationFailed');
};

const unwrap = async <T>(
  operation: Promise<{ success: boolean; data?: T; error?: string }>,
): Promise<T> => {
  const result = await operation;
  if (!result.success) throw new Error(workboardErrorMessage(result.error));
  return result.data as T;
};

export const workboardService = {
  getSnapshot: () => unwrap(window.electron.workboard.getSnapshot()),
  createCard: (input: WorkboardCardInput) => unwrap(window.electron.workboard.createCard(input)),
  updateCard: (id: string, patch: WorkboardCardPatch, expectedUpdatedAt: number) =>
    unwrap(window.electron.workboard.updateCard(id, patch, expectedUpdatedAt)),
  moveCard: (id: string, status: WorkboardStatus, position: number) =>
    unwrap(window.electron.workboard.moveCard(id, status, position)),
  deleteCard: (id: string) => unwrap(window.electron.workboard.deleteCard(id)),
  archiveCard: (id: string, archived: boolean) =>
    unwrap(window.electron.workboard.archiveCard(id, archived)),
  commentCard: (id: string, body: string) =>
    unwrap(window.electron.workboard.commentCard(id, body)),
  startCard: (id: string) => unwrap(window.electron.workboard.startCard(id)),
  stopCard: (id: string, expectedExecution?: WorkboardStopIdentity) =>
    unwrap(window.electron.workboard.stopCard(id, expectedExecution)),
  resolveSession: (sessionKey: string) =>
    unwrap(window.electron.workboard.resolveSession(sessionKey)),
  dispatch: (boardId?: string) => unwrap(window.electron.workboard.dispatch(boardId)),
  onChanged: (callback: Parameters<typeof window.electron.workboard.onChanged>[0]) =>
    window.electron.workboard.onChanged(callback),
};
