// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SubtaskListPanel from './SubtaskListPanel';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const installElectron = (
  getSubTaskStatus: ReturnType<typeof vi.fn>,
  getSubTaskDetails: ReturnType<typeof vi.fn> = vi.fn(),
  onSubtasksChanged: ReturnType<typeof vi.fn> = vi.fn(() => vi.fn()),
) => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { getSubTaskStatus, getSubTaskDetails, onSubtasksChanged } },
  });
};

describe('SubtaskListPanel', () => {
  it('renders one compact row per subtask with the raw status value', async () => {
    i18nService.setLanguage('zh', { persist: false });
    installElectron(
      vi.fn().mockResolvedValue({
        success: true,
        subagents: [
          {
            id: 'finished',
            taskName: 'finished',
            sessionKey: 'agent:main:subagent:finished',
            label: '整理结论',
            labelSource: 'label',
            status: 'done',
            updatedAt: 300,
            terminalSummary: '已提交报告',
          },
          {
            id: 'running',
            taskName: 'running',
            sessionKey: 'agent:main:subagent:running',
            label: '检索资料',
            labelSource: 'label',
            status: 'running',
            updatedAt: 200,
            startedAt: Date.now() - 2_000,
            lastActivity: '正在阅读源码',
            lastToolName: 'read',
            toolUseCount: 3,
          },
        ],
      }),
    );

    render(
      <SubtaskListPanel sessionId="parent-1" isOpen onClose={vi.fn()} onOpenSubtask={vi.fn()} />,
    );

    expect(await screen.findByRole('complementary', { name: '子任务列表' })).toBeTruthy();
    expect(await screen.findByText('检索资料')).toBeTruthy();
    expect(screen.getByText('进行中 1')).toBeTruthy();
    const finishedToggle = screen.getByRole('button', { name: '已结束 1' });
    expect(finishedToggle.getAttribute('aria-expanded')).toBe('true');
    const runningRow = screen.getByRole('button', { name: '检索资料' }).parentElement;
    expect(runningRow?.children).toHaveLength(4);
    expect(runningRow?.children[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(runningRow?.children[1]?.textContent).toBe('检索资料');
    expect(runningRow?.children[2]?.textContent).toBe('running');
    expect(runningRow?.children[3]?.getAttribute('aria-label')).toBe('查看详情');
    expect(screen.queryByText('运行中')).toBeNull();
    expect(screen.queryByText('正在阅读源码')).toBeNull();
    expect(screen.queryByText('read')).toBeNull();
    expect(screen.queryByText('3 次工具调用')).toBeNull();
    expect(screen.getByText('整理结论')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.queryByText('已提交报告')).toBeNull();

    fireEvent.click(finishedToggle);
    expect(finishedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('整理结论')).toBeNull();
  });

  it('shows lifetime model-request usage in the subtask detail dialog', async () => {
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
    installElectron(
      vi.fn().mockResolvedValue({
        success: true,
        subagents: [
          {
            id: 'child-1',
            taskName: 'child-1',
            sessionKey: 'agent:main:subagent:child-1',
            label: 'Research',
            labelSource: 'taskName',
            status: 'running',
            totalTokens: 999,
          },
        ],
      }),
      getSubTaskDetails,
    );

    render(<SubtaskListPanel sessionId="parent-1" isOpen onClose={vi.fn()} />);
    const detailTrigger = await screen.findByRole('button', { name: '查看详情' });
    fireEvent.click(detailTrigger);

    await waitFor(() =>
      expect(getSubTaskDetails).toHaveBeenCalledWith('agent:main:subagent:child-1'),
    );
    expect(await screen.findByText('154')).toBeTruthy();
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

  it('keeps the last complete usage when a terminal detail refresh temporarily fails', async () => {
    i18nService.setLanguage('zh', { persist: false });
    const runningSubtask = {
      id: 'child-1',
      taskName: 'child-1',
      sessionKey: 'agent:main:subagent:child-1',
      label: 'Research',
      labelSource: 'taskName',
      status: 'running',
    };
    const getSubTaskStatus = vi
      .fn()
      .mockResolvedValueOnce({ success: true, subagents: [runningSubtask] })
      .mockResolvedValue({
        success: true,
        subagents: [{ ...runningSubtask, status: 'done' }],
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
    let taskChanged: ((event: { sessionId?: string }) => void) | undefined;
    const onSubtasksChanged = vi.fn((callback: typeof taskChanged) => {
      taskChanged = callback;
      return vi.fn();
    });
    installElectron(getSubTaskStatus, getSubTaskDetails, onSubtasksChanged);

    render(<SubtaskListPanel sessionId="parent-1" isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));
    expect(await screen.findByText('154')).toBeTruthy();

    act(() => taskChanged?.({ sessionId: 'parent-1' }));
    await waitFor(() => expect(getSubTaskDetails).toHaveBeenCalledTimes(2));
    expect(screen.getByText('154')).toBeTruthy();
  });

  it('keeps the detail query animation active while a terminal request retries', async () => {
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
    installElectron(
      vi.fn().mockResolvedValue({
        success: true,
        subagents: [
          {
            id: 'child-1',
            taskName: 'child-1',
            sessionKey: 'agent:main:subagent:child-1',
            label: 'Research',
            labelSource: 'taskName',
            status: 'done',
          },
        ],
      }),
      getSubTaskDetails,
    );

    render(<SubtaskListPanel sessionId="parent-1" isOpen onClose={vi.fn()} />);
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

  it('loads eagerly while collapsed so the header can show active task count', async () => {
    i18nService.setLanguage('en', { persist: false });
    const getSubTaskStatus = vi.fn().mockResolvedValue({
      success: true,
      subagents: [
        {
          id: 'child-1',
          taskName: 'child-1',
          sessionKey: 'agent:main:subagent:child-1',
          label: 'Research',
          labelSource: 'label',
          status: 'running',
        },
      ],
    });
    const onSubtasksChange = vi.fn();
    installElectron(getSubTaskStatus);

    render(
      <SubtaskListPanel
        sessionId="parent-1"
        isOpen={false}
        onClose={vi.fn()}
        onSubtasksChange={onSubtasksChange}
      />,
    );

    await waitFor(() => expect(getSubTaskStatus).toHaveBeenCalledWith('parent-1'));
    await waitFor(() =>
      expect(onSubtasksChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: 'child-1', status: 'running' }),
      ]),
    );
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('bypasses the Main-process cache when the user requests a refresh', async () => {
    i18nService.setLanguage('en', { persist: false });
    const getSubTaskStatus = vi.fn().mockResolvedValue({ success: true, subagents: [] });
    installElectron(getSubTaskStatus);

    render(<SubtaskListPanel sessionId="parent-1" isOpen onClose={vi.fn()} />);
    await waitFor(() => expect(getSubTaskStatus).toHaveBeenCalledWith('parent-1'));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh subtasks' }));

    await waitFor(() => expect(getSubTaskStatus).toHaveBeenCalledWith('parent-1', true));
  });

  it('refreshes the matching session immediately when OpenClaw publishes a task event', async () => {
    i18nService.setLanguage('en', { persist: false });
    let resolveInitialStatus:
      ((value: { success: true; subagents: Array<Record<string, unknown>> }) => void) | undefined;
    const initialStatus = new Promise<{
      success: true;
      subagents: Array<Record<string, unknown>>;
    }>(resolve => {
      resolveInitialStatus = resolve;
    });
    const getSubTaskStatus = vi
      .fn()
      .mockReturnValueOnce(initialStatus)
      .mockResolvedValueOnce({
        success: true,
        subagents: [
          {
            id: 'child-1',
            taskName: 'child-1',
            sessionKey: 'agent:main:subagent:child-1',
            label: 'Event child',
            labelSource: 'label',
            status: 'running',
          },
        ],
      });
    let taskChanged: ((event: { sessionId?: string }) => void) | undefined;
    const onSubtasksChanged = vi.fn((callback: typeof taskChanged) => {
      taskChanged = callback;
      return vi.fn();
    });
    const onSubtasksChange = vi.fn();
    installElectron(getSubTaskStatus, vi.fn(), onSubtasksChanged);

    render(
      <SubtaskListPanel
        sessionId="parent-1"
        isOpen={false}
        onClose={vi.fn()}
        onSubtasksChange={onSubtasksChange}
      />,
    );
    await waitFor(() => expect(getSubTaskStatus).toHaveBeenCalledTimes(1));

    act(() => taskChanged?.({ sessionId: 'another-parent' }));
    expect(getSubTaskStatus).toHaveBeenCalledTimes(1);
    act(() => taskChanged?.({ sessionId: 'parent-1' }));
    expect(getSubTaskStatus).toHaveBeenCalledTimes(1);
    resolveInitialStatus?.({ success: true, subagents: [] });

    await waitFor(() => expect(getSubTaskStatus).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(onSubtasksChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ id: 'child-1', status: 'running' }),
      ]),
    );
  });

  it('closes details after an authoritative refresh removes the selected task', async () => {
    i18nService.setLanguage('en', { persist: false });
    const getSubTaskStatus = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        subagents: [
          {
            id: 'child-1',
            taskName: 'child-1',
            sessionKey: 'agent:main:subagent:child-1',
            label: 'Removed child',
            labelSource: 'label',
            status: 'running',
          },
        ],
      })
      .mockResolvedValueOnce({ success: true, subagents: [] });
    let taskChanged: ((event: { sessionId?: string }) => void) | undefined;
    const onSubtasksChanged = vi.fn((callback: typeof taskChanged) => {
      taskChanged = callback;
      return vi.fn();
    });
    installElectron(getSubTaskStatus, vi.fn(), onSubtasksChanged);

    render(<SubtaskListPanel sessionId="parent-1" isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    expect(screen.getByRole('dialog', { name: 'Removed child' })).toBeTruthy();

    act(() => taskChanged?.({ sessionId: 'parent-1' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not queue another refresh after unmount and removes the task listener', async () => {
    i18nService.setLanguage('en', { persist: false });
    let resolveInitialStatus:
      ((value: { success: true; subagents: Array<Record<string, unknown>> }) => void) | undefined;
    const initialStatus = new Promise<{
      success: true;
      subagents: Array<Record<string, unknown>>;
    }>(resolve => {
      resolveInitialStatus = resolve;
    });
    const getSubTaskStatus = vi.fn().mockReturnValue(initialStatus);
    let taskChanged: ((event: { sessionId?: string }) => void) | undefined;
    const unsubscribe = vi.fn();
    const onSubtasksChanged = vi.fn((callback: typeof taskChanged) => {
      taskChanged = callback;
      return unsubscribe;
    });
    installElectron(getSubTaskStatus, vi.fn(), onSubtasksChanged);

    const { unmount } = render(
      <SubtaskListPanel sessionId="parent-1" isOpen={false} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(getSubTaskStatus).toHaveBeenCalledTimes(1));
    act(() => taskChanged?.({ sessionId: 'parent-1' }));
    unmount();

    await act(async () => {
      resolveInitialStatus?.({ success: true, subagents: [] });
      await Promise.resolve();
    });

    expect(getSubTaskStatus).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('starts the new session refresh without accepting the previous session response', async () => {
    i18nService.setLanguage('en', { persist: false });
    let resolveOldRequest:
      ((value: { success: true; subagents: Array<Record<string, unknown>> }) => void) | undefined;
    const oldRequest = new Promise<{
      success: true;
      subagents: Array<Record<string, unknown>>;
    }>(resolve => {
      resolveOldRequest = resolve;
    });
    const getSubTaskStatus = vi.fn((sessionId: string) => {
      if (sessionId === 'parent-1') return oldRequest;
      return Promise.resolve({
        success: true,
        subagents: [
          {
            id: 'child-2',
            taskName: 'child-2',
            sessionKey: 'agent:main:subagent:child-2',
            label: 'New session child',
            labelSource: 'taskName',
            status: 'done',
          },
        ],
      });
    });
    installElectron(getSubTaskStatus);

    const { rerender } = render(<SubtaskListPanel sessionId="parent-1" isOpen onClose={vi.fn()} />);
    await waitFor(() => expect(getSubTaskStatus).toHaveBeenCalledWith('parent-1'));

    rerender(<SubtaskListPanel sessionId="parent-2" isOpen onClose={vi.fn()} />);
    await waitFor(() => expect(getSubTaskStatus).toHaveBeenCalledWith('parent-2'));
    expect(
      (await screen.findByRole('button', { name: 'Finished 1' })).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(await screen.findByText('New session child')).toBeTruthy();

    resolveOldRequest?.({
      success: true,
      subagents: [
        {
          id: 'child-1',
          taskName: 'child-1',
          sessionKey: 'agent:main:subagent:child-1',
          label: 'Old session child',
          labelSource: 'taskName',
          status: 'done',
        },
      ],
    });
    await act(async () => Promise.resolve());

    expect(screen.queryByText('Old session child')).toBeNull();
    expect(screen.getByText('New session child')).toBeTruthy();
  });
});
