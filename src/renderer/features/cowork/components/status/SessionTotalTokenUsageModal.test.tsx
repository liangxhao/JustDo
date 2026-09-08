// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coworkService } from '@/features/cowork/coworkService';
import { i18nService } from '@/services/i18n';

import SessionTotalTokenUsageModal from './SessionTotalTokenUsageModal';

const stats = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  summary: null,
  messageCount: 0,
  userMessageCount: 0,
  assistantMessageCount: 0,
  toolCallCount: 0,
  models: [],
  tokenUsage: { input, output, cacheRead, cacheWrite },
  totalTokens: input + output + cacheRead + cacheWrite,
  hasTokenUsage: true,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SessionTotalTokenUsageModal', () => {
  it('keeps aggregation feedback animated while discovering subagents', () => {
    i18nService.setLanguage('zh', { persist: false });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          listSubTaskDescendants: vi.fn().mockReturnValue(new Promise(() => undefined)),
          getSubTaskDetails: vi.fn(),
        },
      },
    });
    vi.spyOn(coworkService, 'getSessionDetails').mockReturnValue(new Promise(() => undefined));

    render(<SessionTotalTokenUsageModal sessionId="parent-1" onClose={vi.fn()} />);

    const loadingStatus = screen.getByRole('status');
    const progressbar = screen.getByRole('progressbar', { name: '总体 Token 查询进度' });
    expect(loadingStatus.querySelector('.querying-spinner')).toBeTruthy();
    expect(loadingStatus.querySelector('.querying-indicator-text')).toBeTruthy();
    expect(loadingStatus.querySelectorAll('.querying-indicator-dot')).toHaveLength(3);
    expect(
      progressbar.firstElementChild?.classList.contains('session-token-progress-indeterminate'),
    ).toBe(true);
  });

  it('shows real per-session progress and aggregates the main session with all subagents', async () => {
    i18nService.setLanguage('zh', { persist: false });
    const firstDetails =
      deferred<Awaited<ReturnType<typeof window.electron.cowork.getSubTaskDetails>>>();
    const secondDetails =
      deferred<Awaited<ReturnType<typeof window.electron.cowork.getSubTaskDetails>>>();
    const getSubTaskDetails = vi
      .fn()
      .mockReturnValueOnce(firstDetails.promise)
      .mockReturnValueOnce(secondDetails.promise);
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          listSubTaskDescendants: vi.fn().mockResolvedValue({
            success: true,
            subagents: [
              {
                id: 'child-1',
                sessionKey: 'agent:main:subagent:child-1',
                label: '第一个任务',
                labelSource: 'task',
                status: 'done',
              },
              {
                id: 'child-2',
                sessionKey: 'agent:main:subagent:child-2',
                label: '第二个任务',
                labelSource: 'task',
                status: 'done',
              },
            ],
          }),
          getSubTaskDetails,
        },
      },
    });
    vi.spyOn(coworkService, 'getSessionDetails').mockResolvedValue({
      session: null,
      stats: stats(100, 20, 30, 4),
    });
    const onClose = vi.fn();

    render(
      <StrictMode>
        <SessionTotalTokenUsageModal sessionId="parent-1" onClose={onClose} />
      </StrictMode>,
    );

    const progressbar = await screen.findByRole('progressbar', {
      name: '总体 Token 查询进度',
    });
    const spinner = screen.getByRole('status').querySelector('.querying-spinner');
    expect(spinner).toBeTruthy();
    expect(spinner?.classList.contains('animate-spin')).toBe(false);
    await waitFor(() => expect(getSubTaskDetails).toHaveBeenCalledTimes(1));
    expect(screen.getByText('已完成 1 / 3 个会话')).toBeTruthy();
    expect(screen.getByText('正在统计 Subagent 1 / 2：第一个任务')).toBeTruthy();
    expect(progressbar.getAttribute('aria-valuenow')).toBe('1');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('3');
    expect((progressbar.firstElementChild as HTMLElement).style.width).toBe('33%');
    expect((progressbar.firstElementChild as HTMLElement).style.transform).toBe('none');
    expect(
      progressbar.firstElementChild?.classList.contains('session-token-progress-indeterminate'),
    ).toBe(false);
    const backdrop = screen.getByRole('dialog').parentElement?.parentElement;
    expect(backdrop).toBeTruthy();
    fireEvent.mouseDown(backdrop!);
    fireEvent.click(backdrop!);
    expect(onClose).not.toHaveBeenCalled();

    firstDetails.resolve({ success: true, stats: stats(10, 2, 3, 1) });
    await waitFor(() => expect(getSubTaskDetails).toHaveBeenCalledTimes(2));
    expect(screen.getByText('已完成 2 / 3 个会话')).toBeTruthy();
    expect(screen.getByText('正在统计 Subagent 2 / 2：第二个任务')).toBeTruthy();
    expect((progressbar.firstElementChild as HTMLElement).style.width).toBe('67%');

    secondDetails.resolve({ success: true, stats: stats(20, 4, 6, 0) });
    expect(await screen.findByText('200')).toBeTruthy();
    expect(screen.getByText('154')).toBeTruthy();
    expect(screen.getByText('46')).toBeTruthy();
    expect(getSubTaskDetails.mock.calls.map(([sessionKey]) => sessionKey)).toEqual([
      'agent:main:subagent:child-1',
      'agent:main:subagent:child-2',
    ]);
    expect(window.electron.cowork.listSubTaskDescendants).toHaveBeenCalledTimes(1);
  });

  it('finishes with the main-session total when there are no subagents', async () => {
    i18nService.setLanguage('zh', { persist: false });
    const getSubTaskDetails = vi.fn();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          listSubTaskDescendants: vi.fn().mockResolvedValue({ success: true, subagents: [] }),
          getSubTaskDetails,
        },
      },
    });
    vi.spyOn(coworkService, 'getSessionDetails').mockResolvedValue({
      session: null,
      stats: stats(40, 8, 12, 2),
    });

    render(<SessionTotalTokenUsageModal sessionId="parent-1" onClose={vi.fn()} />);

    expect(await screen.findAllByText('62')).toHaveLength(2);
    expect(screen.getByText('主会话 + 所有 Subagent')).toBeTruthy();
    expect(getSubTaskDetails).not.toHaveBeenCalled();
  });

  it('retries failed subagents once, skips them, and lists copyable Session IDs', async () => {
    i18nService.setLanguage('zh', { persist: false });
    const getSubTaskDetails = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'temporarily unavailable' })
      .mockResolvedValueOnce({ success: false, error: 'still unavailable' })
      .mockResolvedValueOnce({ success: true, stats: stats(5, 2, 1, 0) });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          listSubTaskDescendants: vi.fn().mockResolvedValue({
            success: true,
            subagents: [
              {
                id: 'child-1',
                sessionKey: 'agent:main:subagent:child-1',
                sessionId: 'failed-session-id',
                label: '失败任务',
                labelSource: 'task',
                status: 'done',
              },
              {
                id: 'child-2',
                sessionKey: 'agent:main:subagent:child-2',
                sessionId: 'successful-session-id',
                label: '成功任务',
                labelSource: 'task',
                status: 'done',
              },
            ],
          }),
          getSubTaskDetails,
        },
      },
    });
    vi.spyOn(coworkService, 'getSessionDetails').mockResolvedValue({
      session: null,
      stats: stats(10, 4, 2, 1),
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<SessionTotalTokenUsageModal sessionId="parent-1" onClose={vi.fn()} />);

    expect(await screen.findByText('查询失败的 Session ID')).toBeTruthy();
    expect(screen.getByText('failed-session-id')).toBeTruthy();
    expect(screen.getByText('25')).toBeTruthy();
    expect(screen.getByText(/已跳过 1 个重试后仍查询失败的会话/)).toBeTruthy();
    expect(getSubTaskDetails.mock.calls.map(([sessionKey]) => sessionKey)).toEqual([
      'agent:main:subagent:child-1',
      'agent:main:subagent:child-1',
      'agent:main:subagent:child-2',
    ]);

    fireEvent.click(screen.getByRole('button', { name: '复制 Session ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('failed-session-id'));
  });

  it('retries a failed main-session query and reports its Gateway Session ID', async () => {
    i18nService.setLanguage('zh', { persist: false });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: {
        cowork: {
          listSubTaskDescendants: vi.fn().mockResolvedValue({ success: true, subagents: [] }),
          getSubTaskDetails: vi.fn(),
        },
      },
    });
    const getSessionDetails = vi
      .spyOn(coworkService, 'getSessionDetails')
      .mockRejectedValue(new Error('offline'));

    render(
      <SessionTotalTokenUsageModal
        sessionId="parent-1"
        gatewaySessionId="main-gateway-session-id"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('main-gateway-session-id')).toBeTruthy();
    expect(getSessionDetails).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/已跳过 1 个重试后仍查询失败的会话/)).toBeTruthy();
  });
});
