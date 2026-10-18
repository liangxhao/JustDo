import { BrowserWindow } from 'electron';

import { McpAppIpc } from '../../../shared/plugins/mcpApps';

/** Notification only. Native question records and answers remain with Gateway. */
export function notifyNativeQuestionChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(McpAppIpc.QuestionsChanged);
  }
}
