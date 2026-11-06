import { clipboard, ipcMain } from 'electron';

import type { BrowserActionResult } from '../../../shared/browser/browser';
import { ChromeIpc } from '../../../shared/chrome/chrome';
import {
  copyChromeExtensionPairing,
  launchOrFocusChrome,
  openChromeExtensionFolder,
  openChromeUrl,
  resolveChromeExtensionPath,
} from '../../chrome/chromeSettings';
import type { GatewayClientLike } from '../../engine/gateway/types';
import type { OpenClawCliEnvironment } from '../../openclaw/runtime/openclawEngineManager';
import { testBrowserConnection } from './browser';

interface ChromeHandlerDependencies {
  getGatewayClient: () => GatewayClientLike | null;
  buildCliEnvironment: () => Promise<OpenClawCliEnvironment>;
}

/** Privileged Chrome actions are available only to the application's main frame. */
export const registerChromeHandlers = ({
  getGatewayClient,
  buildCliEnvironment,
}: ChromeHandlerDependencies): void => {
  const handle = (
    channel: string,
    operation: (...args: unknown[]) => Promise<BrowserActionResult>,
  ) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (event.sender.getType() !== 'window' || event.senderFrame !== event.sender.mainFrame) {
        return { success: false, error: 'Access denied' } satisfies BrowserActionResult;
      }
      return operation(...args);
    });
  };

  handle(ChromeIpc.OpenUrl, url => openChromeUrl(url));
  handle(ChromeIpc.OpenRemoteDebugging, async () => {
    clipboard.writeText('chrome://inspect/#remote-debugging');
    return launchOrFocusChrome();
  });
  handle(ChromeIpc.OpenExtensionManagement, async () => {
    clipboard.writeText('chrome://extensions');
    return launchOrFocusChrome();
  });
  handle(ChromeIpc.RevealExtension, async () => {
    try {
      await openChromeExtensionFolder(resolveChromeExtensionPath());
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  handle(ChromeIpc.CopyExtensionPairing, async () => {
    try {
      await copyChromeExtensionPairing(buildCliEnvironment);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  handle(ChromeIpc.TestExtensionConnection, () =>
    testBrowserConnection(getGatewayClient(), 'chrome'),
  );
};
