import { expect, test } from 'vitest';

import { buildGatewayNetworkEnvironment } from './gatewayNetworkEnvironment';

test('builds a Gateway-only proxy snapshot without mutating its base environment', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    HTTP_PROXY: 'http://upstream.example:8080',
    NO_PROXY: 'internal.example,localhost',
  };

  const result = buildGatewayNetworkEnvironment(
    baseEnv,
    {
      proxyUrl: 'http://openclaw:secret@127.0.0.1:4321/',
      caBundlePath: 'C:\\certs\\gateway.pem',
    },
    ['127.0.0.1:18789'],
  );

  expect(baseEnv).toEqual({
    HTTP_PROXY: 'http://upstream.example:8080',
    NO_PROXY: 'internal.example,localhost',
  });
  expect(result.HTTP_PROXY).toBe('http://openclaw:secret@127.0.0.1:4321/');
  expect(result.HTTPS_PROXY).toBe(result.HTTP_PROXY);
  expect(result.NO_PROXY?.split(',')).toEqual(
    expect.arrayContaining([
      'internal.example',
      'localhost',
      '127.0.0.1',
      '::1',
      '127.0.0.1:18789',
    ]),
  );
  expect(result.NODE_EXTRA_CA_CERTS).toBe('C:\\certs\\gateway.pem');
});

test('returns an independent snapshot when outbound proxying is inactive', () => {
  const baseEnv = { VALUE: 'one' };
  const result = buildGatewayNetworkEnvironment(baseEnv, null);
  result.VALUE = 'two';
  expect(baseEnv.VALUE).toBe('one');
});
