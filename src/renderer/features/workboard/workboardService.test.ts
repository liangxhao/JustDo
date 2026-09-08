import { afterEach, describe, expect, it } from 'vitest';

import { i18nService } from '@/services/i18n';

import { workboardErrorMessage } from './workboardService';

describe('workboardErrorMessage', () => {
  afterEach(() => {
    i18nService.setLanguage('zh');
  });

  it('describes a disconnected gateway as an automatically recoverable restart', () => {
    i18nService.setLanguage('zh');

    expect(workboardErrorMessage('Gateway client not connected')).toBe(
      'AI 引擎正在重启；连接恢复后将自动刷新。',
    );
  });

  it('preserves operation-specific errors', () => {
    expect(workboardErrorMessage('Card is archived')).toBe('Card is archived');
  });
});
