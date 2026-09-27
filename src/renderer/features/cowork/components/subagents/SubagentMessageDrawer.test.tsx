// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ options: [] as unknown[], connect: vi.fn() }));
vi.mock('../chat/JustDoChatWrapper', () => ({ connectToGateway: mocks.connect }));
vi.mock('../chat/ChatMessageDisplay', () => ({ default: () => <div>Native history</div> }));
vi.mock('@/libs/openclaw-chat/gateway/chat-controller', () => ({
  ChatController: class {
    state = {
      sessionKey: '',
      initialHistoryReady: false,
      chatMessages: [],
      transcript: { activeTurn: null },
      lastError: null,
    };
    constructor(options: unknown) {
      mocks.options.push(options);
    }
    subscribe = () => () => {};
    disconnect = vi.fn();
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
  mocks.connect.mockReset().mockResolvedValue(true);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      cowork: { getSubTaskStatus: vi.fn().mockResolvedValue({ success: true, subagents: [] }) },
    },
  });
});
afterEach(cleanup);

describe('subagent transcript initialization', () => {
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
