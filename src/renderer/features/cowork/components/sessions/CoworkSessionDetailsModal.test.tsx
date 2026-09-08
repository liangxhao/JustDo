// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';

import CoworkSessionDetailsModal from './CoworkSessionDetailsModal';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CoworkSessionDetailsModal', () => {
  it('shows a waiting animation while details are loading', () => {
    i18nService.setLanguage('zh', { persist: false });
    vi.spyOn(coworkService, 'getSessionDetails').mockReturnValue(new Promise(() => undefined));

    render(
      <CoworkSessionDetailsModal
        sessionSummary={{
          id: 'local-session-id',
          title: 'Session title',
          status: 'completed',
          pinned: false,
          createdAt: 1_000,
          updatedAt: 2_000,
        }}
        groups={[]}
        isRuntimeRunning={false}
        onClose={vi.fn()}
      />,
    );

    const loadingStatus = screen.getByRole('status');
    expect(loadingStatus.textContent).toContain('查询中...');
    expect(loadingStatus.querySelector('.querying-spinner')).toBeTruthy();
  });

  it('renders authoritative details and copies the Gateway Session ID', async () => {
    i18nService.setLanguage('zh', { persist: false });
    vi.spyOn(coworkService, 'getSessionDetails').mockResolvedValue({
      session: {
        id: 'local-session-id',
        title: 'Session title',
        status: 'completed',
        pinned: false,
        cwd: 'E:\\workspace',
        executionMode: 'local',
        permissionMode: 'full',
        activeSkillIds: [],
        agentId: 'main',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      gatewaySessionId: 'gateway-session-id',
      stats: {
        summary: 'First prompt',
        messageCount: 7,
        userMessageCount: 2,
        assistantMessageCount: 5,
        toolCallCount: 3,
        models: ['openai/gpt-5'],
        tokenUsage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4 },
        totalTokens: 154,
        hasTokenUsage: true,
      },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <CoworkSessionDetailsModal
        sessionSummary={{
          id: 'local-session-id',
          title: 'Session title',
          status: 'completed',
          pinned: false,
          createdAt: 1_000,
          updatedAt: 2_000,
        }}
        groups={[]}
        isRuntimeRunning={false}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('gateway-session-id')).toBeTruthy();
    expect(screen.queryByText('local-session-id')).toBeNull();
    expect(screen.getByText('Session ID')).toBeTruthy();
    expect(screen.getByText('openai/gpt-5')).toBeTruthy();
    expect(screen.getByText('总 Token')).toBeTruthy();
    const aggregateTokensButton = screen.getByRole('button', { name: '汇总 Token' });
    expect(aggregateTokensButton).toBeTruthy();
    expect(aggregateTokensButton.getAttribute('title')).toBe(
      '统计主会话与所有 Subagent 当前 Session 实例的 Token 总量',
    );
    expect(screen.getByText('154')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
    const tokenScopeNote = screen.getByText(
      '统计当前 Session 实例的普通对话，不含压缩与审批 Review；总量可能不等于分项之和。',
    );
    expect(tokenScopeNote.className).toContain('text-right');
    expect(tokenScopeNote.className).toContain('text-[10px]');

    fireEvent.click(screen.getByRole('button', { name: '复制 Session ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('gateway-session-id'));
  });

  it('schedules an active refresh only after the previous request settles', async () => {
    i18nService.setLanguage('en', { persist: false });
    vi.useFakeTimers();
    let resolveDetails:
      | ((value: Awaited<ReturnType<typeof coworkService.getSessionDetails>>) => void)
      | undefined;
    const pendingDetails = new Promise<
      Awaited<ReturnType<typeof coworkService.getSessionDetails>>
    >(resolve => {
      resolveDetails = resolve;
    });
    const details = {
      session: {
        id: 'local-session-id',
        title: 'Session title',
        status: 'running' as const,
        pinned: false,
        cwd: 'E:\\workspace',
        executionMode: 'local' as const,
        permissionMode: 'full' as const,
        activeSkillIds: [],
        agentId: 'main',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
      stats: {
        summary: null,
        messageCount: 0,
        userMessageCount: 0,
        assistantMessageCount: 0,
        toolCallCount: 0,
        models: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        totalTokens: 0,
        hasTokenUsage: false,
      },
    };
    const getSessionDetails = vi
      .spyOn(coworkService, 'getSessionDetails')
      .mockReturnValueOnce(pendingDetails)
      .mockResolvedValue(details);

    render(
      <CoworkSessionDetailsModal
        sessionSummary={{
          id: 'local-session-id',
          title: 'Session title',
          status: 'running',
          pinned: false,
          createdAt: 1_000,
          updatedAt: 2_000,
        }}
        groups={[]}
        isRuntimeRunning
        onClose={vi.fn()}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(0);
      await Promise.resolve();
    });
    expect(getSessionDetails).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(getSessionDetails).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDetails?.(details);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });
    expect(getSessionDetails).toHaveBeenCalledTimes(2);
  });
});
