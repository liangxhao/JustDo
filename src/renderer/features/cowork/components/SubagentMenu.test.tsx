// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SubagentMenu from './SubagentMenu';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SubagentMenu', () => {
  it('shows lifetime model-request usage instead of the session context token snapshot', async () => {
    i18nService.setLanguage('zh', { persist: false });
    const getSubTaskDetails = vi.fn().mockResolvedValue({
      success: true,
      stats: {
        summary: null,
        messageCount: 1,
        userMessageCount: 0,
        assistantMessageCount: 1,
        toolCallCount: 0,
        models: ['openai/gpt-5'],
        tokenUsage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4 },
        totalTokens: 154,
        hasTokenUsage: true,
      },
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          getSubTaskStatus: vi.fn().mockResolvedValue({
            success: true,
            subagents: [
              {
                id: 'child-1',
                sessionKey: 'agent:main:subagent:child-1',
                label: 'Research',
                labelSource: 'taskName',
                status: 'done',
                totalTokens: 999,
              },
            ],
          }),
          getSubTaskDetails,
        },
      },
    });

    render(<SubagentMenu sessionId="parent-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Subagent' }));
    const detailTrigger = await screen.findByRole('button', { name: '查看详情' });
    fireEvent.click(detailTrigger);

    await waitFor(() =>
      expect(getSubTaskDetails).toHaveBeenCalledWith('agent:main:subagent:child-1'),
    );
    expect(await screen.findByText('输入 Token')).toBeTruthy();
    expect(screen.getByText('总 Token')).toBeTruthy();
    expect(screen.getByText('154')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
    expect(screen.getByText('20')).toBeTruthy();
    expect(screen.getByText('30')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    const tokenScopeNote = screen.getByText(
      '仅统计普通会话，不含上下文压缩、权限审批 Review 等其他模型请求。',
    );
    expect(tokenScopeNote.className).toContain('text-right');
    expect(tokenScopeNote.className).toContain('text-[10px]');
    expect(screen.queryByText('999')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Research' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭' }));

    detailTrigger.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Research' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(detailTrigger));
  });

  it('keeps the last complete usage when the final status refresh temporarily fails', async () => {
    i18nService.setLanguage('zh', { persist: false });
    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(window, 'setInterval').mockImplementation(handler => {
      intervalCallbacks.push(handler as () => void);
      return intervalCallbacks.length as never;
    });
    const runningSubagent = {
      id: 'child-1',
      sessionKey: 'agent:main:subagent:child-1',
      label: 'Research',
      labelSource: 'taskName',
      status: 'running',
    };
    const getSubTaskStatus = vi
      .fn()
      .mockResolvedValueOnce({ success: true, subagents: [runningSubagent] })
      .mockResolvedValue({
        success: true,
        subagents: [{ ...runningSubagent, status: 'done' }],
      });
    const getSubTaskDetails = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stats: {
          summary: null,
          messageCount: 1,
          userMessageCount: 0,
          assistantMessageCount: 1,
          toolCallCount: 0,
          models: ['openai/gpt-5'],
          tokenUsage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4 },
          totalTokens: 154,
          hasTokenUsage: true,
        },
      })
      .mockResolvedValue({ success: false, error: 'temporarily unavailable' });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { cowork: { getSubTaskStatus, getSubTaskDetails } },
    });

    render(<SubagentMenu sessionId="parent-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Subagent' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));
    expect(await screen.findByText('154')).toBeTruthy();

    await act(async () => intervalCallbacks[0]?.());
    await waitFor(() => expect(getSubTaskDetails).toHaveBeenCalledTimes(2));
    expect(screen.getByText('154')).toBeTruthy();
  });

  it('keeps the query animation active while an incomplete detail request retries', async () => {
    i18nService.setLanguage('zh', { persist: false });
    vi.useFakeTimers();
    const getSubTaskDetails = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'usage cache is refreshing' })
      .mockResolvedValueOnce({
        success: true,
        stats: {
          summary: null,
          messageCount: 1,
          userMessageCount: 0,
          assistantMessageCount: 1,
          toolCallCount: 0,
          models: ['openai/gpt-5'],
          tokenUsage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4 },
          totalTokens: 154,
          hasTokenUsage: true,
        },
      });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          getSubTaskStatus: vi.fn().mockResolvedValue({
            success: true,
            subagents: [
              {
                id: 'child-1',
                sessionKey: 'agent:main:subagent:child-1',
                label: 'Research',
                labelSource: 'taskName',
                status: 'done',
              },
            ],
          }),
          getSubTaskDetails,
        },
      },
    });

    render(<SubagentMenu sessionId="parent-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Subagent' }));
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    await act(async () => Promise.resolve());

    expect(getSubTaskDetails).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status', { name: /查询中/ })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });

    expect(getSubTaskDetails).toHaveBeenCalledTimes(2);
    expect(screen.getByText('154')).toBeTruthy();
    expect(screen.queryByRole('status', { name: /查询中/ })).toBeNull();
  });
});
