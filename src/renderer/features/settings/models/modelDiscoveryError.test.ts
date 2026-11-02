import { expect, test, vi } from 'vitest';

import { formatModelDiscoveryError } from './modelDiscoveryError';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

test.each([
  ['plain text from the server', 'plain text from the server'],
  [{ error: 'Access denied for this key' }, 'Access denied for this key'],
  [{ detail: 'Model list is disabled' }, 'Model list is disabled'],
])('keeps HTTP status alongside the server error: %j', (data, expected) => {
  const message = formatModelDiscoveryError({ status: 403, statusText: 'Forbidden', data });
  expect(message).toBe(`HTTP 403 Forbidden\n${expected}`);
});

test('keeps a received HTTP status when the response body could not be read', () => {
  expect(
    formatModelDiscoveryError({
      status: 502,
      statusText: 'Bad Gateway',
      data: null,
      error: 'net::ERR_CONNECTION_RESET',
    }),
  ).toBe('HTTP 502 Bad Gateway\nnet::ERR_CONNECTION_RESET');
});

test('preserves an unknown transport error without inventing an HTTP status', () => {
  expect(
    formatModelDiscoveryError({
      status: 0,
      statusText: 'net::ERR_PROXY_CONNECTION_FAILED',
      data: null,
    }),
  ).toBe('modelDiscoveryNoHttpResponse\nnet::ERR_PROXY_CONNECTION_FAILED');
});
