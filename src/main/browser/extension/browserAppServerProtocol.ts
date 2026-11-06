import { WebLaunchErrorCode, WebLaunchMethod } from '../../../../plugins/browser-extensions/browser-assistant/contracts/webLaunch';
import { AppServerErrorCode, type AppServerOperation,AppServerRpcError, isAppServerRecord } from '../../appServer/appServerProtocol';

/** Browser-owned extensions to the shared app-server protocol. */
export const BrowserAppServerMethod = {
  ThreadImage: 'browser/thread/image',
  ComposerOptions: 'browser/composer/options',
  BrowserPair: 'browser/extension/pair',
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

export const BrowserAppServerNotificationMethod = {
  WebLaunchChanged: 'browser/webLaunch/changed',
  ThreadUpdated: 'browser/thread/updated',
  ThreadStream: 'browser/thread/stream',
} as const;
export type BrowserAppServerNotificationMethod =
  (typeof BrowserAppServerNotificationMethod)[keyof typeof BrowserAppServerNotificationMethod];

export const browserWebLaunchMethods = Object.freeze(Object.values(WebLaunchMethod));
const webLaunchErrorCodes = new Set<string>(Object.values(WebLaunchErrorCode));

/** Web callers receive only known public codes, never native exception details. */
export const wrapBrowserWebLaunchOperation = (operation: AppServerOperation): AppServerOperation => async params => {
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
