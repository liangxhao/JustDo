import fs from 'fs';
import http from 'http';
import CA from 'http-mitm-proxy/dist/lib/ca';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import { afterEach, expect, test, vi } from 'vitest';

import {
  applyMainProcessOutboundHeaderPolicy,
  mainProcessFetch,
  MainProcessOutboundHeaderSource,
  mainProcessTitleFetch,
} from './mainProcessFetch';
import {
  captureOutboundHeaderStartupEnabled,
  DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG,
  getOutboundHeaderPolicyConfig,
  getOutboundHeaderUserInfo,
  updateOutboundHeaderUserInfoCache,
} from './outboundHeaderPolicyConfig';
import {
  applyOutboundHeaders,
  installNoisyMitmConsoleFilter,
  isIgnorableProxyClientError,
  isOutboundHeaderProxyActive,
  OutboundHeaderProxy,
  resolveOutboundHeaderProxyConfig,
  shouldApplyOutboundHeadersForRequest,
  shouldInjectOutboundHeaders,
  shouldSuppressMitmProxyErrorLog,
  suppressNoisyMitmDisconnectLogs,
  uninstallNoisyMitmConsoleFilter,
} from './outboundHeaderProxy';
import { buildTrustedCaBundle } from './trustedCertificates';

const temporaryDirectories: string[] = [];
const HEADER_NAMES = {
  USER_ACCOUNT: 'X-User-Account',
  COOKIE: 'X-Cookie',
} as const;
const CONFIGURED_HEADER_NAMES = [HEADER_NAMES.USER_ACCOUNT, HEADER_NAMES.COOKIE] as const;

afterEach(() => {
  uninstallNoisyMitmConsoleFilter();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const writeUserInfo = (content: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-user-info-'));
  temporaryDirectories.push(directory);
  const userInfoPath = path.join(directory, 'user_info.json');
  fs.writeFileSync(userInfoPath, content);
  return userInfoPath;
};

test('sends Main requests through the configured transport without outbound header injection', async () => {
  let receivedUrl = '';
  let receivedBody = '';
  const proxyServer = http.createServer((request, response) => {
    receivedUrl = request.url || '';
    request.on('data', chunk => {
      receivedBody += chunk.toString();
    });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '代理标题' } }] }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxyServer.once('error', reject);
    proxyServer.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = proxyServer.address();
    if (!address || typeof address === 'string') throw new Error('Proxy server did not start.');
    const { setFixedProxyUrl } = await import('./systemProxy');
    setFixedProxyUrl(`http://127.0.0.1:${address.port}`);
    const response = await mainProcessFetch('http://model.example/v1/chat/completions', {
      method: 'POST',
      body: '{"model":"title-model"}',
    });

    expect(response.status).toBe(200);
    expect(receivedUrl).toBe('http://model.example/v1/chat/completions');
    expect(receivedBody).toBe('{"model":"title-model"}');
  } finally {
    const { setFixedProxyUrl } = await import('./systemProxy');
    setFixedProxyUrl(null);
    await new Promise<void>(resolve => proxyServer.close(() => resolve()));
  }
});

const writePolicyConfig = (content: object): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-header-policy-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(content));
  return configPath;
};

test('injects configured headers only for a whitelisted Main title request', async () => {
  const receivedHeaders: Array<string | undefined> = [];
  const injectionLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const proxyServer = http.createServer((request, response) => {
    receivedHeaders.push(request.headers['x-user-account'] as string | undefined);
    response.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    proxyServer.once('error', reject);
    proxyServer.listen(0, '127.0.0.1', resolve);
  });

  const userInfoPath = writeUserInfo(JSON.stringify({ 'X-User-Account': 'user-123' }));
  const configPath = writePolicyConfig({
    overwrite: false,
    enabled: true,
    baseUrlWhitelist: ['http://model.example/v1/'],
    headerNames: ['X-User-Account'],
  });
  updateOutboundHeaderUserInfoCache(userInfoPath, undefined, configPath);

  try {
    const address = proxyServer.address();
    if (!address || typeof address === 'string') throw new Error('Proxy server did not start.');
    const { setFixedProxyUrl } = await import('./systemProxy');
    setFixedProxyUrl(`http://127.0.0.1:${address.port}`);

    await mainProcessTitleFetch('http://model.example/v1/title', { method: 'POST' });
    await mainProcessTitleFetch('http://model.example/v2/title', { method: 'POST' });

    expect(receivedHeaders).toEqual(['user-123', undefined]);
    const injectionLogs = injectionLogSpy.mock.calls.filter(
      ([message]) =>
        typeof message === 'string' &&
        message.startsWith(
          '[MainProcessOutboundHeaderPolicy] source=session-title outbound header policy matched ',
        ),
    );
    expect(injectionLogs).toHaveLength(1);
    expect(injectionLogs[0]).toHaveLength(1);
    expect(String(injectionLogs[0][0])).toMatch(
      /^\[MainProcessOutboundHeaderPolicy\] source=session-title outbound header policy matched requestId=[0-9a-f-]+ origin=http:\/\/model\.example matched=true injectedHeaderCount=1$/,
    );
  } finally {
    injectionLogSpy.mockRestore();
    const { setFixedProxyUrl } = await import('./systemProxy');
    setFixedProxyUrl(null);
    await new Promise<void>(resolve => proxyServer.close(() => resolve()));
  }
});

test('identifies Main title requests when skipping unsafe outbound header values', () => {
  const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const userInfoPath = writeUserInfo(JSON.stringify({ 'X-User-Account': '用户-123' }));
  const configPath = writePolicyConfig({
    overwrite: false,
    enabled: true,
    baseUrlWhitelist: ['http://model.example/v1/'],
    headerNames: ['X-User-Account'],
  });
  updateOutboundHeaderUserInfoCache(userInfoPath, undefined, configPath);

  try {
    expect(
      applyMainProcessOutboundHeaderPolicy(
        'http://model.example/v1/title',
        undefined,
        MainProcessOutboundHeaderSource.SessionTitle,
      ),
    ).toEqual({});
    expect(warningSpy).toHaveBeenCalledWith(
      '[MainProcessOutboundHeaderPolicy] source=session-title skipped unsafe outbound header value: X-User-Account',
    );
  } finally {
    warningSpy.mockRestore();
  }
});

const findReachableNonLoopbackIpv4 = (): string | null => {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return null;
};
const NON_LOOPBACK_IPV4 = findReachableNonLoopbackIpv4();

const requestThroughHttpProxy = (
  proxyUrl: URL,
  targetUrl: string,
  authorization?: string,
  hostHeader?: string,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const request = http.request(
      {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        path: targetUrl,
        headers: {
          Host: hostHeader ?? target.host,
          ...(authorization ? { 'Proxy-Authorization': authorization } : {}),
        },
      },
      response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode || 0));
      },
    );
    request.once('error', reject);
    request.end();
  });

const requestThroughHttpsProxy = (
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  authorization: string,
  caCertificate: string,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
    let connectResponse = Buffer.alloc(0);
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          `Proxy-Authorization: ${authorization}\r\n\r\n`,
      );
    });
    const onConnectData = (chunk: Buffer) => {
      connectResponse = Buffer.concat([connectResponse, chunk]);
      const headerEnd = connectResponse.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      socket.off('data', onConnectData);
      if (!connectResponse.subarray(0, headerEnd).toString().startsWith('HTTP/1.1 200')) {
        fail(new Error(`CONNECT failed: ${connectResponse.toString()}`));
        return;
      }
      const remaining = connectResponse.subarray(headerEnd + 4);
      if (remaining.length > 0) socket.unshift(remaining);
      const secureSocket = tls.connect({
        socket,
        servername: net.isIP(targetHost) ? undefined : targetHost,
        ca: caCertificate,
        checkServerIdentity: (_hostname, certificate) =>
          tls.checkServerIdentity(targetHost, certificate),
      });
      secureSocket.once('error', reject);
      secureSocket.once('secureConnect', () => {
        secureSocket.write(
          `GET /protected HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: close\r\n\r\n`,
        );
      });
      let response = '';
      secureSocket.on('data', chunk => {
        response += chunk.toString();
      });
      secureSocket.once('end', () => {
        const match = response.match(/^HTTP\/1\.1 (\d{3})/);
        resolve(match ? Number(match[1]) : 0);
      });
    };
    socket.on('data', onConnectData);
  });

const requestHttpThroughConnectProxy = (
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  authorization: string,
  requestPath = '/protected',
): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
    let response = Buffer.alloc(0);
    let tunnelEstablished = false;
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          `Proxy-Authorization: ${authorization}\r\n\r\n`,
      );
    });
    socket.on('data', chunk => {
      response = Buffer.concat([response, chunk]);
      if (!tunnelEstablished) {
        const headerEnd = response.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        if (!response.subarray(0, headerEnd).toString().startsWith('HTTP/1.1 200')) {
          fail(new Error(`CONNECT failed: ${response.toString()}`));
          return;
        }
        tunnelEstablished = true;
        response = response.subarray(headerEnd + 4);
        socket.write(
          `GET ${requestPath} HTTP/1.1\r\n` +
            `Host: ${targetHost}:${targetPort}\r\n` +
            'Connection: close\r\n\r\n',
        );
      }
    });
    socket.once('end', () => {
      const match = response.toString().match(/^HTTP\/1\.1 (\d{3})/);
      resolve(match ? Number(match[1]) : 0);
    });
  });

const openAuthenticatedTunnel = (
  proxyUrl: URL,
  targetHost: string,
  targetPort: number,
  authorization: string,
): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname);
    let response = '';
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          `Proxy-Authorization: ${authorization}\r\n\r\n`,
      );
    });
    const onData = (chunk: Buffer) => {
      response += chunk.toString();
      if (!response.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      if (!response.startsWith('HTTP/1.1 200')) {
        socket.destroy();
        reject(new Error(`CONNECT failed: ${response}`));
        return;
      }
      resolve(socket);
    };
    socket.on('data', onData);
  });

test('matches no requests when the whitelist is empty', () => {
  expect(shouldInjectOutboundHeaders('https://example.com/a', [])).toBe(false);
});

test('matches only configured origins and path prefixes', () => {
  const baseUrlWhitelist = ['https://example.com/api/'];

  expect(shouldInjectOutboundHeaders('https://example.com/api/users', baseUrlWhitelist)).toBe(true);
  expect(shouldInjectOutboundHeaders('https://example.com/other', baseUrlWhitelist)).toBe(false);
  expect(shouldInjectOutboundHeaders('https://other.example/api/users', baseUrlWhitelist)).toBe(
    false,
  );
});

test('applies outbound headers only when enabled and the URL is whitelisted', () => {
  const config = {
    enabled: true,
    baseUrlWhitelist: ['https://example.com/api/'],
    headerNames: [HEADER_NAMES.USER_ACCOUNT],
  };

  expect(isOutboundHeaderProxyActive(config)).toBe(true);
  expect(shouldApplyOutboundHeadersForRequest(config, 'https://example.com/api/users')).toBe(true);
  expect(shouldApplyOutboundHeadersForRequest(config, 'https://example.com/other')).toBe(false);
  expect(
    shouldApplyOutboundHeadersForRequest(
      { ...config, enabled: false },
      'https://example.com/api/users',
    ),
  ).toBe(false);
});

test('reads configured values from user_info.json', () => {
  const userInfoPath = writeUserInfo(
    JSON.stringify({
      [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
      [HEADER_NAMES.COOKIE]: 'cookie-value',
      ignored: 'not-a-header',
    }),
  );

  expect(updateOutboundHeaderUserInfoCache(userInfoPath, CONFIGURED_HEADER_NAMES)).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
    [HEADER_NAMES.COOKIE]: 'cookie-value',
  });
});

test('drops unsafe outbound header values with control characters', () => {
  const userInfoPath = writeUserInfo(
    JSON.stringify({
      [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
      [HEADER_NAMES.COOKIE]: 'Cookie: a=b\r\nHost: example.com\r\n\r\nbody',
    }),
  );

  expect(updateOutboundHeaderUserInfoCache(userInfoPath, CONFIGURED_HEADER_NAMES)).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
    [HEADER_NAMES.COOKIE]: '',
  });
});

test('uses empty strings for missing, empty, null, or unsupported values', () => {
  const userInfoPath = writeUserInfo(
    JSON.stringify({
      [HEADER_NAMES.USER_ACCOUNT]: '',
      [HEADER_NAMES.COOKIE]: null,
      object_value: { secret: true },
    }),
  );

  expect(
    updateOutboundHeaderUserInfoCache(userInfoPath, [
      ...CONFIGURED_HEADER_NAMES,
      'missing',
      'object_value',
    ]),
  ).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: '',
    [HEADER_NAMES.COOKIE]: '',
    missing: '',
    object_value: '',
  });
});

test('uses empty values when user_info.json does not exist', () => {
  expect(
    updateOutboundHeaderUserInfoCache('missing-user-info.json', CONFIGURED_HEADER_NAMES),
  ).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: '',
    [HEADER_NAMES.COOKIE]: '',
  });
});

test('reuses cached user info until the update function is called', () => {
  const userInfoPath = writeUserInfo(JSON.stringify({ [HEADER_NAMES.USER_ACCOUNT]: 'first' }));

  updateOutboundHeaderUserInfoCache(userInfoPath, [HEADER_NAMES.USER_ACCOUNT]);
  fs.writeFileSync(userInfoPath, JSON.stringify({ [HEADER_NAMES.USER_ACCOUNT]: 'second' }));

  expect(getOutboundHeaderUserInfo(userInfoPath, [HEADER_NAMES.USER_ACCOUNT])).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: 'first',
  });
  expect(updateOutboundHeaderUserInfoCache(userInfoPath, [HEADER_NAMES.USER_ACCOUNT])).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: 'second',
  });
});

test('reloads the outbound header policy together with user info', () => {
  const userInfoPath = writeUserInfo(JSON.stringify({ account_id: 'account-123' }));
  const configPath = writePolicyConfig({
    overwrite: false,
    enabled: false,
    baseUrlWhitelist: ['https://example.com/api/'],
    headerNames: ['account_id'],
  });

  expect(updateOutboundHeaderUserInfoCache(userInfoPath, undefined, configPath)).toEqual({
    account_id: 'account-123',
  });
  expect(getOutboundHeaderPolicyConfig()).toEqual({
    overwrite: false,
    enabled: false,
    baseUrlWhitelist: ['https://example.com/api/'],
    headerNames: ['account_id'],
  });
});

test('logs refreshed whitelist and header counts without logging values', () => {
  const userInfoPath = writeUserInfo(
    JSON.stringify({ account_id: 'account-123', session_id: 'secret-session' }),
  );
  const configPath = writePolicyConfig({
    overwrite: false,
    enabled: true,
    baseUrlWhitelist: ['https://one.example/api/', 'https://two.example/api/'],
    headerNames: ['account_id', 'session_id'],
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    updateOutboundHeaderUserInfoCache(userInfoPath, undefined, configPath);

    expect(logSpy).toHaveBeenCalledWith(
      '[OutboundHeaderPolicy] Cache updated: baseUrlWhitelistCount=2 headerCount=2',
    );
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('account-123');
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('secret-session');
  } finally {
    logSpy.mockRestore();
  }
});

test('rewrites policy config with defaults when overwrite is missing', () => {
  const userInfoPath = writeUserInfo(JSON.stringify({ [HEADER_NAMES.USER_ACCOUNT]: 'user-123' }));
  const configPath = writePolicyConfig({
    enabled: false,
    baseUrlWhitelist: ['https://example.com/api/'],
    headerNames: [HEADER_NAMES.USER_ACCOUNT],
  });

  expect(updateOutboundHeaderUserInfoCache(userInfoPath, undefined, configPath)).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
    [HEADER_NAMES.COOKIE]: '',
  });
  expect(getOutboundHeaderPolicyConfig()).toEqual(DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG);
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(
    DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG,
  );
});

test('rewrites policy config with defaults when overwrite is true', () => {
  const userInfoPath = writeUserInfo(JSON.stringify({ custom_header: 'custom-value' }));
  const configPath = writePolicyConfig({
    overwrite: true,
    enabled: false,
    baseUrlWhitelist: ['https://example.com/api/'],
    headerNames: ['custom_header'],
  });

  expect(updateOutboundHeaderUserInfoCache(userInfoPath, undefined, configPath)).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: '',
    [HEADER_NAMES.COOKIE]: '',
  });
  expect(getOutboundHeaderPolicyConfig()).toEqual(DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG);
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(
    DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG,
  );
});

test('adds only configured header values and replaces names case-insensitively', () => {
  const headers = { [HEADER_NAMES.USER_ACCOUNT]: 'old-value', untouched: 'yes' };

  expect(
    applyOutboundHeaders(headers, {
      [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
      [HEADER_NAMES.COOKIE]: 'cookie-value',
    }),
  ).toBe(2);

  expect(headers).toEqual({
    [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
    [HEADER_NAMES.COOKIE]: 'cookie-value',
    untouched: 'yes',
  });
});

test('injects an immutable header snapshot into 100 concurrent request header objects', async () => {
  const sourceHeaders = Array.from({ length: 100 }, (_, index) => ({
    'X-Request-Number': String(index),
  }));

  await Promise.all(
    sourceHeaders.map(async headers => {
      applyOutboundHeaders(headers, {
        [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
        account_id: 'account-123',
      });
    }),
  );

  sourceHeaders.forEach((headers, index) => {
    expect(headers).toEqual({
      'X-Request-Number': String(index),
      [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
      account_id: 'account-123',
    });
  });
});

test('skips unsafe outbound header values during injection', () => {
  const headers = { untouched: 'yes' };
  const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    expect(
      applyOutboundHeaders(headers, {
        [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
        [HEADER_NAMES.COOKIE]: 'Cookie: a=b\r\nHost: example.com',
      }),
    ).toBe(1);

    expect(headers).toEqual({
      [HEADER_NAMES.USER_ACCOUNT]: 'user-123',
      untouched: 'yes',
    });
    expect(warningSpy).toHaveBeenCalledWith(
      '[OutboundHeaderProxy] Skipped unsafe outbound header value: X-Cookie',
    );
  } finally {
    warningSpy.mockRestore();
  }
});

test('normalizes the static policy and ignores invalid base URLs', () => {
  expect(
    resolveOutboundHeaderProxyConfig({
      enabled: true,
      headerNames: [
        ` ${HEADER_NAMES.USER_ACCOUNT} `,
        '',
        'invalid header',
        'bad:header',
        HEADER_NAMES.COOKIE,
      ],
      baseUrlWhitelist: ['https://one.example/api/', 'invalid', 'http://two.example/'],
    }),
  ).toEqual({
    enabled: true,
    headerNames: CONFIGURED_HEADER_NAMES,
    baseUrlWhitelist: ['https://one.example/api/', 'http://two.example/'],
  });
});

test('classifies proxy client disconnects as ignorable errors', () => {
  expect(
    isIgnorableProxyClientError(
      Object.assign(new Error('socket hang up'), {
        code: 'ECONNRESET',
      }),
    ),
  ).toBe(true);
  expect(isIgnorableProxyClientError(new Error('connection reset by peer'))).toBe(true);
  expect(
    isIgnorableProxyClientError(
      Object.assign(new Error('upstream failed'), {
        code: 'ETIMEDOUT',
      }),
    ),
  ).toBe(false);
});

test('suppresses noisy MITM logs only for ignorable disconnects', () => {
  const resetError = Object.assign(new Error('socket hang up'), {
    code: 'ECONNRESET',
  });

  expect(shouldSuppressMitmProxyErrorLog('SERVER_TO_PROXY_RESPONSE_ERROR', resetError)).toBe(true);
  expect(shouldSuppressMitmProxyErrorLog('PROXY_TO_SERVER_REQUEST_ERROR', resetError)).toBe(true);
  expect(shouldSuppressMitmProxyErrorLog('CLIENT_TO_PROXY_SOCKET', resetError)).toBe(true);
  expect(shouldSuppressMitmProxyErrorLog('HTTPS_CLIENT_ERROR', resetError)).toBe(true);
  expect(shouldSuppressMitmProxyErrorLog('ON_REQUEST_ERROR', resetError)).toBe(false);
  expect(
    shouldSuppressMitmProxyErrorLog(
      'SERVER_TO_PROXY_RESPONSE_ERROR',
      Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    ),
  ).toBe(false);
});

test('keeps MITM error handlers while skipping raw disconnect logging', () => {
  const originalOnError = vi.fn();
  const proxyHandler = vi.fn();
  const contextHandler = vi.fn();
  const originalOnSocketError = vi.fn();
  const proxy = {
    _onError: originalOnError,
    _onSocketError: originalOnSocketError,
    onErrorHandlers: [proxyHandler],
  };
  const context = {
    onErrorHandlers: [contextHandler],
  };
  const resetError = Object.assign(new Error('socket hang up'), {
    code: 'ECONNRESET',
  });

  suppressNoisyMitmDisconnectLogs(proxy as never);
  proxy._onSocketError('CLIENT_TO_PROXY_SOCKET', resetError);
  proxy._onError('SERVER_TO_PROXY_RESPONSE_ERROR', context, resetError);

  expect(originalOnSocketError).not.toHaveBeenCalled();
  expect(originalOnError).not.toHaveBeenCalled();
  expect(proxyHandler).toHaveBeenCalledWith(context, resetError, 'SERVER_TO_PROXY_RESPONSE_ERROR');
  expect(contextHandler).toHaveBeenCalledWith(
    context,
    resetError,
    'SERVER_TO_PROXY_RESPONSE_ERROR',
  );

  const timeoutError = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  proxy._onSocketError('CLIENT_TO_PROXY_SOCKET', timeoutError);
  proxy._onError('SERVER_TO_PROXY_RESPONSE_ERROR', context, timeoutError);

  expect(originalOnSocketError).toHaveBeenCalledWith('CLIENT_TO_PROXY_SOCKET', timeoutError);
  expect(originalOnError).toHaveBeenCalledWith(
    'SERVER_TO_PROXY_RESPONSE_ERROR',
    context,
    timeoutError,
  );
});

test('filters http-mitm-proxy console noise for ignorable socket resets', () => {
  const originalDebug = console.debug;
  const originalError = console.error;
  const debugCalls: unknown[][] = [];
  const errorCalls: unknown[][] = [];
  const resetError = Object.assign(new Error('read ECONNRESET'), {
    code: 'ECONNRESET',
  });
  const timeoutError = Object.assign(new Error('timeout'), {
    code: 'ETIMEDOUT',
  });

  console.debug = (...args: unknown[]) => {
    debugCalls.push(args);
  };
  console.error = (...args: unknown[]) => {
    errorCalls.push(args);
  };

  try {
    installNoisyMitmConsoleFilter();

    console.debug('Got ECONNRESET on CLIENT_TO_PROXY_SOCKET, ignoring.');
    console.debug('useful debug');
    console.error('Socket error:');
    console.error(resetError);
    console.error('Socket error:');
    console.error(timeoutError);
    console.error('real error');

    expect(debugCalls).toEqual([['useful debug']]);
    expect(errorCalls).toEqual([['Socket error:'], [timeoutError], ['real error']]);
  } finally {
    uninstallNoisyMitmConsoleFilter();
    console.debug = originalDebug;
    console.error = originalError;
  }
});

test('accepts a dynamic upstream proxy resolver and user info path', () => {
  const resolver = async (targetUrl: string) =>
    targetUrl.startsWith('https://internal.example') ? 'http://system-proxy:8080' : null;

  expect(
    () =>
      new OutboundHeaderProxy(undefined, resolver, 'C:\\AppData\\JustDo\\huawei\\user_info.json'),
  ).not.toThrow();
});

test('moves remote NO_PROXY entries behind the Gateway local proxy route', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-outbound-proxy-'));
  temporaryDirectories.push(directory);
  const userInfoPath = path.join(directory, 'user_info.json');
  fs.writeFileSync(userInfoPath, JSON.stringify({ [HEADER_NAMES.USER_ACCOUNT]: 'user-123' }));
  updateOutboundHeaderUserInfoCache(userInfoPath, [HEADER_NAMES.USER_ACCOUNT]);
  const before = { ...process.env };
  const outboundProxy = new OutboundHeaderProxy(
    {
      enabled: true,
      baseUrlWhitelist: ['https://example.com/api/'],
      headerNames: [HEADER_NAMES.USER_ACCOUNT],
    },
    async () => null,
    userInfoPath,
    path.join(directory, 'ca'),
  );
  const overlapLogSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    await outboundProxy.start();
    expect(process.env).toEqual(before);
    const baseEnv = {
      NO_PROXY: '*.example.com,other.example.net',
      no_proxy: '.internal.example',
    };
    const gatewayEnv = outboundProxy.buildGatewayEnvironment(baseEnv);
    expect(gatewayEnv.NO_PROXY?.split(',')).not.toContain('*.example.com');
    expect(gatewayEnv.NO_PROXY?.split(',')).not.toContain('other.example.net');
    expect(gatewayEnv.NO_PROXY?.split(',')).not.toContain('.internal.example');
    expect(gatewayEnv.NO_PROXY?.split(',')).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1', '::1']),
    );
    expect(baseEnv).toEqual({
      NO_PROXY: '*.example.com,other.example.net',
      no_proxy: '.internal.example',
    });
    expect(overlapLogSpy).toHaveBeenCalledWith(
      '[OutboundHeaderProxy] Reconciled Gateway NO_PROXY overlap: conflictingEntries=["*.example.com"] affectedHeaderNames=["X-User-Account"] disabledHeaderNames=[] action="route remote bypasses through local proxy, then preserve direct upstream bypass"; clients that set a conflicting NO_PROXY after startup may bypass local header injection.',
    );
  } finally {
    overlapLogSpy.mockRestore();
    outboundProxy.stop();
  }
  expect(process.env).toEqual(before);
});

test('ignores loopback whitelist entries without blocking application startup', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-outbound-proxy-'));
  temporaryDirectories.push(directory);
  const outboundProxy = new OutboundHeaderProxy(
    {
      enabled: true,
      baseUrlWhitelist: ['http://127.0.0.1:4000/'],
      headerNames: [HEADER_NAMES.USER_ACCOUNT],
    },
    async () => null,
    path.join(directory, 'user_info.json'),
    path.join(directory, 'ca'),
  );

  await expect(outboundProxy.start()).resolves.toBeNull();
  expect(outboundProxy.buildGatewayEnvironment({ NO_PROXY: 'localhost' })).toEqual({
    NO_PROXY: 'localhost',
  });
});

test.each(['http://127.0.0.2:4000/', 'http://[::ffff:127.0.0.1]:4000/'])(
  'ignores loopback variant %s in Gateway proxy policy',
  async baseUrl => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-outbound-proxy-'));
    temporaryDirectories.push(directory);
    const outboundProxy = new OutboundHeaderProxy(
      {
        enabled: true,
        baseUrlWhitelist: [baseUrl],
        headerNames: [HEADER_NAMES.USER_ACCOUNT],
      },
      async () => null,
      path.join(directory, 'user_info.json'),
      path.join(directory, 'ca'),
    );

    await expect(outboundProxy.start()).resolves.toBeNull();
  },
);

test.skipIf(!NON_LOOPBACK_IPV4)(
  'keeps runtime policy reloads reachable through the Gateway proxy',
  async () => {
    const targetHost = NON_LOOPBACK_IPV4!;
    const receivedHeaders: Array<string | undefined> = [];
    const targetServer = http.createServer((request, response) => {
      receivedHeaders.push(
        request.headers[HEADER_NAMES.USER_ACCOUNT.toLowerCase()] as string | undefined,
      );
      response.end('ok');
    });
    await new Promise<void>((resolve, reject) => {
      targetServer.once('error', reject);
      targetServer.listen(0, '0.0.0.0', resolve);
    });
    const targetAddress = targetServer.address();
    if (!targetAddress || typeof targetAddress === 'string')
      throw new Error('Target did not start.');
    let attackerRequests = 0;
    const attackerServer = http.createServer((_request, response) => {
      attackerRequests += 1;
      response.end('unexpected');
    });
    await new Promise<void>((resolve, reject) => {
      attackerServer.once('error', reject);
      attackerServer.listen(0, '0.0.0.0', resolve);
    });
    const attackerAddress = attackerServer.address();
    if (!attackerAddress || typeof attackerAddress === 'string') {
      throw new Error('Attacker target did not start.');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-outbound-proxy-'));
    temporaryDirectories.push(directory);
    const userInfoPath = path.join(directory, 'user_info.json');
    fs.writeFileSync(userInfoPath, JSON.stringify({ [HEADER_NAMES.USER_ACCOUNT]: 'user-123' }));
    updateOutboundHeaderUserInfoCache(userInfoPath, [HEADER_NAMES.USER_ACCOUNT]);
    const targetUrl = `http://${targetHost}:${targetAddress.port}/protected`;
    const upstreamProxyResolver = vi.fn(async () => 'http://127.0.0.1:1');
    const outboundProxy = new OutboundHeaderProxy(
      {
        enabled: true,
        baseUrlWhitelist: ['http://unrelated.example/protected'],
        headerNames: [HEADER_NAMES.USER_ACCOUNT],
      },
      upstreamProxyResolver,
      userInfoPath,
      path.join(directory, 'ca'),
    );

    try {
      await outboundProxy.start();
      const gatewayEnv = outboundProxy.buildGatewayEnvironment({ NO_PROXY: targetHost });
      expect(gatewayEnv.NO_PROXY?.split(',')).not.toContain(targetHost);
      (
        outboundProxy as unknown as {
          activePolicy: {
            enabled: boolean;
            baseUrlWhitelist: readonly string[];
            headerNames: readonly string[];
          };
        }
      ).activePolicy = Object.freeze({
        enabled: true,
        baseUrlWhitelist: Object.freeze([targetUrl]),
        headerNames: Object.freeze([HEADER_NAMES.USER_ACCOUNT]),
      });
      const proxyUrl = new URL(gatewayEnv.HTTP_PROXY!);
      const authorization = `Basic ${Buffer.from(
        `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
      ).toString('base64')}`;
      proxyUrl.username = '';
      proxyUrl.password = '';

      expect(await requestThroughHttpProxy(proxyUrl, targetUrl)).toBe(407);
      expect(receivedHeaders).toHaveLength(0);
      expect(
        await Promise.all(
          Array.from({ length: 3 }, () =>
            requestThroughHttpProxy(proxyUrl, targetUrl, authorization),
          ),
        ),
      ).toEqual([200, 200, 200]);
      expect(receivedHeaders).toEqual(['user-123', 'user-123', 'user-123']);
      expect(upstreamProxyResolver).not.toHaveBeenCalled();
      expect(
        await requestThroughHttpProxy(
          proxyUrl,
          `http://${targetHost}:${attackerAddress.port}/protected`,
          authorization,
          `${targetHost}:${targetAddress.port}`,
        ),
      ).toBe(504);
      expect(attackerRequests).toBe(0);

      const oldGenerationTunnel = await openAuthenticatedTunnel(
        proxyUrl,
        targetHost,
        attackerAddress.port,
        authorization,
      );
      const oldTunnelClosed = new Promise<void>(resolve =>
        oldGenerationTunnel.once('close', () => resolve()),
      );
      outboundProxy.rotateGatewayCapability();
      await oldTunnelClosed;
      expect(await requestThroughHttpProxy(proxyUrl, targetUrl, authorization)).toBe(407);
      expect(receivedHeaders).toHaveLength(3);
      const nextProxyUrl = new URL(
        outboundProxy.buildGatewayEnvironment({ NO_PROXY: targetHost }).HTTP_PROXY!,
      );
      const nextAuthorization = `Basic ${Buffer.from(
        `${decodeURIComponent(nextProxyUrl.username)}:${decodeURIComponent(nextProxyUrl.password)}`,
      ).toString('base64')}`;
      nextProxyUrl.username = '';
      nextProxyUrl.password = '';
      expect(await requestThroughHttpProxy(nextProxyUrl, targetUrl, nextAuthorization)).toBe(200);
      expect(receivedHeaders).toHaveLength(4);
    } finally {
      outboundProxy.stop();
      await new Promise<void>(resolve => targetServer.close(() => resolve()));
      await new Promise<void>(resolve => attackerServer.close(() => resolve()));
    }
  },
);

test('keeps the startup enabled state while refreshing the runtime policy', () => {
  const startupEnabled = getOutboundHeaderPolicyConfig().enabled;
  captureOutboundHeaderStartupEnabled();
  const userInfoPath = writeUserInfo(JSON.stringify({ refreshed_header: 'refreshed-value' }));
  const configPath = writePolicyConfig({
    overwrite: false,
    enabled: !startupEnabled,
    baseUrlWhitelist: ['https://refreshed.example/api/'],
    headerNames: ['refreshed_header'],
  });

  updateOutboundHeaderUserInfoCache(userInfoPath, undefined, configPath);

  expect(getOutboundHeaderPolicyConfig()).toEqual({
    overwrite: false,
    enabled: startupEnabled,
    baseUrlWhitelist: ['https://refreshed.example/api/'],
    headerNames: ['refreshed_header'],
  });
  expect(getOutboundHeaderUserInfo()).toEqual({ refreshed_header: 'refreshed-value' });
});

test.skipIf(!NON_LOOPBACK_IPV4)(
  'injects headers into HTTP requests carried over CONNECT',
  async () => {
    const targetHost = NON_LOOPBACK_IPV4!;
    const receivedHeaders: Array<string | undefined> = [];
    const targetServer = http.createServer((request, response) => {
      receivedHeaders.push(
        request.headers[HEADER_NAMES.USER_ACCOUNT.toLowerCase()] as string | undefined,
      );
      response.end('ok');
    });
    await new Promise<void>((resolve, reject) => {
      targetServer.once('error', reject);
      targetServer.listen(0, '0.0.0.0', resolve);
    });
    const targetAddress = targetServer.address();
    if (!targetAddress || typeof targetAddress === 'string') {
      throw new Error('Target did not start.');
    }
    const rawTunnelHeaders: Array<string | undefined> = [];
    const rawTunnelServer = http.createServer((request, response) => {
      rawTunnelHeaders.push(
        request.headers[HEADER_NAMES.USER_ACCOUNT.toLowerCase()] as string | undefined,
      );
      response.end('ok');
    });
    await new Promise<void>((resolve, reject) => {
      rawTunnelServer.once('error', reject);
      rawTunnelServer.listen(0, '0.0.0.0', resolve);
    });
    const rawTunnelAddress = rawTunnelServer.address();
    if (!rawTunnelAddress || typeof rawTunnelAddress === 'string') {
      throw new Error('Raw tunnel target did not start.');
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-outbound-connect-http-'));
    temporaryDirectories.push(directory);
    const userInfoPath = path.join(directory, 'user_info.json');
    fs.writeFileSync(userInfoPath, JSON.stringify({ [HEADER_NAMES.USER_ACCOUNT]: 'user-123' }));
    updateOutboundHeaderUserInfoCache(userInfoPath, [HEADER_NAMES.USER_ACCOUNT]);
    const outboundProxy = new OutboundHeaderProxy(
      {
        enabled: true,
        baseUrlWhitelist: [`http://${targetHost}:${targetAddress.port}/protected`],
        headerNames: [HEADER_NAMES.USER_ACCOUNT],
      },
      async () => null,
      userInfoPath,
      path.join(directory, 'ca'),
    );

    try {
      await outboundProxy.start();
      const proxyUrl = new URL(outboundProxy.buildGatewayEnvironment({}).HTTP_PROXY!);
      const authorization = `Basic ${Buffer.from(
        `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
      ).toString('base64')}`;
      proxyUrl.username = '';
      proxyUrl.password = '';

      expect(
        await requestHttpThroughConnectProxy(
          proxyUrl,
          targetHost,
          targetAddress.port,
          authorization,
        ),
      ).toBe(200);
      expect(
        await requestHttpThroughConnectProxy(
          proxyUrl,
          targetHost,
          targetAddress.port,
          authorization,
          '/other',
        ),
      ).toBe(200);
      expect(receivedHeaders).toEqual(['user-123', undefined]);
      expect(
        await requestHttpThroughConnectProxy(
          proxyUrl,
          targetHost,
          rawTunnelAddress.port,
          authorization,
        ),
      ).toBe(200);
      expect(rawTunnelHeaders).toEqual([undefined]);
    } finally {
      outboundProxy.stop();
      await new Promise<void>(resolve => targetServer.close(() => resolve()));
      await new Promise<void>(resolve => rawTunnelServer.close(() => resolve()));
    }
  },
);

test.skipIf(!NON_LOOPBACK_IPV4)(
  'injects headers into all three first concurrent HTTPS requests',
  async () => {
    const targetHost = NON_LOOPBACK_IPV4!;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-outbound-https-'));
    temporaryDirectories.push(directory);
    const targetCaDirectory = path.join(directory, 'target-ca');
    const certificateAuthority = await new Promise<CA>((resolve, reject) => {
      CA.create(targetCaDirectory, (error: Error | null, instance: CA) =>
        error ? reject(error) : resolve(instance),
      );
    });
    const serverCertificate = await new Promise<{ cert: string; key: string }>(resolve => {
      certificateAuthority.generateServerCertificateKeys(targetHost, (cert: string, key: string) =>
        resolve({ cert, key }),
      );
    });
    const caDirectory = path.join(directory, 'proxy-ca');

    const receivedHeaders: Array<string | undefined> = [];
    const targetServer = https.createServer(serverCertificate, (request, response) => {
      receivedHeaders.push(
        request.headers[HEADER_NAMES.USER_ACCOUNT.toLowerCase()] as string | undefined,
      );
      response.end('ok');
    });
    await new Promise<void>((resolve, reject) => {
      targetServer.once('error', reject);
      targetServer.listen(0, '0.0.0.0', resolve);
    });
    const targetAddress = targetServer.address();
    if (!targetAddress || typeof targetAddress === 'string')
      throw new Error('Target did not start.');
    const tunneledHeaders: Array<string | undefined> = [];
    const tunneledServer = https.createServer(serverCertificate, (request, response) => {
      tunneledHeaders.push(
        request.headers[HEADER_NAMES.USER_ACCOUNT.toLowerCase()] as string | undefined,
      );
      response.end('ok');
    });
    await new Promise<void>((resolve, reject) => {
      tunneledServer.once('error', reject);
      tunneledServer.listen(0, '0.0.0.0', resolve);
    });
    const tunneledAddress = tunneledServer.address();
    if (!tunneledAddress || typeof tunneledAddress === 'string') {
      throw new Error('Tunnel target did not start.');
    }

    const userInfoPath = path.join(directory, 'user_info.json');
    fs.writeFileSync(userInfoPath, JSON.stringify({ [HEADER_NAMES.USER_ACCOUNT]: 'user-123' }));
    updateOutboundHeaderUserInfoCache(userInfoPath, [HEADER_NAMES.USER_ACCOUNT]);
    const outboundProxy = new OutboundHeaderProxy(
      {
        enabled: true,
        baseUrlWhitelist: [`https://${targetHost}:${targetAddress.port}/protected`],
        headerNames: [HEADER_NAMES.USER_ACCOUNT],
      },
      async () => null,
      userInfoPath,
      caDirectory,
    );
    const injectionLogSpy = vi.spyOn(console, 'log');

    try {
      await outboundProxy.start();
      const internalProxy = (outboundProxy as unknown as { proxy: { httpsAgent: https.Agent } })
        .proxy;
      internalProxy.httpsAgent = new https.Agent({ rejectUnauthorized: false });
      const gatewayEnv = outboundProxy.buildGatewayEnvironment({});
      buildTrustedCaBundle(directory);
      const proxyUrl = new URL(gatewayEnv.HTTPS_PROXY!);
      const authorization = `Basic ${Buffer.from(
        `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
      ).toString('base64')}`;
      proxyUrl.username = '';
      proxyUrl.password = '';
      const gatewayCaBundle = fs.readFileSync(gatewayEnv.NODE_EXTRA_CA_CERTS!, 'utf8');
      const caCertificate = fs.readFileSync(path.join(caDirectory, 'certs', 'ca.pem'), 'utf8');
      const targetCaCertificate = fs.readFileSync(
        path.join(targetCaDirectory, 'certs', 'ca.pem'),
        'utf8',
      );
      expect(gatewayCaBundle).toContain(caCertificate.trim());

      expect(
        await Promise.all(
          Array.from({ length: 3 }, () =>
            requestThroughHttpsProxy(
              proxyUrl,
              targetHost,
              targetAddress.port,
              authorization,
              gatewayCaBundle,
            ),
          ),
        ),
      ).toEqual([200, 200, 200]);
      expect(receivedHeaders).toEqual(['user-123', 'user-123', 'user-123']);
      expect(
        await requestThroughHttpsProxy(
          proxyUrl,
          targetHost,
          tunneledAddress.port,
          authorization,
          targetCaCertificate,
        ),
      ).toBe(200);
      expect(tunneledHeaders).toEqual([undefined]);
      const injectionLogs = injectionLogSpy.mock.calls.filter(
        ([message]) =>
          typeof message === 'string' &&
          message.startsWith('[OutboundHeaderProxy] outbound header policy matched '),
      );
      expect(injectionLogs).toHaveLength(3);
      expect(
        injectionLogs.every(args => args.length === 1 && !String(args[0]).includes('\n')),
      ).toBe(true);
      expect(
        injectionLogs.every(([message]) =>
          String(message).endsWith(
            `origin=https://${targetHost}:${targetAddress.port} matched=true injectedHeaderCount=1`,
          ),
        ),
      ).toBe(true);
    } finally {
      injectionLogSpy.mockRestore();
      outboundProxy.stop();
      await new Promise<void>(resolve => targetServer.close(() => resolve()));
      await new Promise<void>(resolve => tunneledServer.close(() => resolve()));
    }
  },
);
