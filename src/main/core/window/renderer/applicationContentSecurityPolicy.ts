type ApplicationContentSecurityPolicyOptions = {
  isDev: boolean;
  devServerPort?: number | string;
  inlineScriptHashes?: readonly string[];
};

/** Only hashes of inline scripts in the trusted packaged entry are admitted. */
export const buildApplicationContentSecurityPolicy = ({
  isDev,
  devServerPort,
  inlineScriptHashes = [],
}: ApplicationContentSecurityPolicyOptions): string => {
  const scripts = ["'self'", "'wasm-unsafe-eval'"];
  if (isDev) {
    scripts.push(
      "'unsafe-inline'",
      `http://localhost:${devServerPort}`,
      `ws://localhost:${devServerPort}`,
    );
  } else {
    scripts.push(
      ...inlineScriptHashes
        .filter(hash => /^sha256-[A-Za-z0-9+/]{43}=$/u.test(hash))
        .map(hash => `'${hash}'`),
    );
  }
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https: http: localfile:",
    // Connections use configured Gateway/model endpoints; their native policies apply.
    "connect-src 'self' *",
    "font-src 'self' data:",
    "media-src 'self' blob: data: localmedia:",
    "worker-src 'self' blob:",
    "frame-src 'self' https: http:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
};
