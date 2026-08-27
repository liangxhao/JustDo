// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { i18nService } from '@/services/i18n';

import SubagentTokenUsage from './SubagentTokenUsage';

afterEach(cleanup);

describe('SubagentTokenUsage', () => {
  it('shows a waiting animation while token usage is loading', () => {
    i18nService.setLanguage('zh', { persist: false });

    render(<SubagentTokenUsage isLoading />);

    const loadingStatus = screen.getByRole('status');
    expect(loadingStatus.textContent).toContain('加载中');
    expect(loadingStatus.querySelector('.animate-spin')).toBeTruthy();
  });
});
