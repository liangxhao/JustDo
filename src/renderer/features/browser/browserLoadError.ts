import { getBrowserLocalFilePath } from '@shared/browser/browserHistory';

import { i18nService } from '@/services/i18n';

const NET_ERROR_NAMES: Readonly<Record<number, string>> = {
  [-3]: 'ERR_ABORTED',
  [-6]: 'ERR_FILE_NOT_FOUND',
  [-7]: 'ERR_TIMED_OUT',
  [-10]: 'ERR_ACCESS_DENIED',
  [-101]: 'ERR_CONNECTION_RESET',
  [-102]: 'ERR_CONNECTION_REFUSED',
  [-105]: 'ERR_NAME_NOT_RESOLVED',
  [-106]: 'ERR_INTERNET_DISCONNECTED',
  [-111]: 'ERR_TUNNEL_CONNECTION_FAILED',
  [-118]: 'ERR_CONNECTION_TIMED_OUT',
  [-130]: 'ERR_PROXY_CONNECTION_FAILED',
  [-300]: 'ERR_INVALID_URL',
};

const NET_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  ERR_NAME_NOT_RESOLVED: 'browserPanelAddressNotFound',
  ERR_INVALID_URL: 'browserPanelInvalidAddress',
  ERR_TIMED_OUT: 'browserPanelLoadTimedOut',
  ERR_CONNECTION_TIMED_OUT: 'browserPanelLoadTimedOut',
  ERR_CONNECTION_RESET: 'browserPanelConnectionFailed',
  ERR_CONNECTION_REFUSED: 'browserPanelConnectionFailed',
  ERR_INTERNET_DISCONNECTED: 'browserPanelConnectionFailed',
  ERR_TUNNEL_CONNECTION_FAILED: 'browserPanelConnectionFailed',
  ERR_PROXY_CONNECTION_FAILED: 'browserPanelConnectionFailed',
};

export interface BrowserLoadError {
  url: string;
  message: string;
  code?: string;
}

/** Electron errors can cross realms or arrive as plain objects over IPC. */
export const formatBrowserLoadError = (error: unknown, url: string): BrowserLoadError | null => {
  const details = typeof error === 'object' && error !== null
    ? error as Record<string, unknown>
    : {};
  const description = typeof details.errorDescription === 'string' ? details.errorDescription
    : typeof details.message === 'string' ? details.message
      : typeof error === 'string' ? error : '';
  const errorNumber = typeof details.errorCode === 'number' ? details.errorCode
    : typeof details.errno === 'number' ? details.errno : undefined;
  const errorName = (typeof details.code === 'string' ? details.code : description)
    .match(/\bERR_[A-Z0-9_]+\b/)?.[0] ??
    (errorNumber !== undefined ? NET_ERROR_NAMES[errorNumber] : undefined);
  if (errorName === 'ERR_ABORTED' || errorNumber === -3) return null;

  const localFile = getBrowserLocalFilePath(url) !== null;
  let messageKey = localFile ? 'browserPanelLocalFileLoadFailed' : 'browserPanelLoadFailed';
  if (localFile && errorName === 'ERR_FILE_NOT_FOUND') {
    messageKey = 'browserPanelLocalFileNotFound';
  } else if (localFile && errorName === 'ERR_ACCESS_DENIED') {
    messageKey = 'browserPanelLocalFileAccessDenied';
  } else if (!localFile && errorName) {
    messageKey = NET_ERROR_MESSAGES[errorName] ??
      (errorName.startsWith('ERR_CERT_') ? 'browserPanelCertificateError' : messageKey);
  }
  return { url, message: i18nService.t(messageKey), code: errorName };
};
