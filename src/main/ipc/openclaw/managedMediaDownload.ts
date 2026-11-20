import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { dialog, ipcMain } from 'electron';

import {
  AssistantDeliverySaveError,
  type OpenClawAssistantDeliverySaveRequest,
  type OpenClawAssistantDeliverySaveResult,
  OpenClawAssistantMediaIpc,
  parseManagedOutgoingMediaSource,
} from '../../../shared/openclaw/assistantMedia';
import { isWorkspaceFileName } from '../../../shared/preview/workspaceFiles';
import { getWorkspaceDialogOwner } from '../../core/window/workspaceWindowManager';
import { readManagedAssistantDelivery } from '../../openclaw/media/readManagedAssistantDelivery';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';

// Match the native managed document limit. Other managed delivery readers use
// their own limits, including the Chrome default for opening files.
const MAX_MANAGED_DOCUMENT_BYTES = 100 * 1024 * 1024;

export function registerManagedMediaDownloadHandler(deps: {
  getMainWindow: () => Electron.BrowserWindow | null;
  getManager: () => OpenClawEngineManager;
}): void {
  const pending = new WeakMap<Electron.WebContents, string>();

  ipcMain.handle(OpenClawAssistantMediaIpc.SaveDelivery, async (
    { sender, senderFrame }, input: unknown,
  ): Promise<OpenClawAssistantDeliverySaveResult> => {
    const window = deps.getMainWindow();
    const frameUrl = senderFrame?.url;
    let navigated = false;
    const onNavigation = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) navigated = true;
    };
    const isCurrent = () => Boolean(!navigated && window && window === deps.getMainWindow() &&
      !window.isDestroyed() && !sender.isDestroyed() && sender === window.webContents &&
      senderFrame && senderFrame === sender.mainFrame && senderFrame.url === frameUrl);
    const request = input as Partial<OpenClawAssistantDeliverySaveRequest> | null;
    if (!isCurrent() || !request || typeof request.source !== 'string' ||
        typeof request.sessionKey !== 'string' || !request.sessionKey ||
        !parseManagedOutgoingMediaSource(request.source, request.sessionKey)) {
      return { success: false };
    }
    const activeSource = pending.get(sender);
    if (activeSource === request.source) return { success: true, canceled: true };
    if (activeSource) return { success: false, reason: AssistantDeliverySaveError.Busy };
    pending.set(sender, request.source);
    sender.on('did-start-navigation', onNavigation);

    let temporary: string | undefined;
    try {
      const delivery = await readManagedAssistantDelivery(deps.getManager(), {
        source: request.source,
        sessionKey: request.sessionKey,
        maxBytes: MAX_MANAGED_DOCUMENT_BYTES,
      });
      const owner = isCurrent() ? getWorkspaceDialogOwner(sender) : undefined;
      if (!owner || owner.isDestroyed()) return { success: false };
      const filename = [delivery.filename, request.filename].find(isWorkspaceFileName) ?? 'attachment';
      const result = await dialog.showSaveDialog(owner, { defaultPath: filename });
      if (result.canceled || !result.filePath) return { success: true, canceled: true };
      if (!isCurrent() || owner.isDestroyed()) return { success: false };
      delivery.assertCurrent();
      const stage = path.join(path.dirname(result.filePath), `.attachment-${randomUUID()}.tmp`);
      const file = await open(stage, 'wx', 0o600);
      temporary = stage;
      try {
        await file.writeFile(delivery.bytes);
      } finally {
        await file.close();
      }
      if (!isCurrent() || owner.isDestroyed()) return { success: false };
      delivery.assertCurrent();
      await rename(temporary, result.filePath);
      temporary = undefined;
      return { success: true, canceled: false };
    } catch {
      return { success: false };
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      sender.removeListener('did-start-navigation', onNavigation);
      pending.delete(sender);
    }
  });
}
