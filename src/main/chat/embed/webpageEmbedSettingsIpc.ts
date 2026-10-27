import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import { WebpageEmbedSettingsIpc } from '../../../shared/browser/webpageEmbedSettings';
import type { WebpageEmbedSettingsService } from './webpageEmbedSettingsService';

export function registerWebpageEmbedSettingsHandlers(options: {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  requireOwner: (event: IpcMainInvokeEvent) => void;
  settings: Pick<WebpageEmbedSettingsService, 'getSettings' | 'saveSettings'>;
}): () => void {
  const { ipc, requireOwner, settings } = options;
  for (const channel of Object.values(WebpageEmbedSettingsIpc)) ipc.removeHandler(channel);
  ipc.handle(WebpageEmbedSettingsIpc.Get, event => {
    requireOwner(event);
    return settings.getSettings();
  });
  ipc.handle(WebpageEmbedSettingsIpc.Save, (event, input: unknown) => {
    requireOwner(event);
    return settings.saveSettings(input);
  });
  return () => {
    for (const channel of Object.values(WebpageEmbedSettingsIpc)) ipc.removeHandler(channel);
  };
}
