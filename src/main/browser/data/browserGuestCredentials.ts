import { dialog } from 'electron';

import {
  BROWSER_CREDENTIAL_PASSWORD_LIMIT,
  BROWSER_CREDENTIAL_USERNAME_LIMIT,
  BROWSER_GUEST_CREDENTIALS_CHECK_CHANNEL,
  BROWSER_GUEST_CREDENTIALS_GET_CHANNEL,
  BROWSER_GUEST_CREDENTIALS_SUBMIT_CHANNEL,
} from '../../../shared/browser/browser';
import { t } from '../../core/i18n';
import { findBrowserCredential, saveBrowserCredential } from './browserDataImportService';

export const registerBrowserGuestCredentials = (
  guest: Electron.WebContents,
  getWindow: () => Electron.BrowserWindow,
  isAutomating: () => boolean,
): void => {
  const acceptsFrame = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
    origin: unknown,
  ): origin is string => {
    const frame = event.senderFrame;
    return (
      event.sender === guest &&
      !guest.isDestroyed() &&
      !isAutomating() &&
      frame !== null &&
      frame === guest.mainFrame &&
      typeof origin === 'string' &&
      /^https?:\/\//.test(origin) &&
      frame.origin === origin
    );
  };

  const findCredential = (
    event: Electron.IpcMainInvokeEvent,
    origin: unknown,
    username: unknown,
  ) => {
    if (
      !acceptsFrame(event, origin) ||
      (username !== null &&
        (typeof username !== 'string' || username.length > BROWSER_CREDENTIAL_USERNAME_LIMIT))
    )
      return null;
    try {
      return findBrowserCredential(origin, typeof username === 'string' ? username : null);
    } catch {
      return null;
    }
  };

  guest.ipc.handle(
    BROWSER_GUEST_CREDENTIALS_CHECK_CHANNEL,
    (event, origin, username) => findCredential(event, origin, username) !== null,
  );
  guest.ipc.handle(BROWSER_GUEST_CREDENTIALS_GET_CHANNEL, findCredential);

  let confirmation: AbortController | null = null;
  const cancelConfirmation = () => confirmation?.abort();
  guest.once('destroyed', cancelConfirmation);
  guest.on('render-process-gone', cancelConfirmation);
  guest.ipc.on(BROWSER_GUEST_CREDENTIALS_SUBMIT_CHANNEL, (event, origin, username, password) => {
    if (
      confirmation ||
      !acceptsFrame(event, origin) ||
      !guest.isFocused() ||
      typeof username !== 'string' ||
      username.length > BROWSER_CREDENTIAL_USERNAME_LIMIT ||
      typeof password !== 'string' ||
      !password ||
      password.length > BROWSER_CREDENTIAL_PASSWORD_LIMIT
    )
      return;

    const owner = getWindow();
    if (owner.isDestroyed() || !owner.isFocused()) return;
    const controller = new AbortController();
    confirmation = controller;
    void (async () => {
      try {
        if (findBrowserCredential(origin, username)?.password === password) return;
        const { response } = await dialog.showMessageBox(owner, {
          type: 'question',
          title: t('browserSavePasswordTitle'),
          message: t('browserSavePasswordMessage'),
          detail: origin,
          buttons: [t('browserSavePasswordConfirm'), t('browserSavePasswordCancel')],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          signal: controller.signal,
        });
        // A real form submission can replace the document while the dialog is open.
        // The confirmation remains scoped to the captured site shown in the dialog.
        if (response === 0 && !controller.signal.aborted && !isAutomating()) {
          saveBrowserCredential(origin, { username, password });
        }
      } catch {
        if (!controller.signal.aborted && !owner.isDestroyed()) {
          await dialog
            .showMessageBox(owner, {
              type: 'error',
              message: t('browserSavePasswordFailed'),
            })
            .catch((): void => {});
        }
      } finally {
        confirmation = null;
      }
    })();
  });
};
