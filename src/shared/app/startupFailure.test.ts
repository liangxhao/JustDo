import { expect, test } from 'vitest';

import { captureStartupFailure, StartupFailureSource, startupFailureText } from './startupFailure';

test('retains exception codes, stack, nested cause and actual context while masking credentials', () => {
  const cause = Object.assign(new Error('permission denied token=private-token'), {
    code: 'EACCES',
  });
  const error = Object.assign(new Error('database unavailable'), { cause });
  const failure = captureStartupFailure(StartupFailureSource.Main, error, {
    activity: 'database',
    logPath: 'C:\\用户 数据\\logs\\main.log',
  });
  expect(failure.error.stack).toContain('database unavailable');
  expect(failure.error.cause?.code).toBe('EACCES');
  const text = startupFailureText(failure);
  expect(text).toContain('用户 数据');
  expect(text).toContain('database');
  expect(text).toContain('Caused by:');
  expect(text).not.toContain('private-token');
});

test('handles cycles, throwing getters, non-Error rejections and oversized fields', () => {
  const error = {
    message: 'x'.repeat(10000),
    cause: undefined as unknown,
    get stack() {
      throw new Error('unreadable');
    },
  };
  error.cause = error;
  const detail = captureStartupFailure(StartupFailureSource.Renderer, error).error;
  expect(detail.message.length).toBe(4000);
  expect(detail.stack).toBeUndefined();
  expect(detail.cause).toBeUndefined();
  expect(
    captureStartupFailure(StartupFailureSource.Renderer, 'chunk unavailable').error.message,
  ).toBe('chunk unavailable');
  expect(captureStartupFailure(StartupFailureSource.Renderer, null).error.message).toBe(
    'Unknown error',
  );
});
