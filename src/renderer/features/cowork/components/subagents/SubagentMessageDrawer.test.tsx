// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  options: [] as unknown[], connect: vi.fn(),
  getSubagentConversation: vi.fn(), send: vi.fn(), deleteSession: vi.fn(),
  sendResult: vi.fn(), refreshSessionRuntimeActivity: vi.fn(),
  instances: [] as Array<{
    state: {
      sessionKey: string; initialHistoryReady: boolean; chatMessages: unknown[];
      currentSessionId: string | null; connected: boolean; chatSending: boolean;
      client: { generation: number; request?: ReturnType<typeof vi.fn> } | null; hello: object | null;
      historyPreparationPending: boolean; historyPreparationTimedOut: boolean; historyReadFailed: boolean;
      chatLoading: boolean; historyHasMore: boolean;
      transcript: { activeTurn: null; historyGeneration: number }; lastError: string | null;
    };
    notify: () => void; disconnect: ReturnType<typeof vi.fn>; loadHistory: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('../chat/JustDoChatWrapper', () => ({ connectToGateway: mocks.connect }));
vi.mock('../chat/nativeHistorySend', () => ({ sendNativeHistoryMessage: mocks.send }));
vi.mock('../../coworkService', () => ({ coworkService: {
  deleteSession: mocks.deleteSession,
  refreshSessionRuntimeActivity: mocks.refreshSessionRuntimeActivity,
} }));
vi.mock('../composer/CoworkPromptInput', () => ({
  default: ({ disabled, onSubmit, placeholder, draftKeyOverride }: {
    disabled: boolean;
    onSubmit: (prompt: string) => Promise<boolean>;
    placeholder: string;
    draftKeyOverride: string;
  }) => (
    <div>
      <input placeholder={placeholder} disabled={disabled} data-draft={draftKeyOverride} />
      <button type="button" onClick={() => void onSubmit('Follow-up').then(mocks.sendResult)} disabled={disabled}>Send</button>
    </div>
  ),
}));
vi.mock('../chat/ChatMessageDisplay', () => ({
  default: vi.fn(({ controller }: { controller: (typeof mocks.instances)[number] | null }) =>
    <div>Native history {controller?.state.chatMessages.join('\n')}</div>,
  ),
}));
vi.mock('@/libs/openclaw-chat/gateway/chat-controller', () => ({
  ChatController: class {
    state = {
      sessionKey: '',
      currentSessionId: null as string | null,
      connected: false,
      chatSending: false,
      client: null as { generation: number } | null,
      hello: null as object | null,
      initialHistoryReady: false,
      historyPreparationPending: false,
      historyPreparationTimedOut: false,
      historyReadFailed: false,
      chatLoading: false,
      historyHasMore: false,
      chatMessages: [] as unknown[],
      transcript: { activeTurn: null, historyGeneration: 0 },
      lastError: null as string | null,
    };
    constructor(options: unknown) {
      mocks.options.push(options);
      mocks.instances.push(this);
    }
    listeners = new Set<(state: typeof this.state) => void>();
    notify = () => this.listeners.forEach(listener => listener(this.state));
    subscribe = (callback: (state: typeof this.state) => void) => {
      this.listeners.add(callback);
      return () => this.listeners.delete(callback);
    };
    hasUnconfirmedQueuedInput = () => false;
    getLoadedMessages = () => this.state.chatMessages;
    disconnect = vi.fn();
    loadHistory = vi.fn().mockResolvedValue(true);
  },
}));

import { buildChatItems } from '@/libs/openclaw-chat/pipeline/build-chat-items';
import { i18nService } from '@/services/i18n';

import ChatMessageDisplay from '../chat/ChatMessageDisplay';
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
  mocks.getSubagentConversation.mockReset().mockResolvedValue({ success: true });
  mocks.send.mockReset().mockResolvedValue('accepted');
  mocks.deleteSession.mockReset().mockResolvedValue(true);
  mocks.sendResult.mockReset();
  mocks.refreshSessionRuntimeActivity.mockReset().mockResolvedValue(null);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      cowork: {
        getSubTaskStatus: vi.fn().mockResolvedValue({ success: true, subagents: [] }),
        getSubagentConversation: mocks.getSubagentConversation,
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('subagent transcript initialization', () => {
  it.each([
    ['delegated', 'subagent'],
    ['delegated', 'dashboard'],
    ['human', 'dashboard'],
    ['stale', 'subagent'],
  ] as const)(
    'attributes a %s opening input in a %s session only with matching stored task evidence',
    async (kind, sessionKind) => {
      const parentTaskId = 'agent:reviewer:justdo:parent';
      const sessionKey = `agent:reviewer:${sessionKind}:child`;
      const displayEntry = {
        role: 'user',
        content: 'Write one line.',
        __openclaw: { id: 'opening-input', seq: 1 },
      };
      const history = [
        displayEntry,
        { role: 'assistant', content: 'First reply.', __openclaw: { id: 'reply', seq: 2 } },
        {
          role: 'user', content: 'My follow-up.',
          __openclaw: { id: 'follow-up', seq: 3, senderIdentity: { type: 'profile', id: 'user' } },
        },
      ];
      let resolveSource!: (value: unknown) => void;
      const request = vi.fn().mockReturnValueOnce(new Promise(resolve => { resolveSource = resolve; }));
      request.mockResolvedValue({ ok: false });
      render(<SubagentMessageDrawer parentSessionId="parent"
        subagent={{ ...task, sessionKey, parentTaskId, sessionId: 'native-child' }} onClose={vi.fn()} />);
      const controller = mocks.instances[0];
      act(() => {
        Object.assign(controller.state, {
          connected: true,
          currentSessionId: 'native-child',
          client: { generation: 1, request },
          chatMessages: history,
          historyHasMore: true,
        });
        controller.notify();
      });
      expect(request).not.toHaveBeenCalled();
      act(() => {
        controller.state.historyHasMore = false;
        controller.notify();
      });
      expect(request).toHaveBeenCalledExactlyOnceWith('runtimeServices.historyMessage', {
        sessionKey,
        sessionId: 'native-child',
        messageId: 'opening-input',
        cursor: 0,
        maxChars: 512 * 1024,
      });
      if (kind === 'stale') {
        act(() => {
          controller.state.transcript.historyGeneration += 1;
          controller.notify();
        });
      }
      const wrappedTask = [
        '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>',
        '[Subagent Context] You are running as a subagent (depth 1/5). Complete the current [Subagent Task]; inherited conversation is background context, not your assignment.',
        '[Subagent Task]',
        '<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
        displayEntry.content,
        '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>',
        'Begin. Execute the assigned task to completion.',
        '<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
      ].join('\n\n');
      await act(async () => resolveSource({
        ok: true,
        complete: true,
        chunk: JSON.stringify({ role: 'user', content: kind === 'human' ? displayEntry.content : wrappedTask }),
      }));

      expect(vi.mocked(ChatMessageDisplay).mock.lastCall?.[0]).toMatchObject({
        subagentParentSessionKey: parentTaskId,
        subagentTaskEntryId: kind === 'delegated' ? 'opening-input' : undefined,
      });
      expect(controller.state.chatMessages).toEqual(history);
    },
  );

  it('renders a forwarded parent message between the two child replies', async () => {
    render(<SubagentMessageDrawer parentSessionId="parent" subagent={task} onClose={vi.fn()} />);
    await act(async () => {});

    const display = vi.mocked(ChatMessageDisplay).mock.lastCall?.[0];
    const messages = [
      { role: 'user', content: 'Write one line', timestamp: 1 },
      { role: 'assistant', content: 'First reply', timestamp: 2 },
      {
        role: 'assistant',
        content: 'Try a second line',
        timestamp: 3,
        provenance: {
          kind: 'inter_session',
          sourceTool: 'sessions_send',
          sourceSessionKey: 'agent:main:justdo:parent',
        },
      },
      { role: 'assistant', content: 'Second reply', timestamp: 4 },
    ];
    const items = buildChatItems({
      sessionKey: task.sessionKey,
      messages,
      toolMessages: [],
      showToolCalls: true,
      stream: null,
      streamStartedAt: null,
      peerPerspective: display?.peerPerspective,
    });

    expect(items.filter(item => item.kind === 'group').map(item => [item.role, item.senderId])).toEqual([
      ['user', null],
      ['assistant', null],
      ['user', 'main'],
      ['assistant', null],
    ]);
  });

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

it('stops the selected subagent from the toolbar button next to View details', async () => {
  const child = { ...task, sessionId: 'native-child' };
  const controlSubTask = vi.fn().mockResolvedValue({ success: true });
  const getSubTaskDetails = vi.fn<(typeof window.electron.cowork)['getSubTaskDetails']>();
  let confirmStatus!: (result: Awaited<ReturnType<typeof getSubTaskDetails>>) => void;
  getSubTaskDetails.mockReturnValueOnce(
    new Promise(resolve => {
      confirmStatus = resolve;
    }),
  );
  Object.assign(window.electron.cowork, { controlSubTask, getSubTaskDetails });
  render(<SubagentMessageDrawer parentSessionId="parent" subagent={child} onClose={vi.fn()} />);

  const stop = screen.getByRole('button', { name: 'Stop subagent' }) as HTMLButtonElement;
  const details = screen.getByRole('button', { name: 'View details' });
  const toolbarButtons = within(details.parentElement!).getAllByRole('button');
  expect(toolbarButtons[toolbarButtons.indexOf(details) - 1]).toBe(stop);
  expect([...stop.classList]).toEqual(expect.arrayContaining(['h-7', 'w-7']));
  fireEvent.click(stop);
  await waitFor(() => expect(getSubTaskDetails).toHaveBeenCalledWith(child.sessionKey, child.id));
  expect(stop.disabled).toBe(true);
  expect(screen.getByText('Running')).toBeTruthy();
  expect(controlSubTask).toHaveBeenCalledExactlyOnceWith('parent', child.id, 'cancel');

  await act(async () => confirmStatus({ success: true, subagent: { ...child, status: 'killed' } }));
  expect(screen.getByText('Cancelled')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Stop subagent' })).toBeNull();
});

describe('subagent conversation actions', () => {
  const visibleTask = { ...task, sessionKey: 'agent:main:dashboard:child', status: 'done' } as const;
  const target = {
    productSessionId: 'child-binding',
    parentProductSessionId: 'immediate-parent',
    sessionKey: visibleTask.sessionKey,
    sessionId: 'native-child',
    lifecycleRevision: 'revision-1',
    agentId: 'main',
    workingDirectory: 'E:\\repo',
  };
  const loadHistory = (index: number, sessionId: string, chatSending = false) => {
    const controller = mocks.instances[index];
    act(() => {
      Object.assign(controller.state, {
        initialHistoryReady: true, currentSessionId: sessionId, chatMessages: ['Child output'],
        connected: true, client: { generation: 1 }, hello: {}, chatSending,
      });
      controller.notify();
    });
    return controller;
  };

  it('shows the approved child input alongside its own history and sends via the same controller', async () => {
    mocks.getSubagentConversation.mockResolvedValue({ success: true, target });
    render(<SubagentMessageDrawer parentSessionId="parent" subagent={visibleTask} onClose={vi.fn()} />);
    // A visible dashboard history can load without the hidden task marker.
    expect(mocks.options[0]).toMatchObject({ expectInitialHistory: false });
    const controller = loadHistory(0, target.sessionId, true);
    const input = await screen.findByPlaceholderText(i18nService.t('coworkContinuePlaceholder')) as HTMLInputElement;

    expect(screen.getByText(/Child output/)).toBeTruthy();
    expect(input.getAttribute('data-draft')).toBe(`subagent:${target.productSessionId}`);
    expect(input.disabled).toBe(true);
    expect(mocks.getSubagentConversation).toHaveBeenCalledExactlyOnceWith('parent', target.sessionKey, target.sessionId);
    expect(window.electron.cowork.getSubTaskStatus).toHaveBeenLastCalledWith(target.parentProductSessionId, false);
    act(() => {
      controller.state.chatSending = false;
      controller.notify();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      controller, target, 'Follow-up', [], expect.any(String), expect.any(Function), expect.any(Function),
    ));
    const assertCurrent = mocks.send.mock.calls[0][5];
    expect(assertCurrent).not.toThrow();
    controller.state.client!.generation += 1;
    expect(assertCurrent).toThrow();
  });

  it('ignores a reply that authorizes a drawer after the user has selected a different child', async () => {
    let authorize!: (result: unknown) => void;
    mocks.getSubagentConversation.mockImplementationOnce(() => new Promise(resolve => { authorize = resolve; }));
    const onClose = vi.fn();
    const view = render(<SubagentMessageDrawer parentSessionId="parent" subagent={visibleTask} onClose={onClose} />);
    loadHistory(0, target.sessionId);
    await waitFor(() => expect(mocks.getSubagentConversation).toHaveBeenCalledOnce());

    view.rerender(<SubagentMessageDrawer parentSessionId="parent" subagent={{ ...task, status: 'done' }} onClose={onClose} />);
    loadHistory(1, 'hidden-child');
    await act(async () => authorize({ success: true, target }));

    expect(mocks.getSubagentConversation).toHaveBeenLastCalledWith('parent', task.sessionKey, 'hidden-child');
    expect(screen.queryByPlaceholderText(i18nService.t('coworkContinuePlaceholder'))).toBeNull();
    expect(screen.queryByRole('button', { name: i18nService.t('deleteSession') })).toBeNull();
  });

  it('checks the exact child after uncertain delivery without asking the composer to retain a retry draft', async () => {
    mocks.getSubagentConversation.mockResolvedValue({ success: true, target });
    mocks.send.mockResolvedValue('unknown');
    render(<SubagentMessageDrawer parentSessionId="parent" subagent={visibleTask} onClose={vi.fn()} />);
    loadHistory(0, target.sessionId);

    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));

    expect((await screen.findByRole('alert')).textContent).toBe(i18nService.t('subtaskSendOutcomeUnknown'));
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.sendResult).toHaveBeenCalledWith(true);
    expect(mocks.refreshSessionRuntimeActivity).toHaveBeenCalledExactlyOnceWith(target.productSessionId, {
      includeSubagents: true, forceRefresh: true, fullScan: true,
    });
  });

  it('keeps deletion accessible without adding a composer to an older read-only child binding', async () => {
    mocks.getSubagentConversation.mockResolvedValue({
      success: true, target: { ...target, sessionKey: task.sessionKey, canSend: false },
    });
    render(<SubagentMessageDrawer parentSessionId="parent" subagent={{ ...task, status: 'done' }} onClose={vi.fn()} />);
    loadHistory(0, target.sessionId);

    expect(await screen.findByRole('button', { name: i18nService.t('deleteSession') })).toBeTruthy();
    expect(screen.queryByPlaceholderText(i18nService.t('coworkContinuePlaceholder'))).toBeNull();
  });

  it('deletes the approved child only after confirmation and keeps the drawer open on failure', async () => {
    mocks.getSubagentConversation.mockResolvedValue({ success: true, target });
    mocks.deleteSession.mockResolvedValueOnce(false);
    const onClose = vi.fn();
    render(<SubagentMessageDrawer parentSessionId="parent" subagent={visibleTask} onClose={onClose} />);
    loadHistory(0, target.sessionId);
    const label = i18nService.t('deleteSession');
    fireEvent.click(await screen.findByRole('button', { name: label }));
    const dialog = within(screen.getByRole('dialog', { name: i18nService.t('deleteTaskConfirmTitle') }));
    expect(mocks.deleteSession).not.toHaveBeenCalled();

    fireEvent.click(dialog.getByRole('button', { name: label }));
    expect((await dialog.findByRole('alert')).textContent).toBe(i18nService.t('subtaskDeleteFailed'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(dialog.getByRole('button', { name: label }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const expected = { sessionKey: target.sessionKey, sessionId: target.sessionId, lifecycleRevision: target.lifecycleRevision };
    expect(mocks.deleteSession.mock.calls).toEqual([
      [target.productSessionId, expected], [target.productSessionId, expected],
    ]);
  });
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
