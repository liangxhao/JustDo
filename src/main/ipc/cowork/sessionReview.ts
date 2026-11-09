import { ipcMain } from 'electron';

import {
  type SessionReviewFileAction,
  SessionReviewIpc,
  type SessionReviewQuery,
} from '../../../shared/cowork/sessionReview';
import {
  createSessionReviewService,
  type SessionReviewServiceDependencies,
} from '../../cowork/review/sessionReviewService';
import { openPathWithSystemChooser } from '../app/shell';

type Dependencies = Omit<SessionReviewServiceDependencies, 'openEditorChooser'>;

export function registerSessionReviewHandlers(deps: Dependencies): void {
  const service = createSessionReviewService({
    getRuntime: () => deps.getRuntime(),
    getSession: id => deps.getSession(id),
    openEditorChooser: filePath => openPathWithSystemChooser(filePath),
  });
  ipcMain.handle(SessionReviewIpc.Load, (event, query: SessionReviewQuery) =>
    event.sender.getType() === 'window'
      ? service.load(query)
      : { success: false, reason: 'identity' },
  );
  ipcMain.handle(
    SessionReviewIpc.File,
    (event, query: SessionReviewQuery, relative: string, action: SessionReviewFileAction) =>
      event.sender.getType() === 'window'
        ? service.file(query, relative, action)
        : { success: false, reason: 'identity' },
  );
}
