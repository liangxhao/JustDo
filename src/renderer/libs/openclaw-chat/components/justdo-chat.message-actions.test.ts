/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import type { JustDoChatElement } from './justdo-chat';

function notifyController(controller: ChatController): void {
  (controller as unknown as { notify(): void }).notify();
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('justdo-chat last user message actions', () => {
  test('only exposes actions for the latest persisted user message while idle', async () => {
    const controller = new ChatController();
    const messages = [
      {
        role: 'user',
        content: 'first prompt',
        timestamp: 1,
        __openclaw: { id: 'user-1', seq: 1 },
      },
      {
        role: 'assistant',
        content: 'first reply',
        timestamp: 2,
        __openclaw: { id: 'assistant-1', seq: 2 },
      },
      {
        role: 'user',
        content: 'latest prompt',
        timestamp: 3,
        __openclaw: { id: 'user-2', seq: 3 },
      },
      {
        role: 'assistant',
        content: 'latest reply',
        timestamp: 4,
        __openclaw: { id: 'assistant-2', seq: 4 },
      },
    ];
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    controller.state.connected = true;
    (
      controller as unknown as {
        setCurrentSessionMessages(
          messages: unknown[],
          options: { resetLoadedHistory: boolean },
        ): void;
      }
    ).setCurrentSessionMessages(messages, { resetLoadedHistory: true });
    const onAction = vi.fn().mockResolvedValue(true);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    chat.onLastUserMessageAction = onAction;
    document.body.append(chat);
    await chat.updateComplete;

    const buttons = chat.shadowRoot?.querySelectorAll<HTMLButtonElement>('.user-message-action');
    const actions = chat.shadowRoot?.querySelector<HTMLElement>('.user-message-actions');
    expect(buttons).toHaveLength(2);
    expect(actions).not.toBeNull();
    expect(getComputedStyle(actions as HTMLElement).pointerEvents).toBe('auto');
    buttons?.[0]?.click();
    await chat.updateComplete;
    expect(onAction).not.toHaveBeenCalled();
    const editor = chat.shadowRoot?.querySelector<HTMLTextAreaElement>(
      '.user-message-editor__input',
    );
    expect(editor?.value).toBe('latest prompt');

    editor!.value = 'corrected prompt';
    editor!.dispatchEvent(new InputEvent('input', { bubbles: true }));
    chat.shadowRoot?.querySelector<HTMLButtonElement>('.user-message-editor__submit')?.click();
    await vi.waitFor(() => {
      expect(onAction).toHaveBeenCalledWith('edit', 'user-2', 'corrected prompt');
    });
    await chat.updateComplete;
    expect(chat.shadowRoot?.querySelector('.user-message-editor')).toBeNull();

    controller.state.chatSending = true;
    notifyController(controller);
    await chat.updateComplete;
    expect(chat.shadowRoot?.querySelectorAll('.user-message-action')).toHaveLength(0);
  });

  test('cancels inline editing without mutating message history', async () => {
    const controller = new ChatController();
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    controller.state.connected = true;
    (
      controller as unknown as {
        setCurrentSessionMessages(
          messages: unknown[],
          options: { resetLoadedHistory: boolean },
        ): void;
      }
    ).setCurrentSessionMessages(
      [{ role: 'user', content: 'original', __openclaw: { id: 'user-1' } }],
      { resetLoadedHistory: true },
    );
    const onAction = vi.fn().mockResolvedValue(true);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    chat.onLastUserMessageAction = onAction;
    document.body.append(chat);
    await chat.updateComplete;

    chat.shadowRoot?.querySelector<HTMLButtonElement>('.user-message-action')?.click();
    await chat.updateComplete;
    chat.shadowRoot
      ?.querySelector<HTMLButtonElement>('.user-message-editor__actions button')
      ?.click();
    await chat.updateComplete;

    expect(onAction).not.toHaveBeenCalled();
    expect(chat.shadowRoot?.querySelector('.user-message-editor')).toBeNull();
    expect(chat.shadowRoot?.textContent).toContain('original');
  });

  test('offers assistant fork only after the latest Plan reset', async () => {
    const controller = new ChatController();
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    controller.state.connected = true;
    (
      controller as unknown as {
        setCurrentSessionMessages(
          messages: unknown[],
          options: { resetLoadedHistory: boolean },
        ): void;
      }
    ).setCurrentSessionMessages(
      [
        {
          role: 'user',
          content: 'plan this',
          runId: 'plan-run',
          __openclaw: { id: 'planning-user' },
        },
        {
          role: 'assistant',
          content: 'the plan',
          runId: 'plan-run',
          __openclaw: { id: 'planning-assistant' },
        },
        {
          role: 'system',
          content: '',
          __openclaw: { id: 'plan-reset', kind: 'reset', planImplementation: true },
        },
        {
          role: 'user',
          content: 'implementation prompt',
          runId: 'implementation-run',
          __openclaw: { id: 'implementation-user' },
        },
        {
          role: 'assistant',
          content: 'implementation result',
          runId: 'implementation-run',
          __openclaw: { id: 'implementation-assistant' },
        },
      ],
      { resetLoadedHistory: true },
    );
    const onFork = vi.fn().mockResolvedValue(true);
    const onAction = vi.fn().mockResolvedValue(true);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    chat.runTimings = [
      {
        id: 'plan-timing',
        sessionId: 'session-1',
        clientTurnId: 'plan-run',
        rootRunId: 'plan-run',
        startedAt: 1,
        endedAt: 2,
        state: 'completed',
      },
      {
        id: 'implementation-timing',
        sessionId: 'session-1',
        clientTurnId: 'implementation-run',
        rootRunId: 'implementation-run',
        startedAt: 3,
        endedAt: 4,
        state: 'completed',
      },
    ];
    chat.onAssistantMessageFork = onFork;
    chat.onLastUserMessageAction = onAction;
    document.body.append(chat);
    await chat.updateComplete;

    expect(chat.shadowRoot?.querySelectorAll('.user-message-action--edit')).toHaveLength(1);
    expect(chat.shadowRoot?.querySelectorAll('.user-message-action--withdraw')).toHaveLength(1);
    const forkButtons = chat.shadowRoot?.querySelectorAll<HTMLButtonElement>(
      '.assistant-message-action--fork',
    );
    expect(forkButtons).toHaveLength(1);
    forkButtons?.[0]?.click();
    expect(onFork).toHaveBeenCalledWith('implementation-assistant');
    const scrollIntoView = vi.fn();
    const sourceRow = [
      ...(chat.shadowRoot?.querySelectorAll<HTMLElement>('.chat-history-row') ?? []),
    ].find(row => row.dataset.entryId === 'implementation-assistant');
    Object.defineProperty(sourceRow!, 'scrollIntoView', { value: scrollIntoView });

    expect(chat.revealMessage('implementation-assistant')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
  });

  test('hides edit and withdraw when native Plan history resets before implementation', async () => {
    const controller = new ChatController();
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    controller.state.connected = true;
    (
      controller as unknown as {
        setCurrentSessionMessages(
          messages: unknown[],
          options: { resetLoadedHistory: boolean },
        ): void;
      }
    ).setCurrentSessionMessages(
      [
        { role: 'user', content: 'plan this', __openclaw: { id: 'planning-user' } },
        {
          role: 'assistant',
          content: [
            { type: 'toolcall', name: 'PresentPlan', input: { plan: 'Implementation plan' } },
          ],
          __openclaw: { id: 'planning-assistant' },
        },
        {
          role: 'system',
          content: '',
          __openclaw: { id: 'plan-reset', kind: 'reset' },
        },
        { role: 'assistant', content: 'implementation finished', __openclaw: { id: 'result' } },
      ],
      { resetLoadedHistory: true },
    );
    const onAction = vi.fn().mockResolvedValue(true);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    chat.onLastUserMessageAction = onAction;
    document.body.append(chat);
    await chat.updateComplete;

    expect(chat.shadowRoot?.querySelector('.user-message-action--edit')).toBeNull();
    expect(chat.shadowRoot?.querySelector('.user-message-action--withdraw')).toBeNull();
  });

  test('offers fork after every completed assistant response in a normal session', async () => {
    const controller = new ChatController();
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    controller.state.connected = true;
    (
      controller as unknown as {
        setCurrentSessionMessages(
          messages: unknown[],
          options: { resetLoadedHistory: boolean },
        ): void;
      }
    ).setCurrentSessionMessages(
      [
        {
          role: 'user',
          content: 'first',
          __openclaw: { id: 'user-1', runId: 'run-1' },
        },
        {
          role: 'assistant',
          content: 'reply',
          __openclaw: { id: 'assistant-1', runId: 'run-1' },
        },
        {
          role: 'user',
          content: 'second',
          __openclaw: { id: 'user-2', runId: 'run-2' },
        },
        {
          role: 'assistant',
          content: 'second reply',
          __openclaw: { id: 'assistant-2', runId: 'run-2' },
        },
      ],
      { resetLoadedHistory: true },
    );
    const onFork = vi.fn();
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    chat.runTimings = [
      {
        id: 'timing-1',
        sessionId: 'session-1',
        clientTurnId: 'run-1',
        rootRunId: 'run-1',
        startedAt: 1,
        endedAt: 2,
        state: 'completed',
      },
      {
        id: 'timing-2',
        sessionId: 'session-1',
        clientTurnId: 'run-2',
        rootRunId: 'run-2',
        startedAt: 3,
        endedAt: 4,
        state: 'completed',
      },
    ];
    chat.onAssistantMessageFork = onFork;
    document.body.append(chat);
    await chat.updateComplete;

    const forkButtons = chat.shadowRoot?.querySelectorAll<HTMLButtonElement>(
      '.assistant-message-action--fork',
    );
    expect(forkButtons).toHaveLength(2);
    forkButtons?.[0]?.click();
    forkButtons?.[1]?.click();
    expect(onFork).toHaveBeenNthCalledWith(1, 'assistant-1');
    expect(onFork).toHaveBeenNthCalledWith(2, 'assistant-2');
  });

  test.each(['aborted', 'failed'] as const)(
    'does not offer fork after an %s assistant run',
    async state => {
      const controller = new ChatController();
      controller.state.sessionKey = 'agent:main:justdo:session-1';
      controller.state.connected = true;
      (
        controller as unknown as {
          setCurrentSessionMessages(
            messages: unknown[],
            options: { resetLoadedHistory: boolean },
          ): void;
        }
      ).setCurrentSessionMessages(
        [
          { role: 'user', content: 'try this', runId: 'run-1', __openclaw: { id: 'user-1' } },
          {
            role: 'assistant',
            content: 'partial result',
            runId: 'run-1',
            __openclaw: { id: 'assistant-1' },
          },
        ],
        { resetLoadedHistory: true },
      );
      const chat = document.createElement('justdo-chat') as JustDoChatElement;
      chat.controller = controller;
      chat.runTimings = [
        {
          id: 'timing-1',
          sessionId: 'session-1',
          clientTurnId: 'run-1',
          rootRunId: 'run-1',
          startedAt: 1,
          endedAt: 2,
          state,
        },
      ];
      chat.onAssistantMessageFork = vi.fn();
      document.body.append(chat);
      await chat.updateComplete;

      expect(chat.shadowRoot?.querySelector('.assistant-message-action--fork')).toBeNull();
    },
  );

  test('allows a completed assistant response to fork before Plan implementation starts', async () => {
    const controller = new ChatController();
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    controller.state.connected = true;
    (
      controller as unknown as {
        setCurrentSessionMessages(
          messages: unknown[],
          options: { resetLoadedHistory: boolean },
        ): void;
      }
    ).setCurrentSessionMessages(
      [
        {
          role: 'user',
          content: 'plan this',
          runId: 'plan-run',
          __openclaw: { id: 'planning-user' },
        },
        {
          role: 'assistant',
          content: 'draft plan',
          runId: 'plan-run',
          __openclaw: { id: 'planning-assistant' },
        },
      ],
      { resetLoadedHistory: true },
    );
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    chat.runTimings = [
      {
        id: 'plan-timing',
        sessionId: 'session-1',
        clientTurnId: 'plan-run',
        rootRunId: 'plan-run',
        startedAt: 1,
        endedAt: 2,
        state: 'completed',
      },
    ];
    chat.onAssistantMessageFork = vi.fn();
    document.body.append(chat);
    await chat.updateComplete;

    expect(chat.shadowRoot?.querySelectorAll('.assistant-message-action--fork')).toHaveLength(1);
  });

  test('uses loaded history for a Plan reset outside the visible history window', async () => {
    const controller = new ChatController();
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    controller.state.connected = true;
    const messages = [
      {
        role: 'user',
        content: 'old planning prompt',
        __openclaw: { id: 'planning-user', runId: 'planning-run' },
      },
      {
        role: 'assistant',
        content: 'old planning reply',
        __openclaw: { id: 'planning-assistant', runId: 'planning-run' },
      },
      ...Array.from({ length: 788 }, (_, index) => ({
        role: 'system',
        content: '',
        __openclaw: { id: `filler-${index}` },
      })),
      {
        role: 'system',
        content: '',
        __openclaw: { id: 'plan-reset', kind: 'reset', planImplementation: true },
      },
      {
        role: 'user',
        content: 'implementation prompt',
        __openclaw: { id: 'implementation-user', runId: 'implementation-run' },
      },
    ];
    (
      controller as unknown as {
        setCurrentSessionMessages(
          messages: unknown[],
          options: { resetLoadedHistory: boolean },
        ): void;
      }
    ).setCurrentSessionMessages(messages, { resetLoadedHistory: true });
    controller.state.historyWindowStart = 0;
    controller.state.historyWindowEnd = 750;
    controller.state.visibleChatMessages = messages.slice(0, 750);

    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    chat.runTimings = [
      {
        id: 'planning-timing',
        sessionId: 'session-1',
        clientTurnId: 'planning-run',
        rootRunId: 'planning-run',
        startedAt: 1,
        endedAt: 2,
        state: 'completed',
      },
    ];
    chat.onAssistantMessageFork = vi.fn();
    document.body.append(chat);
    await chat.updateComplete;

    expect(chat.shadowRoot?.textContent).toContain('old planning reply');
    expect(chat.shadowRoot?.querySelector('.assistant-message-action--fork')).toBeNull();
  });

  test('does not expose actions while disconnected or when the latest user entry is pending', async () => {
    const controller = new ChatController();
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    const setMessages = (messages: unknown[]) =>
      (
        controller as unknown as {
          setCurrentSessionMessages(
            messages: unknown[],
            options: { resetLoadedHistory: boolean },
          ): void;
        }
      ).setCurrentSessionMessages(messages, { resetLoadedHistory: true });
    setMessages([{ role: 'user', content: 'persisted', __openclaw: { id: 'persisted-user' } }]);
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    chat.onLastUserMessageAction = vi.fn();
    document.body.append(chat);
    await chat.updateComplete;
    expect(chat.shadowRoot?.querySelectorAll('.user-message-action')).toHaveLength(0);

    controller.state.connected = true;
    setMessages([
      { role: 'user', content: 'persisted', __openclaw: { id: 'persisted-user' } },
      { role: 'user', content: 'pending', __openclaw: { kind: 'pending-send' } },
    ]);
    notifyController(controller);
    await chat.updateComplete;
    expect(chat.shadowRoot?.querySelectorAll('.user-message-action')).toHaveLength(0);
  });
});

test('offline full-output requests finish immediately and remain retryable', async () => {
  const controller = new ChatController();
  const request = vi.fn();
  controller.state.client = { request } as unknown as NonNullable<typeof controller.state.client>;
  controller.state.sessionKey = 'agent:main:justdo:offline';
  controller.state.connected = false;
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;
  const complete = vi.fn();
  chat.dispatchEvent(
    new CustomEvent('tool-output-request', {
      detail: { runId: 'r', toolCallId: 't', messageId: 'm', isCurrent: () => true, complete },
    }),
  );
  expect(complete).toHaveBeenCalledWith(null);
  expect(request).not.toHaveBeenCalled();
});

test('discards full-output responses after the native session identity changes', async () => {
  const controller = new ChatController();
  let resolveRequest!: (value: unknown) => void;
  const request = vi.fn(
    () =>
      new Promise(resolve => {
        resolveRequest = resolve;
      }),
  );
  controller.state.client = { request } as unknown as NonNullable<typeof controller.state.client>;
  controller.state.sessionKey = 'agent:main:justdo:reset';
  controller.state.currentSessionId = 'old-session';
  controller.state.connected = true;
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;
  const complete = vi.fn();
  chat.dispatchEvent(
    new CustomEvent('tool-output-request', {
      detail: { runId: 'r', toolCallId: 't', messageId: 'm', isCurrent: () => true, complete },
    }),
  );
  expect(request).toHaveBeenCalledTimes(1);
  controller.state.currentSessionId = 'new-session';
  resolveRequest({
    ok: true,
    message: { role: 'toolResult', toolCallId: 't', content: 'old output' },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(complete).not.toHaveBeenCalled();
});
