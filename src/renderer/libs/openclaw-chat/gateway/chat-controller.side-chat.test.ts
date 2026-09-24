import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('requests speech through the app bridge without a Gateway connection', async () => {
  const controller = new ChatController();
  const response = {
    audioBase64: 'UklGRg==',
    provider: 'tts-local-cli',
    outputFormat: 'wav',
  };
  const request = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('window', { electron: { speechSynthesis: { speak: request } } });

  await expect(controller.speak('你好')).resolves.toEqual(response);
  expect(request).toHaveBeenCalledWith('你好');
});

test('sends /btw as an isolated side-chat turn without changing main chat state', async () => {
  const controller = new ChatController();
  const request = vi.fn().mockResolvedValue({ runId: 'btw-run-1', status: 'accepted' });
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.currentSessionId = 'gateway-session-1';

  await expect(controller.sendSideQuestion('what changed?', 'btw-run-1')).resolves.toBe(
    'btw-run-1',
  );

  expect(request).toHaveBeenCalledWith('chat.send', {
    sessionKey: 'agent:main:justdo:session-1',
    sessionId: 'gateway-session-1',
    message: '/btw what changed?',
    deliver: false,
    justdoUserInitiated: true,
    idempotencyKey: 'btw-run-1',
  });
  expect(controller.state.chatSending).toBe(false);
  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.transcript.activeTurn).toBeNull();
});

test('keeps side-chat agent streams out of the main transcript', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ runId: 'btw-run-1', status: 'accepted' }),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  await controller.sendSideQuestion('what changed?', 'btw-run-1');
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'btw-run-1',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });
  handleEvent({
    event: 'agent',
    payload: {
      session: sessionKey,
      runId: 'btw-run-1',
      seq: 2,
      stream: 'assistant',
      data: { text: 'side-only answer' },
    },
  });

  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(controller.state.chatSending).toBe(false);
});

test('publishes side-chat Thinking, Tool, and Content through an isolated transcript', async () => {
  const sessionKey = 'agent:main:justdo:session-1';
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ runId: 'btw-run-1', status: 'accepted' }),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  const streamListener = vi.fn();
  controller.onSideChatStream(streamListener);
  await controller.sendSideQuestion('what changed?', 'btw-run-1');
  const handleEvent = (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent.bind(controller);

  for (const payload of [
    {
      session: sessionKey,
      runId: 'btw-run-1',
      seq: 1,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
    {
      session: sessionKey,
      runId: 'btw-run-1',
      seq: 2,
      stream: 'thinking',
      data: { text: 'Inspect the current context.' },
    },
    {
      session: sessionKey,
      runId: 'btw-run-1',
      seq: 3,
      stream: 'tool',
      data: { phase: 'start', toolCallId: 'read-1', name: 'read', args: { path: 'README.md' } },
    },
    {
      session: sessionKey,
      runId: 'btw-run-1',
      seq: 4,
      stream: 'assistant',
      data: { text: 'The side answer is streaming.' },
    },
  ]) {
    handleEvent({ event: 'agent', payload });
  }

  const streamCallCountAfterAssistantSnapshot = streamListener.mock.calls.length;
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey,
      runId: 'btw-run-1',
      state: 'delta',
      deltaText: 'The side answer is streaming.',
    },
  });
  handleEvent({
    event: 'chat',
    payload: {
      sessionKey,
      runId: 'btw-run-1',
      state: 'delta',
      deltaText: 'The side answer is streaming.',
    },
  });

  const latest = streamListener.mock.calls[streamListener.mock.calls.length - 1]?.[0];
  expect(streamListener).toHaveBeenCalledTimes(streamCallCountAfterAssistantSnapshot);
  expect(latest).toMatchObject({
    runId: 'btw-run-1',
    sessionKey,
    kind: 'stream',
    turn: {
      runId: 'btw-run-1',
      status: 'running',
      items: [
        { type: 'thinking', text: 'Inspect the current context.' },
        { type: 'tool', toolCallId: 'read-1', name: 'read', status: 'running' },
        { type: 'content', text: 'The side answer is streaming.' },
      ],
    },
  });
  expect(controller.state.chatMessages).toEqual([]);
  expect(controller.state.transcript.activeTurn).toBeNull();
  expect(controller.state.chatSending).toBe(false);
});

test.each(['error', 'aborted', 'final'] as const)(
  'settles a side question when chat.%s arrives without a side result',
  async state => {
    const sessionKey = 'agent:main:justdo:session-1';
    const controller = new ChatController();
    controller.state.client = {
      request: vi.fn().mockResolvedValue({ runId: 'btw-run-1', status: 'accepted' }),
    } as never;
    controller.state.connected = true;
    controller.state.sessionKey = sessionKey;
    const listener = vi.fn();
    controller.onSideChatResult(listener);
    await controller.sendSideQuestion('what changed?', 'btw-run-1');

    (
      controller as unknown as {
        handleEvent(event: { event: string; payload: unknown }): void;
      }
    ).handleEvent({
      event: 'chat',
      payload: {
        sessionKey,
        runId: 'btw-run-1',
        state,
        ...(state === 'error' ? { errorMessage: 'provider failed' } : {}),
      },
    });

    expect(listener).toHaveBeenCalledWith({
      runId: 'btw-run-1',
      sessionKey,
      question: 'what changed?',
      text: state === 'error' ? 'provider failed' : '',
      isError: true,
    });
    expect(controller.state.transcript.activeTurn).toBeNull();
  },
);

test('settles pending side questions when the Gateway connection closes', async () => {
  const controller = new ChatController();
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ runId: 'btw-run-1', status: 'accepted' }),
  } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  const listener = vi.fn();
  controller.onSideChatResult(listener);
  await controller.sendSideQuestion('what changed?', 'btw-run-1');

  (controller as unknown as { handleClose(): void }).handleClose();

  expect(listener).toHaveBeenCalledWith(
    expect.objectContaining({ runId: 'btw-run-1', text: '', isError: true }),
  );
});

test('folds multiline side questions before sending them to OpenClaw', async () => {
  const request = vi.fn().mockResolvedValue({ runId: 'btw-run-1', status: 'accepted' });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendSideQuestion('first line\n  second line', 'btw-run-1');

  expect(request).toHaveBeenCalledWith(
    'chat.send',
    expect.objectContaining({ message: '/btw first line second line' }),
  );
});
