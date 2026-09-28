import { session } from 'electron';

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

export const registerContentSecurityPolicy = ({
  isDev,
  devServerPort,
}: ContentSecurityPolicyOptions): void => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const devPort = process.env.ELECTRON_START_URL?.match(/:(\d+)/)?.[1] || String(devServerPort);
    const applicationUrl = process.env.ELECTRON_START_URL || `http://localhost:${devPort}`;
    if (!shouldApplyApplicationCsp(details.url, applicationUrl, isDev)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const cspDirectives = [
      "default-src 'self'",
      // PDF.js uses bundled WebAssembly decoders; JavaScript eval remains disabled.
      isDev
        ? `script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' http://localhost:${devPort} ws://localhost:${devPort}`
        : "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data: https: http: localfile:",
      // 允许连接到所有域名，不做限制
      "connect-src 'self' *",
      "font-src 'self' data:",
      "media-src 'self' blob: data: localmedia:",
      "worker-src 'self' blob:",
      "frame-src 'self' https: http:",
    ];

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': cspDirectives.join('; '),
      },
    });
  });
};
