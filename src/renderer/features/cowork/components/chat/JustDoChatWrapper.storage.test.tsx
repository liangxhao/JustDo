// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';
import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import JustDoChatWrapper, { type JustDoChatWrapperRef } from './JustDoChatWrapper';

vi.mock('./ChatMessageDisplay', () => ({ default: () => <div /> }));
const fixture = vi.hoisted(() => ({
  readiness: { ready: true, pending: false, failed: false },
  session: { id: 'old', agentId: 'main' } as {
    id: string;
    agentId: string;
    branchCreationPending?: boolean;
  },
  mcpControls: null as null | {
    prepare: () => Promise<unknown>;
    canDraft: () => boolean;
    onOnboard: (pluginId: string, signal: AbortSignal) => Promise<void>;
  },
}));
vi.mock('@/app/shell/startup/routing/useEngineReadiness', () => ({
  useEngineReadiness: () => fixture.readiness,
}));
vi.mock('../mcpApps/McpAppsControls', () => ({
  McpAppsControls: (props: NonNullable<typeof fixture.mcpControls>) => {
    fixture.mcpControls = props;
    return null;
  },
}));
vi.mock('react-redux', () => ({ useSelector: () => fixture.session }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  fixture.readiness = { ready: true, pending: false, failed: false };
  fixture.session = { id: 'old', agentId: 'main' };
  fixture.mcpControls = null;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      mcpApps: {
        prepare: vi.fn(),
        questions: vi.fn().mockResolvedValue({ success: true, value: [] }),
        onQuestionsChanged: vi.fn(() => () => undefined),
      },
      openclaw: {
        engine: {
          getPort: vi.fn().mockResolvedValue({ success: true, port: 1 }),
          getToken: vi.fn().mockResolvedValue({ success: true, token: 'fixture' }),
        },
      },
    },
  });
});

it('waits for execution admission before connecting history and uses the latest selected session', async () => {
  fixture.readiness = { ready: false, pending: true, failed: false };
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    this.state.initialHistoryReady = true;
  });
  const send = vi.spyOn(ChatController.prototype, 'sendMessage').mockResolvedValue();
  const ref = createRef<JustDoChatWrapperRef>();
  const onReady = vi.fn();
  const view = render(<JustDoChatWrapper ref={ref} onHistoryReadyChange={onReady} />);

  expect(screen.getByRole('status').textContent).toContain('enginePreparingContent');
  expect(window.electron.openclaw.engine.getPort).not.toHaveBeenCalled();
  expect(window.electron.openclaw.engine.getToken).not.toHaveBeenCalled();
  expect(ref.current?.getExportSnapshot().isLoading).toBe(true);
  await expect(ref.current?.sendMessage('retain draft')).rejects.toMatchObject({ requestSent: false });
  expect(onReady).toHaveBeenLastCalledWith('agent:main:justdo:old', false);

  fixture.session = { id: 'selected-while-starting', agentId: 'main' };
  view.rerender(<JustDoChatWrapper ref={ref} onHistoryReadyChange={onReady} />);
  fixture.readiness = { ready: true, pending: false, failed: false };
  view.rerender(<JustDoChatWrapper ref={ref} onHistoryReadyChange={onReady} />);
  await waitFor(() => expect(connect).toHaveBeenCalledOnce());
  expect(connect).toHaveBeenCalledWith('ws://127.0.0.1:1', 'fixture', 'agent:main:justdo:selected-while-starting');
  expect(send).not.toHaveBeenCalled();

  const controller = connect.mock.instances[0] as ChatController;
  controller.state.chatMessages = [{ role: 'assistant', content: 'Retained history' }];
  fixture.readiness = { ready: false, pending: true, failed: false };
  view.rerender(<JustDoChatWrapper ref={ref} onHistoryReadyChange={onReady} />);
  fixture.readiness = { ready: true, pending: false, failed: false };
  view.rerender(<JustDoChatWrapper ref={ref} onHistoryReadyChange={onReady} />);
  expect(connect).toHaveBeenCalledOnce();
  expect(controller.state.chatMessages).toEqual([{ role: 'assistant', content: 'Retained history' }]);
});

it('keeps unopened history unavailable after startup failure and connects after a successful retry', async () => {
  fixture.readiness = { ready: false, pending: true, failed: false };
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockResolvedValue();
  const view = render(<JustDoChatWrapper />);
  fixture.readiness = { ready: false, pending: false, failed: true };
  view.rerender(<JustDoChatWrapper />);
  expect(screen.getByRole('alert').textContent).toContain('engineUnavailableContent');
  expect(screen.queryByText('storageHistoryFailed')).toBeNull();
  expect(connect).not.toHaveBeenCalled();
  fixture.readiness = { ready: false, pending: true, failed: false };
  view.rerender(<JustDoChatWrapper />);
  fixture.readiness = { ready: true, pending: false, failed: false };
  view.rerender(<JustDoChatWrapper />);
  await waitFor(() => expect(connect).toHaveBeenCalledOnce());
});

it('blocks export and sending while history is loading or failed, and retry only reloads history', async () => {
  let controller!: ChatController;
  const publish = () => (controller as unknown as { notify: () => void }).notify();
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    (this as unknown as { notify: () => void }).notify();
  });
  const send = vi.spyOn(ChatController.prototype, 'sendMessage').mockResolvedValue();
  const reload = vi.spyOn(ChatController.prototype, 'loadHistory').mockResolvedValue(true);
  const ref = createRef<JustDoChatWrapperRef>();
  const onReady = vi.fn();
  render(<JustDoChatWrapper ref={ref} onHistoryReadyChange={onReady} />);
  await waitFor(() => expect(connect).toHaveBeenCalled());
  controller = connect.mock.instances[0] as ChatController;
  expect(ref.current?.getExportSnapshot().isLoading).toBe(true);
  await expect(ref.current?.sendMessage('do not send')).rejects.toThrow();
  await expect(ref.current?.sendSideQuestion('do not send', 'side-run')).rejects.toThrow();
  act(() => {
    controller.state.initialHistoryReady = true;
    controller.state.historyReadFailed = true;
    publish();
  });
  expect(screen.getByText('storageHistoryFailed')).toBeTruthy();
  expect(ref.current?.getExportSnapshot().isLoading).toBe(true);
  await expect(ref.current?.sendSideQuestion('do not send', 'side-run')).rejects.toThrow();
  fireEvent.click(screen.getByText('storageHistoryRetry'));
  expect(reload).toHaveBeenCalledWith(true);
  expect(send).not.toHaveBeenCalled();
  act(() => {
    controller.state.historyReadFailed = false;
    publish();
  });
  expect(ref.current?.getExportSnapshot().isLoading).toBe(false);
  expect(onReady).toHaveBeenLastCalledWith('agent:main:justdo:old', true);
  await ref.current?.sendMessage('continue');
  expect(send).toHaveBeenCalledTimes(1);
});

it('shows native preparation loading with cached text and an honest retry notice after the deadline', async () => {
  const messages = [{ role: 'assistant', content: 'Saved visible text' }];
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    this.state.chatMessages = messages;
    this.state.chatLoading = true;
    this.state.historyPreparationPending = true;
    this.state.initialHistoryReady = false;
  });
  const reload = vi.spyOn(ChatController.prototype, 'loadHistory').mockResolvedValue(false);
  const ref = createRef<JustDoChatWrapperRef>();
  const onReady = vi.fn();
  render(<JustDoChatWrapper ref={ref} onHistoryReadyChange={onReady} />);
  await waitFor(() => expect(connect).toHaveBeenCalledOnce());
  const controller = connect.mock.instances[0] as ChatController;
  const publish = () => (controller as unknown as { notify(): void }).notify();
  act(publish);
  expect(screen.getByRole('status').textContent).toContain('storageHistoryLoading');
  expect(controller.state.chatMessages).toEqual(messages);
  expect(onReady).toHaveBeenLastCalledWith('agent:main:justdo:old', false);
  expect(ref.current?.getExportSnapshot().isLoading).toBe(true);
  await expect(ref.current?.sendMessage('must wait')).rejects.toThrow();
  act(() => {
    controller.state.historyPreparationPending = false;
    controller.state.historyPreparationTimedOut = true;
    controller.state.historyReadFailed = true;
    controller.state.chatLoading = false;
    publish();
  });
  expect(screen.getByRole('alert').textContent).toContain('storageHistoryPreparationPending');
  expect(screen.queryByText('storageHistoryFailed')).toBeNull();
  fireEvent.click(screen.getByText('storageHistoryRetry'));
  expect(reload).toHaveBeenCalledExactlyOnceWith(true);
  expect(controller.state.chatMessages).toEqual(messages);
});

it('blocks captured App entrypoints when branch creation becomes pending', async () => {
  vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    this.state.initialHistoryReady = true;
  });
  const onWidgetDraft = vi.fn(() => true);
  const view = render(<JustDoChatWrapper onWidgetDraft={onWidgetDraft} />);
  await waitFor(() => expect(fixture.mcpControls).not.toBeNull());
  const controls = fixture.mcpControls!;
  expect(controls.canDraft()).toBe(true);
  fixture.session = { ...fixture.session, branchCreationPending: true };
  view.rerender(<JustDoChatWrapper onWidgetDraft={onWidgetDraft} />);
  expect(controls.canDraft()).toBe(false);
  await expect(controls.prepare()).rejects.toThrow('coworkBranchCreationPending');
  await expect(controls.onOnboard('fixture', new AbortController().signal)).rejects.toThrow(
    'coworkBranchCreationPending',
  );
  expect(window.electron.mcpApps.prepare).not.toHaveBeenCalled();
  expect(onWidgetDraft).not.toHaveBeenCalled();
});

it('resumes App bindings only after returning to the same ready native incarnation', async () => {
  const request = vi.fn().mockResolvedValue({});
  const client = { generation: 1, request, stop: vi.fn() };
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.client = client as never;
    this.state.connected = true;
    this.state.currentSessionId = 'native-old';
    this.state.initialHistoryReady = true;
  });
  vi.spyOn(ChatController.prototype, 'switchSession').mockImplementation(async function (
    this: ChatController,
    key: string,
  ) {
    this.mcpApps.invalidate();
    this.state.sessionKey = key;
    this.state.currentSessionId = null;
    this.state.initialHistoryReady = false;
    this.mcpApps.refreshBinding();
  });
  const onWidgetDraft = vi.fn(() => true);
  const fixtureView = render(<JustDoChatWrapper onWidgetDraft={onWidgetDraft} />);
  await waitFor(() => expect(connect).toHaveBeenCalledOnce());
  const controller = connect.mock.instances[0] as ChatController;
  const context = (await fixture.mcpControls!.prepare()) as McpAppViewContext;
  expect(context.isCurrent()).toBe(true);

  fixture.session = { id: 'other', agentId: 'main' };
  fixtureView.rerender(<JustDoChatWrapper onWidgetDraft={onWidgetDraft} />);
  expect(context.isCurrent()).toBe(false);
  expect(context.resume?.()).toBeUndefined();
  controller.state.currentSessionId = 'native-other';
  controller.state.initialHistoryReady = true;
  expect(context.resume?.()).toBeUndefined();

  fixture.session = { id: 'old', agentId: 'main' };
  fixtureView.rerender(<JustDoChatWrapper onWidgetDraft={onWidgetDraft} />);
  expect(context.resume?.()).toBeUndefined();
  controller.state.currentSessionId = 'native-old';
  controller.state.initialHistoryReady = true;
  controller.state.historyReadFailed = true;
  expect(context.resume?.()).toBeUndefined();
  controller.state.historyReadFailed = false;
  const resumed = context.resume?.();
  expect(resumed?.isCurrent()).toBe(true);
  expect(context.isCurrent()).toBe(false);
  controller.state.connected = false;
  expect(context.resume?.()).toBeUndefined();
  client.generation++;
  controller.state.connected = true;
  expect(resumed?.isCurrent()).toBe(false);
  expect(context.resume?.()?.isCurrent()).toBe(true);

  controller.state.currentSessionId = 'replacement-incarnation';
  expect(context.resume?.()).toBeUndefined();
  expect(resumed?.isCurrent()).toBe(false);
  controller.state.currentSessionId = 'native-old';
  fixture.session = { ...fixture.session, branchCreationPending: true };
  fixtureView.rerender(<JustDoChatWrapper onWidgetDraft={onWidgetDraft} />);
  expect(context.resume?.()).toBeUndefined();
  expect(window.electron.mcpApps.prepare).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it('pauses Apps on the home screen without disconnecting and rechecks history when returning', async () => {
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    this.state.initialHistoryReady = true;
  });
  const disconnect = vi.spyOn(ChatController.prototype, 'disconnect').mockImplementation(() => {});
  const switchSession = vi.spyOn(ChatController.prototype, 'switchSession').mockResolvedValue();
  const view = render(<JustDoChatWrapper onWidgetDraft={() => true} />);
  await waitFor(() => expect(connect).toHaveBeenCalledOnce());
  const controller = connect.mock.instances[0] as ChatController;
  const invalidate = vi.spyOn(controller.mcpApps, 'invalidate');
  fixture.session = null as never;
  view.rerender(<JustDoChatWrapper className="hidden" />);
  expect(invalidate).toHaveBeenCalledWith(true);
  expect(disconnect).not.toHaveBeenCalled();
  fixture.session = { id: 'old', agentId: 'main' };
  view.rerender(<JustDoChatWrapper onWidgetDraft={() => true} />);
  expect(switchSession).toHaveBeenCalledExactlyOnceWith('agent:main:justdo:old', {
    promoteFromSessionKey: undefined,
  });
  expect(connect).toHaveBeenCalledOnce();
});

it('keeps pending branch history readable while blocking direct native sends and mutations', async () => {
  fixture.session = { id: 'old', agentId: 'main', branchCreationPending: true };
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    this.state.initialHistoryReady = true;
  });
  const send = vi.spyOn(ChatController.prototype, 'sendMessage').mockResolvedValue();
  const side = vi.spyOn(ChatController.prototype, 'sendSideQuestion').mockResolvedValue('side');
  const queue = vi.spyOn(ChatController.prototype, 'queueMessage').mockResolvedValue();
  const withdraw = vi.spyOn(ChatController.prototype, 'withdrawQueuedInput').mockResolvedValue();
  const dismiss = vi.spyOn(ChatController.prototype, 'dismissProgressCard').mockResolvedValue(true);
  const rewind = vi
    .spyOn(ChatController.prototype, 'rewindToUserMessage')
    .mockImplementation(async () => {
      throw new Error('Unexpected native history mutation');
    });
  const initialDispatch = vi
    .spyOn(ChatController.prototype, 'beginInitialDispatch')
    .mockImplementation(() => {});
  const refresh = vi.spyOn(ChatController.prototype, 'refreshProgressCard').mockResolvedValue(true);
  const messages = [{ role: 'assistant', content: 'Copied history' }];
  vi.spyOn(ChatController.prototype, 'getLoadedMessages').mockReturnValue(messages);
  const ref = createRef<JustDoChatWrapperRef>();
  render(<JustDoChatWrapper ref={ref} />);
  await waitFor(() => expect(connect).toHaveBeenCalled());
  const sessionKey = 'agent:main:justdo:old';

  await expect(ref.current!.sendMessage('continue')).rejects.toMatchObject({
    message: 'coworkBranchCreationPending',
    requestSent: false,
  });
  await expect(ref.current!.sendMessage('/compact')).rejects.toThrow('coworkBranchCreationPending');
  await expect(ref.current!.sendSideQuestion('question', 'side')).rejects.toThrow(
    'coworkBranchCreationPending',
  );
  await expect(ref.current!.queueMessage('follow-up', [], undefined, sessionKey)).rejects.toThrow(
    'coworkBranchCreationPending',
  );
  await expect(ref.current!.withdrawQueuedInput('queued', sessionKey)).rejects.toThrow(
    'coworkBranchCreationPending',
  );
  await expect(ref.current!.rewindToUserMessage('entry')).rejects.toThrow(
    'coworkBranchCreationPending',
  );
  await expect(ref.current!.dismissProgressCard()).rejects.toThrow('coworkBranchCreationPending');
  await expect(ref.current!.dispatchInitialTurn({ sessionKey })).rejects.toMatchObject({
    message: 'coworkBranchCreationPending',
    requestSent: false,
  });
  expect(ref.current!.isInitialDispatchReady(sessionKey)).toBe(false);
  for (const mutation of [send, side, queue, withdraw, dismiss, rewind, initialDispatch]) {
    expect(mutation).not.toHaveBeenCalled();
  }
  expect(ref.current!.getExportSnapshot()).toMatchObject({
    messages,
    sessionKey,
    isLoading: false,
  });
  await expect(ref.current!.refreshProgressCard()).resolves.toBe(true);
  expect(refresh).toHaveBeenCalledOnce();
});

it('checks the live pending fence even through an imperative handle captured before a session update', async () => {
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    this.state.initialHistoryReady = true;
  });
  const send = vi.spyOn(ChatController.prototype, 'sendMessage').mockResolvedValue();
  const ref = createRef<JustDoChatWrapperRef>();
  const view = render(<JustDoChatWrapper ref={ref} />);
  await waitFor(() => expect(connect).toHaveBeenCalled());
  const handle = ref.current!;
  await handle.sendMessage('ready');
  expect(send).toHaveBeenCalledOnce();

  fixture.session = { ...fixture.session, branchCreationPending: true };
  view.rerender(<JustDoChatWrapper ref={ref} />);
  await expect(handle.sendMessage('pending')).rejects.toThrow('coworkBranchCreationPending');
  expect(send).toHaveBeenCalledOnce();

  fixture.session = { ...fixture.session, branchCreationPending: false };
  view.rerender(<JustDoChatWrapper ref={ref} />);
  await handle.sendMessage('confirmed');
  expect(send).toHaveBeenCalledTimes(2);
});

it('shows initial history loading immediately, including an empty running session', async () => {
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
  });
  render(<JustDoChatWrapper />);
  expect(screen.getByText('storageHistoryLoading')).toBeTruthy();
  const loadingDots = screen.getByRole('status').querySelectorAll('[aria-hidden="true"] > span');
  expect(loadingDots).toHaveLength(3);
  loadingDots.forEach((dot, index) => {
    expect(dot.classList.contains('animate-bounce')).toBe(true);
    expect(dot.classList.contains('motion-reduce:animate-bounce')).toBe(true);
    expect((dot as HTMLElement).style.animationDelay).toBe(`${index * 150}ms`);
  });
  await waitFor(() => expect(connect).toHaveBeenCalled());
  const controller = connect.mock.instances[0] as ChatController;
  const publish = () => (controller as unknown as { notify(): void }).notify();
  act(() => {
    controller.state.chatLoading = true;
    controller.state.chatSending = true;
    publish();
  });
  expect(screen.getByText('storageHistoryLoading')).toBeTruthy();
  act(() => {
    controller.state.chatLoading = false;
    controller.state.initialHistoryReady = true;
    publish();
  });
  expect(screen.queryByRole('status')).toBeNull();
});

it.each(['getPort', 'getToken'] as const)(
  'keeps cold-connection loading bound to selection while %s is pending', async method => {
    let finish!: (value: never) => void;
    vi.mocked(window.electron.openclaw.engine[method]).mockImplementationOnce(
      () => new Promise(resolve => { finish = resolve; }),
    );
    const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
      this: ChatController,
    ) { this.state.connected = true; });
    fixture.session = null as never;
    const view = render(<JustDoChatWrapper />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(screen.queryByRole('status')).toBeNull();
    fixture.session = { id: 'first', agentId: 'main' };
    view.rerender(<JustDoChatWrapper />);
    expect(screen.getByText('storageHistoryLoading')).toBeTruthy();
    fixture.session = { id: 'second', agentId: 'main' };
    view.rerender(<JustDoChatWrapper />);
    expect(screen.getByText('storageHistoryLoading')).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
    await act(async () => finish({ success: true, port: 1, token: 'fixture' } as never));
    await waitFor(() => expect(connect).toHaveBeenCalled());
    expect((connect.mock.instances[0] as ChatController).state.sessionKey).toBe('agent:main:justdo:second');
  },
);

it.each([false, true])('resets ready history before painting a new session (disconnected=%s)', async disconnected => {
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    this.state.initialHistoryReady = true;
    this.state.chatMessages = [{ role: 'user', content: 'Previous history' }];
    (this as unknown as { notify(): void }).notify();
  });
  const view = render(<JustDoChatWrapper />);
  await waitFor(() => expect(connect).toHaveBeenCalled());
  const controller = connect.mock.instances[0] as ChatController;
  expect(screen.queryByRole('status')).toBeNull();
  if (disconnected) controller.state.connected = false;
  fixture.session = { id: 'other', agentId: 'main' };
  view.rerender(<JustDoChatWrapper />);
  expect(controller.state.sessionKey).toBe('agent:main:justdo:other');
  expect(controller.state.initialHistoryReady).toBe(false);
  expect(controller.state.chatMessages).toEqual([]);
  expect(screen.getByText('storageHistoryLoading')).toBeTruthy();
});

it.each(['cached', 'new-turn'])('keeps visible %s content ahead of the history notice', async mode => {
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) { this.state.connected = true; });
  render(<JustDoChatWrapper />);
  await waitFor(() => expect(connect).toHaveBeenCalled());
  const controller = connect.mock.instances[0] as ChatController;
  const publish = () => (controller as unknown as { notify(): void }).notify();
  act(() => {
    controller.state.chatLoading = true;
    if (mode === 'new-turn') controller.setPendingUserMessage('new conversation');
    else controller.state.chatMessages = [{ role: 'user', content: 'Visible history' }];
    publish();
  });
  expect(screen.queryByRole('status')).toBeNull();
});
