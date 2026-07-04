import { session } from 'electron';

interface ContentSecurityPolicyOptions {
  isDev: boolean;
  devServerPort: number;
}

export const registerContentSecurityPolicy = ({
  isDev,
  devServerPort,
}: ContentSecurityPolicyOptions): void => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const devPort = process.env.ELECTRON_START_URL?.match(/:(\d+)/)?.[1] || String(devServerPort);
    const cspDirectives = [
      "default-src 'self'",
      isDev
        ? `script-src 'self' 'unsafe-inline' http://localhost:${devPort} ws://localhost:${devPort}`
        : "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: http: localfile:",
      // 允许连接到所有域名，不做限制
      'connect-src *',
      "font-src 'self' data:",
      "media-src 'self'",
      "worker-src 'self' blob:",
      "frame-src 'self'",
    ];

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': cspDirectives.join('; '),
      },
    });
  });
};
