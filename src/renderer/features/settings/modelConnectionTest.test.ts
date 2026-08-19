import { afterEach, expect, test, vi } from 'vitest';

import {
  buildModelConnectionTestRequestBody,
  MODEL_CONNECTION_TEST_REQUEST_PURPOSE,
  MODEL_CONNECTION_TEST_TIMEOUT_MS,
  selectModelsForConnectionTest,
  withModelConnectionTestTimeout,
} from './modelConnectionTest';

afterEach(() => {
  vi.useRealTimers();
});

test('builds a built-in model connection test request with purpose metadata', () => {
  const requestBody = JSON.parse(buildModelConnectionTestRequestBody('test-model', 64, true));

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

test('omits metadata from non-built-in model connection test requests', () => {
  const requestBody = JSON.parse(buildModelConnectionTestRequestBody('test-model', 64));

  expect(requestBody).toEqual({
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: 64,
  });
});

test('selects one model when a model-specific connection test is requested', () => {
  const models = [{ id: 'model-a' }, { id: 'model-b' }];

  expect(selectModelsForConnectionTest(models, 'model-b')).toEqual([{ id: 'model-b' }]);
  expect(selectModelsForConnectionTest(models)).toEqual(models);
});

test('cancels and rejects a model connection test after 60 seconds', async () => {
  vi.useFakeTimers();
  expect(MODEL_CONNECTION_TEST_TIMEOUT_MS).toBe(60_000);
  const cancel = vi.fn();
  const request = new Promise<never>(() => undefined);

  const result = withModelConnectionTestTimeout(request, cancel, 'Connection timed out');
  const rejection = expect(result).rejects.toThrow('Connection timed out');
  await vi.advanceTimersByTimeAsync(MODEL_CONNECTION_TEST_TIMEOUT_MS);

  await rejection;
  expect(cancel).toHaveBeenCalledOnce();
});

test('clears the timeout after a model connection test finishes', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();

  await expect(
    withModelConnectionTestTimeout(Promise.resolve('ok'), cancel, 'Connection timed out'),
  ).resolves.toBe('ok');
  await vi.advanceTimersByTimeAsync(MODEL_CONNECTION_TEST_TIMEOUT_MS);

  expect(cancel).not.toHaveBeenCalled();
});
