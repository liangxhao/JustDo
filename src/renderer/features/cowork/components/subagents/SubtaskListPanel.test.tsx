// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('shows completion and failed delivery as separate facts with the native summaries', async () => {
    i18nService.setLanguage('en', { persist: false });
    const task = {
      id: 'one',
      taskName: 'one',
      sessionKey: 'child',
      label: 'Research',
      labelSource: 'label',
      status: 'done',
      execution: { state: 'finished' },
      deliveryStatus: 'failed',
      progressSummary: 'Read three sources',
      terminalSummary: 'Report ready',
      error: 'Parent unavailable',
      diffStat: { files: 2, added: 10, removed: 3 },
    };
    installElectron(
      vi.fn().mockResolvedValue({ success: true, subagents: [task] }),
      vi.fn().mockResolvedValue({ success: true, subagent: task }),
    );
    render(<SubtaskListPanel sessionId="parent" isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Result delivery')).toBeTruthy();
    expect(dialog.getByText('Delivery failed')).toBeTruthy();
    expect(dialog.getByText('Report ready')).toBeTruthy();
    expect(dialog.getByText('Parent unavailable')).toBeTruthy();
    expect(dialog.getByText('2 files, +10 / −3 lines')).toBeTruthy();
    expect(dialog.queryByRole('button', { name: 'Deliver result again' })).toBeNull();
  });

  it('reveals finished history beyond the first fifty rows', async () => {
    i18nService.setLanguage('en', { persist: false });
    const tasks = Array.from({ length: 55 }, (_, index) => ({
      id: String(index),
      taskName: String(index),
      sessionKey: `child-${index}`,
      label: `Task ${index}`,
      labelSource: 'label',
      status: 'done',
      updatedAt: index,
    }));
    installElectron(vi.fn().mockResolvedValue({ success: true, subagents: tasks }));
    render(<SubtaskListPanel sessionId="parent" isOpen onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Task 54' });
    expect(screen.queryByRole('button', { name: 'Task 0' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load more finished tasks' }));
    expect(screen.getByRole('button', { name: 'Task 0' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more finished tasks' })).toBeNull();
  });

  it('navigates an explicitly loaded child and back without closing on root refresh', async () => {
    i18nService.setLanguage('en', { persist: false });
    const parent = {
      id: 'one',
      taskName: 'one',
      sessionKey: 'child',
      label: 'Research',
      labelSource: 'label',
      status: 'running',
    };
    const child = {
      ...parent,
      id: 'two',
      sessionKey: 'grandchild',
      label: 'Verify sources',
      parentTaskId: 'one',
      execution: { state: 'waiting', wait: { kind: 'approval' } },
    };
    let changed: ((event: { sessionId?: string }) => void) | undefined;
    const status = vi.fn().mockResolvedValue({ success: true, subagents: [parent] });
    installElectron(
      status,
      vi
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve({ success: true, subagent: key === 'grandchild' ? child : parent }),
        ),
      vi.fn(callback => {
        changed = callback;
        return vi.fn();
      }),
    );
    Object.assign(window.electron.cowork, {
      listSubTaskChildren: vi.fn().mockResolvedValue({ success: true, subagents: [child] }),
    });
    render(<SubtaskListPanel sessionId="root" isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    fireEvent.click(screen.getByRole('button', { name: 'View child tasks' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /^Verify sources\s*Waiting for approval$/ }),
    );
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBe(
      'subtask-details-title',
    );
    expect(
      within(screen.getByRole('dialog')).getByRole('heading', { name: 'Verify sources' }),
    ).toBeTruthy();
    act(() => changed?.({ sessionId: 'root' }));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to parent task: Research' }));
    expect(
      within(screen.getByRole('dialog')).getByRole('heading', { name: 'Research' }),
    ).toBeTruthy();
  });

  it('shows verified task details without treating unavailable usage as a task failure', async () => {
    i18nService.setLanguage('zh', { persist: false });
    const task = {
      id: 'child-1',
      taskName: 'child-1',
      sessionKey: 'agent:main:subagent:child-1',
      label: 'Research',
      labelSource: 'taskName',
      status: 'done',
    };
    installElectron(
      vi.fn().mockResolvedValue({ success: true, subagents: [task] }),
      vi.fn().mockResolvedValue({
        success: true,
        subagent: { ...task, task: 'Verified prompt', model: 'local/model' },
      }),
    );
    render(<SubtaskListPanel sessionId="parent-1" isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }));
    expect(await screen.findByText('Verified prompt')).toBeTruthy();
    expect(screen.getByText('local/model')).toBeTruthy();
    expect(screen.queryByText(i18nService.t('subtaskDetailsRefreshFailed'))).toBeNull();
    expect(screen.queryByRole('status', { name: /查询中/ })).toBeNull();
  });

  it('preserves usage across missing statistics and reloads it independently of task status', async () => {
    i18nService.setLanguage('en', { persist: false });
    const task = {
      id: 'one',
      taskName: 'one',
      sessionKey: 'child',
      label: 'Research',
      status: 'running',
    };
    const stats = {
      summary: null,
      messageCount: 1,
      userMessageCount: 0,
      assistantMessageCount: 1,
      toolCallCount: 0,
      models: [],
      tokenUsage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4 },
      totalTokens: 154,
      hasTokenUsage: true,
    };
    const details = vi
      .fn()
      .mockResolvedValueOnce({ success: true, subagent: task, stats })
      .mockResolvedValueOnce({ success: true, subagent: { ...task, status: 'done' } })
      .mockResolvedValue({
        success: true,
        subagent: { ...task, status: 'done' },
        stats: { ...stats, totalTokens: 200 },
      });
    let changed: ((event: { sessionId?: string }) => void) | undefined;
    installElectron(
      vi
        .fn()
        .mockResolvedValueOnce({ success: true, subagents: [task] })
        .mockResolvedValue({ success: true, subagents: [{ ...task, status: 'done' }] }),
      details,
      vi.fn(callback => {
        changed = callback;
        return vi.fn();
      }),
    );
    render(<SubtaskListPanel sessionId="parent" isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    expect(await screen.findByText('154')).toBeTruthy();
    act(() => changed?.({ sessionId: 'parent' }));
    expect(await screen.findByText(i18nService.t('subtaskUsageStale'))).toBeTruthy();
    expect(screen.getByText('154')).toBeTruthy();
    expect(screen.queryByText(i18nService.t('subtaskDetailsRefreshFailed'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload usage' }));
    expect(await screen.findByText('200')).toBeTruthy();
    expect(screen.queryByText(i18nService.t('subtaskUsageStale'))).toBeNull();
    expect(details).toHaveBeenCalledTimes(3);
  });

  it('renders one compact row per subtask with a localized status value', async () => {
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

    const panel = await screen.findByRole('complementary', { name: '子任务列表' });
    expect(panel).toBeTruthy();
    expect(panel.className).toContain('top-full');
    expect(panel.className).not.toContain('min-[1100px]:relative');
    expect(await screen.findByText('检索资料')).toBeTruthy();
    expect(screen.getByText('进行中 1')).toBeTruthy();
    const finishedToggle = screen.getByRole('button', { name: '已结束 1' });
    expect(finishedToggle.getAttribute('aria-expanded')).toBe('true');
    const runningRow = screen.getByRole('button', { name: '检索资料' }).parentElement;
    expect(runningRow?.children).toHaveLength(4);
    expect(runningRow?.children[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(runningRow?.children[1]?.textContent).toBe('检索资料');
    expect(runningRow?.children[2]?.textContent).toBe('运行中');
    expect(runningRow?.children[3]?.getAttribute('aria-label')).toBe('查看详情');
    expect(screen.queryByText('正在阅读源码')).toBeNull();
    expect(screen.queryByText('read')).toBeNull();
    expect(screen.queryByText('3 次工具调用')).toBeNull();
    expect(screen.getByText('整理结论')).toBeTruthy();
    expect(screen.getByText('已完成')).toBeTruthy();
    expect(screen.queryByText('已提交报告')).toBeNull();

    fireEvent.click(finishedToggle);
    expect(finishedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('整理结论')).toBeNull();
  });

  it('closes the floating list with Escape or a pointer press outside', async () => {
    i18nService.setLanguage('en', { persist: false });
    installElectron(vi.fn().mockResolvedValue({ success: true, subagents: [] }));
    const onClose = vi.fn();

    const view = render(
      <div>
        <button type="button">Outside</button>
        <SubtaskListPanel sessionId="parent-1" isOpen onClose={onClose} />
      </div>,
    );
    await screen.findByRole('complementary', { name: 'Subtasks' });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenNthCalledWith(1, true);

    view.rerender(
      <div>
        <button type="button">Outside</button>
        <SubtaskListPanel sessionId="parent-1" isOpen onClose={onClose} />
      </div>,
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(onClose).toHaveBeenNthCalledWith(2, false);
  });

  it('labels an external subtask with the called agent name instead of ACP', async () => {
    i18nService.setLanguage('zh', { persist: false });
    installElectron(
      vi.fn().mockResolvedValue({
        success: true,
        subagents: [
          {
            id: 'codex-child',
            taskName: 'codex-child',
            sessionKey: 'agent:codex:acp:child-1',
            label: '实现功能',
            labelSource: 'label',
            status: 'running',
            runtime: 'acp',
            agentId: 'codex',
          },
        ],
      }),
    );

    render(<SubtaskListPanel sessionId="parent-1" isOpen onClose={vi.fn()} />);

    expect(await screen.findByText('Codex')).toBeTruthy();
    expect(screen.queryByText('ACP')).toBeNull();
  });

  it('shows current-instance model-request usage in the subtask detail dialog', async () => {
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
      expect(getSubTaskDetails).toHaveBeenCalledWith('agent:main:subagent:child-1', 'child-1'),
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
    expect(
      await screen.findByText('详情刷新失败，当前数据可能不是最新状态。', undefined, {
        timeout: 4_000,
      }),
    ).toBeTruthy();
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

  it('does not let an invalidated status response close an open detail dialog', async () => {
    i18nService.setLanguage('en', { persist: false });
    const child = {
      id: 'child-1',
      taskName: 'child-1',
      sessionKey: 'agent:main:subagent:child-1',
      label: 'Research',
      labelSource: 'label',
      status: 'running',
    };
    let resolveStale:
      ((value: { success: true; subagents: Array<Record<string, unknown>> }) => void) | undefined;
    let resolveFresh:
      ((value: { success: true; subagents: Array<Record<string, unknown>> }) => void) | undefined;
    const stale = new Promise<{ success: true; subagents: Array<Record<string, unknown>> }>(
      resolve => {
        resolveStale = resolve;
      },
    );
    const fresh = new Promise<{ success: true; subagents: Array<Record<string, unknown>> }>(
      resolve => {
        resolveFresh = resolve;
      },
    );
    const getSubTaskStatus = vi
      .fn()
      .mockResolvedValueOnce({ success: true, subagents: [child] })
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(fresh);
    const getSubTaskDetails = vi.fn().mockResolvedValue({
      success: true,
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
    });
    let taskChanged: ((event: { sessionId?: string }) => void) | undefined;
    installElectron(
      getSubTaskStatus,
      getSubTaskDetails,
      vi.fn(callback => {
        taskChanged = callback;
        return vi.fn();
      }),
    );

    render(<SubtaskListPanel sessionId="parent-1" isOpen onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    expect(screen.getByRole('dialog', { name: 'Research' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh subtasks' }));
    await waitFor(() => expect(getSubTaskStatus).toHaveBeenCalledTimes(2));
    act(() => taskChanged?.({ sessionId: 'parent-1' }));
    resolveStale?.({ success: true, subagents: [] });
    await waitFor(() => expect(getSubTaskStatus).toHaveBeenCalledTimes(3));

    expect(screen.getByRole('dialog', { name: 'Research' })).toBeTruthy();
    resolveFresh?.({ success: true, subagents: [child] });
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Research' })).toBeTruthy());
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
