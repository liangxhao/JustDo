import { session } from 'electron';

import { buildApplicationContentSecurityPolicy } from './renderer/applicationContentSecurityPolicy';

interface ContentSecurityPolicyOptions {
  isDev: boolean;
  devServerPort: number;
}

export const shouldApplyApplicationCsp = (
  requestUrl: string,
  applicationUrl: string,
  isDev: boolean,
): boolean => {
  if (!isDev) return requestUrl.startsWith('file:');
  try {
    return new URL(requestUrl).origin === new URL(applicationUrl).origin;
  } catch {
    return false;
  }
};

export const registerContentSecurityPolicy = (
  { isDev, devServerPort }: ContentSecurityPolicyOptions,
  targetSession: Electron.Session = session.defaultSession,
): void => {
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    const devPort = process.env.ELECTRON_START_URL?.match(/:(\d+)/)?.[1] || String(devServerPort);
    const applicationUrl = isDev
      ? process.env.ELECTRON_START_URL || `http://localhost:${devPort}`
      : '';
    if (!shouldApplyApplicationCsp(details.url, applicationUrl, isDev)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': buildApplicationContentSecurityPolicy({
          isDev,
          devServerPort: devPort,
        }),
      },
    });
  });
};
