import { WebLaunchErrorCode, WebLaunchMethod } from '../../../plugins/chrome-extensions/chrome-assistant/contracts/webLaunch';
import { AppServerErrorCode, type AppServerOperation,AppServerRpcError, isAppServerRecord } from '../clients/appServer/protocol/appServerProtocol';

/** Chrome-owned extensions to the shared app-server protocol. */
export const ChromeAppServerMethod = {
  ThreadImage: 'chrome/thread/image',
  ComposerOptions: 'chrome/composer/options',
  ChromePair: 'chrome/extension/pair',
  WebLaunchSitesRead: WebLaunchMethod.SitesRead,
  WebLaunchSitesWrite: WebLaunchMethod.SitesWrite,
  WebLaunchPrepare: WebLaunchMethod.Prepare,
  WebLaunchRevise: WebLaunchMethod.Revise,
  WebLaunchSubmit: WebLaunchMethod.Submit,
  WebLaunchRead: WebLaunchMethod.Read,
  WebLaunchCancel: WebLaunchMethod.Cancel,
  WebLaunchStop: WebLaunchMethod.Stop,
  WebLaunchAbandon: WebLaunchMethod.Abandon,
  WebLaunchObservations: WebLaunchMethod.Observations,
  WebLaunchRevokeDocument: WebLaunchMethod.RevokeDocument,
} as const;

export const ChromeAppServerNotificationMethod = {
  WebLaunchChanged: 'chrome/webLaunch/changed',
  ThreadUpdated: 'chrome/thread/updated',
  ThreadStream: 'chrome/thread/stream',
} as const;
export type ChromeAppServerNotificationMethod =
  (typeof ChromeAppServerNotificationMethod)[keyof typeof ChromeAppServerNotificationMethod];

export const chromeWebLaunchMethods = Object.freeze(Object.values(WebLaunchMethod));
const webLaunchErrorCodes = new Set<string>(Object.values(WebLaunchErrorCode));

/** Web callers receive only known public codes, never native exception details. */
export const wrapChromeWebLaunchOperation = (operation: AppServerOperation): AppServerOperation => async params => {
  try {
    return await operation(params);
  } catch (error) {
    const offered = isAppServerRecord(error) && isAppServerRecord(error.publicError)
      ? error.publicError.code : undefined;
    const code = typeof offered === 'string' && webLaunchErrorCodes.has(offered)
      ? offered : WebLaunchErrorCode.InternalError;
    throw new AppServerRpcError(AppServerErrorCode.Internal, code, { code, messageKey: `webLaunchError${code}` });
  }
};
