import { ipcMain } from 'electron';

import { OpenClawAssistantMediaIpc } from '../../../shared/openclaw/assistantMedia';
import { isWorkspaceBrowserHost } from '../../core/window/workspaceWindowManager';
import { ManagedMediaPlayback } from '../../openclaw/media/managedMediaPlayback';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';

let playback: ManagedMediaPlayback | null = null;

export function registerManagedMediaPlaybackHandlers(deps: {
  getMainWindow: () => Electron.BrowserWindow | null;
  getManager: () => OpenClawEngineManager;
}): void {
  playback = new ManagedMediaPlayback({
    getManager: deps.getManager,
    isTrustedFrame: (owner, frame) => {
      const window = deps.getMainWindow();
      return Boolean(window && !window.isDestroyed() && !owner.isDestroyed() &&
        frame === owner.mainFrame &&
        isWorkspaceBrowserHost(window.webContents.id, owner.id));
    },
  });
  ipcMain.handle(OpenClawAssistantMediaIpc.PreparePlayback, (event, request: unknown) =>
    playback!.prepare(event.sender, event.senderFrame, request));
  ipcMain.handle(OpenClawAssistantMediaIpc.ReleasePlayback, (event, request: unknown) =>
    playback!.release(event.sender, event.senderFrame, request));
}

export const authorizeManagedMediaPlaybackRequest = (
  details: Electron.OnBeforeRequestListenerDetails,
): boolean => playback?.authorize(details) ?? false;

export const handleManagedMediaPlaybackRequest = (request: Request): Promise<Response> =>
  playback?.respond(request) ?? Promise.resolve(new Response(null, { status: 503 }));
