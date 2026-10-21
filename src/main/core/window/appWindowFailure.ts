import { app, BrowserWindow, clipboard, dialog, type WebContents } from 'electron';

import {
  captureStartupFailure,
  type StartupFailure,
  StartupFailureSource,
  startupFailureText,
} from '../../../shared/app/startupFailure';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import { t } from '../i18n';
import { getLogFilePath } from '../logger';
import { registerWindowDiagnostics } from './windowDiagnostics';

/** Native fallback remains usable when preload or the entire renderer cannot run. */
export function registerAppWindowDiagnostics(
  contents: WebContents,
  label: string,
): (error: unknown) => void {
  let showing = false;
  const showFailure = async (failure: StartupFailure) => {
    if (showing || contents.isDestroyed()) return;
    showing = true;
    const detail = startupFailureText({
      ...failure,
      context: { ...failure.context, logPath: getLogFilePath() },
    });
    try {
      const options = {
        type: 'error' as const,
        title: PRODUCT_NAME,
        message: t('startupWindowFailed'),
        detail,
        buttons: [t('startupWindowCopy'), t('startupWindowRestart'), t('windowClose')],
        defaultId: 2,
        cancelId: 2,
        noLink: true,
      };
      const owner = BrowserWindow.fromWebContents(contents);
      const { response } = await (owner
        ? dialog.showMessageBox(owner, options)
        : dialog.showMessageBox(options));
      if (response === 0) clipboard.writeText(detail);
      if (response === 1 && !contents.isDestroyed()) {
        app.relaunch();
        app.quit();
      }
    } catch (error) {
      console.error('[AppWindowFailure] Failed to display native diagnostics:', error);
    } finally {
      showing = false;
    }
  };
  registerWindowDiagnostics(contents, label, failure => {
    void showFailure(failure);
  });
  return error => {
    void showFailure(
      captureStartupFailure(StartupFailureSource.Page, error, { activity: 'rendererHost' }),
    );
  };
}
