// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import { resolveStartupLanguage } from './startupLanguage';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
test('a stalled locale bridge falls back to bundled copy without a fatal five-second initialization timeout', async () => {
  vi.useFakeTimers();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');
  const language = resolveStartupLanguage(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(1000);
  await expect(language).resolves.toBe('zh');
  expect(vi.getTimerCount()).toBe(0);
});
test('uses the actual locale when available and handles bridge errors locally', async () => {
  await expect(resolveStartupLanguage(async () => 'zh-TW')).resolves.toBe('zh');
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  await expect(
    resolveStartupLanguage(async () => {
      throw new Error('locale unavailable');
    }),
  ).resolves.toBe('en');
});
