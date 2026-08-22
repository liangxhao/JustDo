import { describe, expect, test, vi } from 'vitest';

import { setLanguage } from '../../core/i18n';
import { formatAnswer } from './interactions';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));

describe('AskUserQuestion interaction history formatting', () => {
  test.each([
    ['zh' as const, '已跳过'],
    ['en' as const, 'Skipped'],
  ])('formats skipped answers in %s', (language, expected) => {
    setLanguage(language);

    expect(formatAnswer({ selected: [], skipped: true })).toBe(expected);
  });
});
