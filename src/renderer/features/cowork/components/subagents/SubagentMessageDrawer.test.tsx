// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  options: [] as unknown[], connect: vi.fn(),
  instances: [] as Array<{
    state: {
      sessionKey: string; initialHistoryReady: boolean; chatMessages: string[];
      historyPreparationPending: boolean; historyPreparationTimedOut: boolean; historyReadFailed: boolean;
      chatLoading: boolean;
      transcript: { activeTurn: null }; lastError: string | null;
    };
    notify: () => void; disconnect: ReturnType<typeof vi.fn>; loadHistory: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('../chat/JustDoChatWrapper', () => ({ connectToGateway: mocks.connect }));
vi.mock('../chat/ChatMessageDisplay', () => ({
  default: ({ controller }: { controller: (typeof mocks.instances)[number] | null }) =>
    <div>Native history {controller?.state.chatMessages.join('\n')}</div>,
}));
vi.mock('@/libs/openclaw-chat/gateway/chat-controller', () => ({
  ChatController: class {
    state = {
      sessionKey: '',
      initialHistoryReady: false,
      historyPreparationPending: false,
      historyPreparationTimedOut: false,
      historyReadFailed: false,
      chatLoading: false,
      chatMessages: [] as string[],
      transcript: { activeTurn: null },
      lastError: null as string | null,
    };
    constructor(options: unknown) {
      mocks.options.push(options);
      mocks.instances.push(this);
    }
    notify = () => {};
    subscribe = (callback: (state: typeof this.state) => void) => {
      this.notify = () => callback(this.state);
      return () => { this.notify = () => {}; };
    };
    disconnect = vi.fn();
    loadHistory = vi.fn().mockResolvedValue(true);
  },
}));

import { i18nService } from '@/services/i18n';

import SubagentMessageDrawer from './SubagentMessageDrawer';
import type { Subtask } from './subtaskPresentation';

const task: Subtask = {
  id: 'usage-task',
  taskName: 'usage-task',
  sessionKey: 'agent:main:subagent:usage',
  label: 'Usage task',
  labelSource: 'label',
  status: 'running',
  runtime: 'subagent',
};
const stats = {
  summary: null,
  messageCount: 1,
  userMessageCount: 0,
  assistantMessageCount: 1,
  toolCallCount: 0,
  models: ['test-model'],
  tokenUsage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4 },
  totalTokens: 154,
  hasTokenUsage: true,
};

beforeEach(() => {
  i18nService.setLanguage('en', { persist: false });
  mocks.options.length = 0;
  mocks.instances.length = 0;
  mocks.connect.mockReset().mockResolvedValue(true);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      cowork: { getSubTaskStatus: vi.fn().mockResolvedValue({ success: true, subagents: [] }) },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('subagent transcript initialization', () => {
  it.each([false, true])('bounds preparation recovery without task proof and cancels on genuine readiness (%s)', async becomesReady => {
    vi.useFakeTimers();
    const view = render(<SubagentMessageDrawer parentSessionId="parent"
      subagent={{ ...task, status: 'done' }} onClose={vi.fn()} />);
    await act(async () => {});
    const controller = mocks.instances[0];
    act(() => {
      controller.state.chatMessages = ['Cached task text'];
      controller.state.historyPreparationPending = true;
      controller.notify();
    });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => {
      controller.state.historyPreparationPending = false;
      controller.notify();
    });
    expect(controller.state.initialHistoryReady).toBe(false);
    expect(screen.getByRole('status').textContent).toBe(i18nService.t('loading'));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    act(() => {
      controller.state.initialHistoryReady = becomesReady;
      controller.notify();
    });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    if (becomesReady) {
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('button', { name: i18nService.t('storageHistoryRetry') })).toBeNull();
    } else {
      expect(controller.state.initialHistoryReady).toBe(false);
      expect(controller.state.historyPreparationTimedOut).toBe(false);
      expect(screen.getByRole('alert').textContent).toContain(i18nService.t('subtaskMessagesLoadFailed'));
      expect(screen.getByRole('button', { name: i18nService.t('storageHistoryRetry') })).toBeTruthy();
    }
    expect(screen.getByText(/Cached task text/)).toBeTruthy();
    expect(mocks.instances).toHaveLength(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves cached task history during native preparation and exposes a bounded manual retry', async () => {
    vi.useFakeTimers();
    const view = render(<SubagentMessageDrawer parentSessionId="parent"
      subagent={{ ...task, status: 'done' }} onClose={vi.fn()} />);
    await act(async () => {});
    const controller = mocks.instances[0];
    act(() => {
      controller.state.chatMessages = ['Cached task text'];
      controller.state.historyPreparationPending = true;
      controller.notify();
    });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(i18nService.t('storageHistoryPreparing'));
    expect(screen.getByText(/Cached task text/)).toBeTruthy();
    expect(mocks.connect).toHaveBeenCalledOnce();
    act(() => {
      controller.state.historyPreparationPending = false;
      controller.state.historyPreparationTimedOut = true;
      controller.state.historyReadFailed = true;
      controller.notify();
    });
    expect(screen.getByRole('alert').textContent).toContain(i18nService.t('storageHistoryPreparationPending'));
    expect(screen.getByText(/Cached task text/)).toBeTruthy();
    controller.loadHistory.mockImplementationOnce(async () => {
      controller.state.historyPreparationTimedOut = false;
      controller.state.historyReadFailed = false;
      controller.state.chatLoading = false;
      controller.notify();
      return true;
    });
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('storageHistoryRetry') }));
    await act(async () => {});
    expect(controller.loadHistory).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.instances).toHaveLength(1);
    expect(controller.disconnect).not.toHaveBeenCalled();
    expect(screen.getByText(/Cached task text/)).toBeTruthy();
    expect(controller.state.initialHistoryReady).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain(i18nService.t('subtaskMessagesLoadFailed'));
    expect(screen.getByRole('alert').textContent).not.toContain(i18nService.t('storageHistoryPreparationPending'));
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('storageHistoryRetry') }));
    await act(async () => {});
    expect(controller.loadHistory).toHaveBeenCalledTimes(2);
    expect(mocks.instances).toHaveLength(1);
    act(() => {
      controller.state.historyPreparationTimedOut = false;
      controller.state.historyReadFailed = false;
      controller.state.historyPreparationPending = true;
      controller.state.chatLoading = true;
      controller.notify();
    });
    expect(screen.getByRole('status').textContent).toBe(i18nService.t('storageHistoryPreparing'));
    act(() => {
      controller.state.initialHistoryReady = true;
      controller.state.historyPreparationPending = false;
      controller.state.chatLoading = false;
      controller.notify();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Cached task text/)).toBeTruthy();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['subagent', 'acp'] as const)(
    'uses the %s initial task message format',
    async runtime => {
      const subagent: Subtask = {
        id: 'task',
        taskName: 'task',
        sessionKey: `agent:main:${runtime}:child`,
        label: 'Task',
        labelSource: 'label',
        status: 'done',
        runtime,
      };
      render(
        <SubagentMessageDrawer parentSessionId="parent" subagent={subagent} onClose={vi.fn()} />,
      );
      await act(async () => Promise.resolve());
      expect(mocks.options).toEqual([
        {
          expectInitialHistory: true,
          expectInitialUserMessage: runtime === 'acp',
        },
      ]);
      expect(mocks.connect).toHaveBeenCalledTimes(1);
    },
  );
});

describe('subagent drawer usage recovery', () => {
  it('preserves the last totals when terminal task details omit usage and supports retry', async () => {
    const getDetails = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stats })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValue({ success: true, stats: { ...stats, totalTokens: 178 } });
    window.electron.cowork.getSubTaskDetails = getDetails;
    const view = render(
      <SubagentMessageDrawer parentSessionId="parent" subagent={task} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('subtaskShowInfo') }));
    expect(await screen.findByText('154')).toBeTruthy();
    view.rerender(
      <SubagentMessageDrawer
        parentSessionId="parent"
        subagent={{ ...task, status: 'done' }}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText(i18nService.t('subtaskUsageStale'))).toBeTruthy();
    expect(screen.getByText('154')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('subtaskUsageRetry') }));
    expect(await screen.findByText('178')).toBeTruthy();
    expect(screen.queryByText(i18nService.t('subtaskUsageStale'))).toBeNull();
    expect(getDetails).toHaveBeenCalledTimes(3);
  });

  it('does not carry previous-task usage into another task with unavailable usage', async () => {
    const getDetails = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stats })
      .mockResolvedValue({ success: true });
    window.electron.cowork.getSubTaskDetails = getDetails;
    const view = render(
      <SubagentMessageDrawer parentSessionId="parent" subagent={task} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('subtaskShowInfo') }));
    expect(await screen.findByText('154')).toBeTruthy();
    view.rerender(
      <SubagentMessageDrawer
        parentSessionId="parent"
        subagent={{
          ...task,
          id: 'other-task',
          sessionKey: 'agent:main:subagent:other',
          status: 'done',
        }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.queryByText('154')).toBeNull());
    expect(await screen.findByText(i18nService.t('subtaskUsageUnavailable'))).toBeTruthy();
    expect(screen.queryByText(i18nService.t('subtaskUsageStale'))).toBeNull();
  });
});
