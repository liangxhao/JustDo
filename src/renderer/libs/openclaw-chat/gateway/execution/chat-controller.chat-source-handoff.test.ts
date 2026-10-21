import { afterEach, expect, test, vi } from 'vitest';

import type { AssistantTurn } from '../../model/chat-transcript-state';
import { projectTurnItems } from '../../model/timeline/project-turn-items';
import { ChatController } from '../chat-controller';

const sessionKey = 'agent:main:chat-source-handoff';
const sessionId = 'physical-chat-source-handoff';
const lifecycleGeneration = 'lifecycle-chat-source-handoff';
const runId = 'run-chat-source-handoff';
const scope = { id: 'message-source-handoff' };
const controllers: ChatController[] = [];

function setup() {
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = sessionId;
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = sessionId;
  controller.state.initialHistoryReady = true;
  const internal = controller as unknown as {
    handleEvent(event: { event: string; payload: unknown }): void;
  };
  const emit = (seq: number, stream: string, data: Record<string, unknown>) =>
    internal.handleEvent({
      event: 'agent',
      payload: {
        sessionKey,
        sessionId,
        lifecycleGeneration,
        runId,
        seq,
        ts: 1_000 + seq,
        stream,
        data,
      },
    });
  const chat = (seq: number, text: string, replace = false) =>
    internal.handleEvent({
      event: 'chat',
      payload: {
        sessionKey,
        sessionId,
        lifecycleGeneration,
        runId,
        seq,
        state: 'delta',
        replace,
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      },
    });
  const contents = () =>
    projectTurnItems(controller.state.transcript.activeTurn).flatMap(item =>
      item.kind === 'content' ? [item.item.text] : [],
    );
  const assistant = (seq: number, data: Record<string, unknown>) =>
    emit(seq, 'assistant', { itemId: 'reply-handoff', assistantTextScope: scope, ...data });
  return { controller, emit, chat, assistant, contents };
}

function prepareRecovery(controller: ChatController) {
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>(accept => {
    resolve = accept;
  });
  const request = vi.fn(() => response);
  const client = { generation: 1, request, stop: vi.fn() };
  controller.state.client = client as never;
  controller.state.connected = true;
  return { request, client, resolve };
}

function recoverySnapshot(seq: number, text?: string) {
  return {
    sessionKey,
    sessionId,
    sessionInfo: {
      key: sessionKey,
      sessionId,
      hasActiveRun: true,
      activeRunIds: [runId],
    },
    inFlightRun: {
      runId,
      events: [
        {
          sessionKey,
          sessionId,
          lifecycleGeneration,
          runId,
          seq,
          ts: 1_000 + seq,
          stream: 'assistant',
          data: {
            itemId: 'reply-handoff',
            assistantTextScope: scope,
            assistantTextSnapshot: true,
            replace: true,
            ...(text === undefined ? {} : { text }),
          },
        },
      ],
    },
  };
}

async function flushResponses() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
});

test.each([false, true])(
  'keeps a newer Chat preview until its Agent baseline catches up (background: %s)',
  async background => {
    const { controller, emit, chat, assistant, contents } = setup();
    emit(253, 'thinking', { text: 'Check document structure.' });
    chat(256, 'The document');
    chat(257, 'The document is ready.');
    if (background) await controller.switchSession('agent:main:handoff-background');
    emit(255, 'thinking', { text: 'Check document structure and retry.' });
    assistant(256, { text: 'The document', delta: 'The document' });
    if (background) await controller.switchSession(sessionKey);
    expect(contents()).toEqual(['The document is ready.']);
    assistant(257, { delta: ' is ready.' });
    expect(contents()).toEqual(['The document is ready.']);
    assistant(259, { delta: ' Continue.' });
    expect(contents()).toEqual(['The document is ready. Continue.']);
  },
);

test('replaces a coalesced Chat preview atomically after earlier Agent text catches up', () => {
  const { emit, chat, assistant, contents } = setup();
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(257, 'The document is ready.');
  emit(255, 'thinking', { text: 'Check document structure and retry.' });
  assistant(256, { text: 'The document', delta: 'The document' });
  expect(contents()).toEqual(['The document is ready.']);
  assistant(257, { delta: ' is ready.' });
  expect(contents()).toEqual(['The document is ready.']);
});

test('does not display a Chat preview twice when native commentary arrives before its assistant baseline', () => {
  const { emit, chat, contents } = setup();
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(257, 'The document is ready.');
  emit(261, 'item', {
    kind: 'preamble',
    phase: 'update',
    itemId: 'commentary-handoff',
    assistantTextScope: scope,
    progressText: 'The document is ready.',
  });
  expect(contents()).toEqual(['The document is ready.']);
});

test('continues an unkeyed Agent stream after an initial Chat fallback', () => {
  const { emit, chat, contents } = setup();
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(256, 'The document');
  emit(256, 'assistant', { text: 'The document' });
  expect(contents()).toEqual(['The document']);
  emit(257, 'assistant', { text: 'The document is ready.' });
  expect(contents()).toEqual(['The document is ready.']);
});

test('keeps adopting newer Chat previews while an unkeyed Agent baseline still trails them', () => {
  const { emit, chat, contents } = setup();
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(257, 'The document is ready.');
  emit(256, 'assistant', { text: 'The document' });
  expect(contents()).toEqual(['The document is ready.']);
  chat(258, 'The document is ready. Continue.');
  expect(contents()).toEqual(['The document is ready. Continue.']);
  emit(258, 'assistant', { text: 'The document is ready. Continue.' });
  expect(contents()).toEqual(['The document is ready. Continue.']);
});

test.each([
  { route: 'foreground', empty: false },
  { route: 'foreground', empty: true },
  { route: 'background', empty: false },
  { route: 'background', empty: true },
  { route: 'side-chat', empty: false },
  { route: 'side-chat', empty: true },
])(
  'keeps Chat streaming after an initial Agent identity without visible text: %j',
  async params => {
    const { controller, emit, chat, assistant, contents } = setup();
    let latestSideTurn: AssistantTurn | null = null;
    if (params.route === 'side-chat') {
      controller.state.client = {
        generation: 1,
        request: vi.fn().mockResolvedValue({ runId, status: 'accepted' }),
        stop: vi.fn(),
      } as never;
      controller.state.connected = true;
      controller.onSideChatStream(update => {
        latestSideTurn = update.turn;
      });
      await controller.sendSideQuestion('Check the document?', runId);
    }
    emit(253, 'thinking', { text: 'Check document structure.' });
    if (params.route === 'background') {
      await controller.switchSession('agent:main:handoff-background');
    }
    assistant(254, params.empty ? { text: '', delta: '' } : { assistantTextSnapshot: true });
    chat(256, 'The document');
    chat(257, 'The document is ready.');
    if (params.route === 'background') await controller.switchSession(sessionKey);
    const visible = () =>
      params.route === 'side-chat'
        ? projectTurnItems(latestSideTurn).flatMap(item =>
            item.kind === 'content' ? [item.item.text] : [],
          )
        : contents();
    expect(visible()).toEqual(['The document is ready.']);
    assistant(258, { text: 'The document is ready. Continue.' });
    expect(visible()).toEqual(['The document is ready. Continue.']);
  },
);

test('hands off the isolated side-chat preview without truncating it or affecting the main turn', async () => {
  const { controller, emit, chat, assistant } = setup();
  const request = vi.fn().mockResolvedValue({ runId, status: 'accepted' });
  controller.state.client = { generation: 1, request, stop: vi.fn() } as never;
  controller.state.connected = true;
  let latestTurn: AssistantTurn | null = null;
  controller.onSideChatStream(update => {
    latestTurn = update.turn;
  });
  const visible = () =>
    projectTurnItems(latestTurn).flatMap(item => (item.kind === 'content' ? [item.item.text] : []));
  await controller.sendSideQuestion('Check the document?', runId);
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(257, 'The document is ready.');
  emit(255, 'thinking', { text: 'Check document structure and retry.' });
  assistant(256, { text: 'The document', delta: 'The document' });
  expect(visible()).toEqual(['The document is ready.']);
  assistant(257, { delta: ' is ready.' });
  expect(visible()).toEqual(['The document is ready.']);
  expect(controller.state.transcript.activeTurn).toBeNull();
});

test('recovers a missing initial Agent baseline before adopting a later coalesced delta', async () => {
  const { controller, emit, chat, assistant, contents } = setup();
  const recovery = prepareRecovery(controller);
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(256, 'The document');
  emit(255, 'thinking', { text: 'Check document structure and retry.' });
  assistant(258, { delta: 'The document is ready.' });
  expect(contents()).toEqual(['The document']);
  await vi.waitFor(() =>
    expect(recovery.request).toHaveBeenCalledWith(
      'chat.history',
      { sessionKey, limit: 1 },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    ),
  );
  recovery.resolve(recoverySnapshot(258, 'The document is ready.'));
  await vi.waitFor(() => expect(contents()).toEqual(['The document is ready.']));
  assistant(259, { delta: ' Continue.' });
  expect(contents()).toEqual(['The document is ready. Continue.']);
});

test('recovers a background handoff without changing the selected session', async () => {
  const { controller, emit, chat, assistant, contents } = setup();
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(256, 'The document');
  await controller.switchSession('agent:main:handoff-background');
  const recovery = prepareRecovery(controller);
  assistant(258, { delta: ' is ready.' });
  await vi.waitFor(() => expect(recovery.request).toHaveBeenCalled());
  recovery.resolve(recoverySnapshot(258, 'The document is ready.'));
  await flushResponses();
  expect(controller.state.sessionKey).toBe('agent:main:handoff-background');
  expect(controller.state.transcript.activeTurn).toBeNull();
  controller.state.client = null;
  await controller.switchSession(sessionKey);
  expect(contents()).toEqual(['The document is ready.']);
});

test('recovers an isolated side-chat baseline without publishing its pending delta', async () => {
  const { controller, emit, chat, assistant } = setup();
  controller.state.client = {
    generation: 1,
    request: vi.fn().mockResolvedValue({ runId, status: 'accepted' }),
    stop: vi.fn(),
  } as never;
  controller.state.connected = true;
  let latestTurn: AssistantTurn | null = null;
  controller.onSideChatStream(update => {
    latestTurn = update.turn;
  });
  const visible = () =>
    projectTurnItems(latestTurn).flatMap(item => (item.kind === 'content' ? [item.item.text] : []));
  await controller.sendSideQuestion('Check the document?', runId);
  const recovery = prepareRecovery(controller);
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(256, 'The document');
  assistant(258, { delta: ' is ready.' });
  expect(visible()).toEqual(['The document']);
  await vi.waitFor(() => expect(recovery.request).toHaveBeenCalled());
  recovery.resolve(recoverySnapshot(258, 'The document is ready.'));
  await vi.waitFor(() => expect(visible()).toEqual(['The document is ready.']));
  expect(controller.state.transcript.activeTurn).toBeNull();
});

test('recovers a full owner when a Tool barrier stamps Chat beyond the last text event', async () => {
  const { controller, emit, chat, assistant, contents } = setup();
  const recovery = prepareRecovery(controller);
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(258, 'The document is ready.');
  emit(255, 'thinking', { text: 'Check document structure and retry.' });
  assistant(256, { text: 'The document', delta: 'The document' });
  expect(contents()).toEqual(['The document is ready.']);
  emit(258, 'tool', { phase: 'start', name: 'read', toolCallId: 'document-read' });
  expect(contents()).toEqual(['The document is ready.']);
  await vi.waitFor(() =>
    expect(recovery.request).toHaveBeenCalledWith(
      'chat.history',
      { sessionKey, limit: 1 },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    ),
  );
  recovery.resolve(recoverySnapshot(256, 'The document is ready.'));
  await vi.waitFor(() => expect(contents()).toEqual(['The document is ready.']));
  const turn = controller.state.transcript.activeTurn!;
  const projection = projectTurnItems(turn);
  expect(projection.filter(item => item.kind === 'content')).toHaveLength(1);
  expect(turn.items.find(item => item.type === 'tool')).toMatchObject({
    toolCallId: 'document-read',
    status: 'running',
  });
});

test('keeps the Chat preview when native recovery contains identity without a text baseline', async () => {
  const { controller, emit, chat, assistant, contents } = setup();
  const recovery = prepareRecovery(controller);
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(256, 'The document');
  assistant(258, { delta: ' is ready.' });
  await vi.waitFor(() => expect(recovery.request).toHaveBeenCalled());
  recovery.resolve(recoverySnapshot(258));
  await flushResponses();
  expect(contents()).toEqual(['The document']);
  assistant(259, { text: 'The document is ready.' });
  expect(contents()).toEqual(['The document is ready.']);
});

test('does not treat a metadata-only Agent owner as a visible replacement for Chat text', () => {
  const { emit, chat, assistant, contents } = setup();
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(256, 'The document');
  assistant(258, { assistantTextSnapshot: true });
  expect(contents()).toEqual(['The document']);
  assistant(259, { text: 'The document is ready.' });
  expect(contents()).toEqual(['The document is ready.']);
});

test('retracts both text sources during a pending handoff and rejects covered delayed deltas', () => {
  const { emit, chat, assistant, contents } = setup();
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(257, 'The document is ready.');
  assistant(256, { text: 'The document', delta: 'The document' });
  expect(contents()).toEqual(['The document is ready.']);
  chat(258, '', true);
  expect(contents()).toEqual([]);
  assistant(257, { delta: ' is ready.' });
  expect(contents()).toEqual([]);
  assistant(259, { text: 'The revised document is ready.' });
  expect(contents()).toEqual(['The revised document is ready.']);
});

test('does not invent a later Content sequence when Thinking overtakes a Chat delivery', () => {
  const { controller, emit, chat, assistant, contents } = setup();
  emit(253, 'thinking', { text: 'Before the document.' });
  emit(260, 'thinking', { text: 'After the document.', progressSegmentFirstSeq: 260 });
  chat(256, 'The document');
  assistant(256, { text: 'The document', delta: 'The document' });
  expect(contents()).toEqual(['The document']);
  expect(
    projectTurnItems(controller.state.transcript.activeTurn).flatMap(item =>
      item.kind === 'content'
        ? [['content', item.item.firstSeq]]
        : item.kind === 'process-summary'
          ? item.items.map(process => [process.type, process.firstSeq])
          : item.kind === 'live-process'
            ? [[item.item.type, item.item.firstSeq]]
            : [],
    ),
  ).toEqual([
    ['thinking', 253],
    ['content', 256],
    ['thinking', 260],
  ]);
});

test('does not apply a pending text recovery after the turn was interrupted', async () => {
  const { controller, emit, chat, assistant, contents } = setup();
  const recovery = prepareRecovery(controller);
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(256, 'The document');
  assistant(258, { delta: ' is ready.' });
  await vi.waitFor(() => expect(recovery.request).toHaveBeenCalled());
  (
    controller as unknown as { handleEvent(event: { event: string; payload: unknown }): void }
  ).handleEvent({
    event: 'chat',
    payload: { sessionKey, sessionId, lifecycleGeneration, runId, state: 'aborted' },
  });
  const interruptedText = contents();
  recovery.resolve(recoverySnapshot(258, 'This response arrived after interruption.'));
  await flushResponses();
  expect(contents()).toEqual(interruptedText);
  expect(controller.state.transcript.activeTurn?.status).toBe('aborted');
});

test('does not use rejected message-scope text as proof that the Agent baseline caught up', () => {
  const { emit, chat, assistant, contents } = setup();
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(257, 'The document is ready.');
  assistant(256, { text: 'The document', delta: 'The document' });
  expect(contents()).toEqual(['The document is ready.']);
  assistant(258, {
    text: 'A foreign message must not replace the preview.',
    assistantTextScope: { id: 'foreign-message-source' },
  });
  expect(contents()).toEqual(['The document is ready.']);
});

test.each([
  'run',
  'session',
  'lifecycle',
  'connection',
  'lifecycle-alias',
  'nested-session',
  'nested-lifecycle',
] as const)('rejects a recovery baseline whose %s identity changed', async mismatch => {
  const { controller, emit, chat, assistant, contents } = setup();
  const recovery = prepareRecovery(controller);
  emit(253, 'thinking', { text: 'Check document structure.' });
  chat(256, 'The document');
  assistant(258, { delta: ' is ready.' });
  await vi.waitFor(() => expect(recovery.request).toHaveBeenCalled());
  const response = recoverySnapshot(258, 'A foreign response must never appear.');
  if (mismatch === 'run') response.inFlightRun.runId = 'foreign-run';
  if (mismatch === 'session') response.sessionId = 'foreign-physical-session';
  if (mismatch === 'lifecycle') {
    response.inFlightRun.events[0].lifecycleGeneration = 'foreign-lifecycle';
  }
  if (mismatch === 'connection') recovery.client.generation += 1;
  const event = response.inFlightRun.events[0] as Record<string, unknown>;
  if (mismatch === 'lifecycle-alias') {
    delete event.lifecycleGeneration;
    event.gatewayGeneration = 'foreign-lifecycle';
  }
  if (mismatch === 'nested-session') {
    delete event.sessionId;
    Object.assign(event.data as object, { sessionId: 'foreign-physical-session' });
  }
  if (mismatch === 'nested-lifecycle') {
    delete event.lifecycleGeneration;
    Object.assign(event.data as object, { lifecycleGeneration: 'foreign-lifecycle' });
  }
  recovery.resolve(response);
  await flushResponses();
  expect(contents()).toEqual(['The document']);
  expect(controller.state.transcript.activeTurn?.runId).toBe(runId);
  expect(controller.state.transcript.activeTurn?.sessionId).toBe(sessionId);
  expect(controller.state.transcript.activeTurn?.lifecycleGeneration).toBe(lifecycleGeneration);
});
