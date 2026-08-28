// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SubagentTokenUsage from './SubagentTokenUsage';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SubagentTokenUsage', () => {
  it('shows a waiting animation while token usage is loading', () => {
    i18nService.setLanguage('zh', { persist: false });

    render(<SubagentTokenUsage isLoading />);

    const loadingStatus = screen.getByRole('status', { name: /查询中/ });
    expect(loadingStatus.textContent).toContain('查询中...');
    expect(loadingStatus.textContent).toContain('正在读取会话记录');
    expect(loadingStatus.querySelector('.animate-spin')).toBeTruthy();
    expect(loadingStatus.querySelector('.querying-indicator-text')).toBeTruthy();
    expect(loadingStatus.querySelectorAll('.querying-indicator-dot')).toHaveLength(3);
  });

  it('describes the current query work without showing a percentage', () => {
    i18nService.setLanguage('zh', { persist: false });
    vi.useFakeTimers();
    render(<SubagentTokenUsage isLoading />);

    expect(screen.getByText('正在读取会话记录')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_400));
    expect(screen.getByText('正在汇总模型请求')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_800));
    expect(screen.getByText('正在计算 Token 用量')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });
});
