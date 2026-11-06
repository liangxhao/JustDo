import { expect, test } from 'vitest';

import { buildOpenAIJsonRequestHeaders, OPENAI_REQUEST_USER_AGENT } from './modelRequestHeaders';

test('builds OpenAI-compatible JSON request headers using the UTF-8 body length', () => {
  const body = JSON.stringify({ message: '你好' });

  expect(buildOpenAIJsonRequestHeaders(body, 'secret-key')).toEqual({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    'User-Agent': OPENAI_REQUEST_USER_AGENT,
    Authorization: 'Bearer secret-key',
  });
});

test('omits authorization when the API key is empty', () => {
  expect(buildOpenAIJsonRequestHeaders('{}')).not.toHaveProperty('Authorization');
});

test('omits the restricted content-length header for Chromium-backed requests', () => {
  expect(
    buildOpenAIJsonRequestHeaders('{}', 'secret-key', { includeContentLength: false }),
  ).not.toHaveProperty('Content-Length');
});
