import { expect, test } from 'vitest';

import { ChatController } from './chat-controller';

test('clears active sending state when switching between existing sessions', async () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:running-session';
  controller.setPendingUserMessage('keep working');

  await controller.switchSession('agent:main:justdo:other-session');

  expect(controller.state.sessionKey).toBe('agent:main:justdo:other-session');
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.pendingUserMessage).toBeNull();
  expect(controller.state.chatLoading).toBe(true);
});

test('preserves optimistic prompt when promoting a temp session to a persisted session', async () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:temp-123';
  controller.setPendingUserMessage('start this task');

  await controller.switchSession('agent:main:justdo:persisted-session');

  expect(controller.state.sessionKey).toBe('agent:main:justdo:persisted-session');
  expect(controller.state.chatSending).toBe(true);
  expect(controller.state.pendingUserMessage?.content).toBe('start this task');
  expect(controller.state.chatLoading).toBe(true);
});

test('clears live overlays before the post-final history refresh', () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatSending = true;
  controller.state.chatRunId = 'run-1';
  controller.state.chatMessages = [
    {
      role: 'assistant',
      content: 'previous content',
      timestamp: 1000,
    },
  ];
  controller.state.chatThinkingMessages = [
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'thinking 1' }],
      timestamp: 1100,
      __openclawLiveThinking: true,
    },
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'thinking 2' }],
      timestamp: 1300,
      __openclawLiveThinking: true,
    },
  ];
  controller.state.chatToolMessages = [
    {
      role: 'assistant',
      toolCallId: 'tool-1',
      toolName: 'Read',
      timestamp: 1200,
      content: [{ type: 'toolcall', toolCallId: 'tool-1', name: 'Read' }],
    },
    {
      role: 'assistant',
      toolCallId: 'tool-2',
      toolName: 'Write',
      timestamp: 1400,
      content: [{ type: 'toolcall', toolCallId: 'tool-2', name: 'Write' }],
    },
  ];
  controller.state.chatStreamSegments = [
    { text: 'content 1', ts: 1250 },
    { text: 'content 2', ts: 1450 },
  ];
  controller.state.chatStream = 'final content';
  controller.state.chatThinkingStream = 'thinking 3';

  (
    controller as unknown as {
      handleFinal(payload: {
        sessionKey: string;
        state: 'final';
        runId: string;
        message: unknown;
      }): void;
    }
  ).handleFinal({
    sessionKey: 'agent:main:justdo:session-1',
    state: 'final',
    runId: 'run-1',
    message: {
      role: 'assistant',
      content: 'final content',
      timestamp: 1500,
    },
  });

  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatStream).toBeNull();
  expect(controller.state.chatThinkingStream).toBeNull();
  expect(controller.state.chatThinkingMessages).toHaveLength(0);
  expect(controller.state.chatToolMessages).toHaveLength(0);
  expect(controller.state.chatStreamSegments).toHaveLength(0);
});

test('merges later non-empty tool arguments over an earlier empty tool call', () => {
  const controller = new ChatController();
  const merged = (
    controller as unknown as {
      mergeToolMessageContent(existingContent: unknown, nextContent: unknown): unknown[];
    }
  ).mergeToolMessageContent(
    [
      {
        type: 'toolcall',
        toolCallId: 'tool-1',
        name: 'exec',
        arguments: {},
      },
    ],
    [
      {
        type: 'toolcall',
        toolCallId: 'tool-1',
        name: 'exec',
        arguments: { command: 'Remove-Item tmp.js', timeout: 5 },
      },
      {
        type: 'toolresult',
        toolCallId: 'tool-1',
        name: 'exec',
        text: '(no output)',
      },
    ],
  );

  expect((merged[0] as Record<string, unknown>).arguments).toEqual({
    command: 'Remove-Item tmp.js',
    timeout: 5,
  });
  expect((merged[1] as Record<string, unknown>).text).toBe('(no output)');
});
