import { expect, test } from 'vitest';

import {
  buildModelConnectionTestRequestBody,
  MODEL_CONNECTION_TEST_REQUEST_PURPOSE,
} from './modelConnectionTest';

test('builds a model connection test request with purpose metadata', () => {
  const requestBody = JSON.parse(buildModelConnectionTestRequestBody('test-model', 64));

  expect(MODEL_CONNECTION_TEST_REQUEST_PURPOSE).toBe('connection_test');
  expect(requestBody).toEqual({
    model: 'test-model',
    metadata: {
      request_purpose: 'connection_test',
    },
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 64,
  });
});
