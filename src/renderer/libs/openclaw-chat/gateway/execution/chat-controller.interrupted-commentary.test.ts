import { afterEach, expect, test, vi } from 'vitest';

import { projectTurnItems } from '../../model/timeline/project-turn-items';
import { ChatController } from '../chat-controller';
import { extractSnapshotText } from '../chat-controller-support';

const sessionKey = 'agent:main:interrupted-commentary';
const sessionId = 'physical-interrupted-commentary';
const runId = 'run-interrupted-commentary';
const controllers: ChatController[] = [];

afterEach(() => {
  controllers.splice(0).forEach(controller => controller.disconnect());
  vi.unstubAllGlobals();
});

function setup() {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem });
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.currentSessionId = sessionId;
  controller.state.transcript.sessionKey = sessionKey;
  controller.state.transcript.sessionId = sessionId;
  const internal = controller as unknown as {
    handleEvent(event: { event: string; payload: unknown }): void;
  };
  let seq = 0;
  const emit = (stream: string, data: Record<string, unknown>) => internal.handleEvent({
    event: 'agent',
    payload: { sessionKey, sessionId, runId, seq: ++seq, stream, data },
  });
  emit('lifecycle', { phase: 'start' });
  for (const text of ['First step.', 'Second step.']) {
    emit('thinking', { text: `Reasoning for ${text}` });
    emit('item', {
      kind: 'preamble', phase: 'end', itemId: `commentary-${seq}`, progressText: text,
      assistantTextScope: { id: `message-${seq}` },
    });
    emit('tool', { phase: 'start', toolCallId: `tool-${text}`, name: 'read' });
    emit('tool', { phase: 'result', toolCallId: `tool-${text}`, name: 'read', result: 'ok' });
  }
  const abortChat = (message: unknown = {
    role: 'assistant', content: 'First step.Second step.Partial reply.',
  }) => internal.handleEvent({
    event: 'chat',
    payload: { sessionKey, sessionId, runId, state: 'aborted', message },
  });
  const abortLifecycle = () => emit('lifecycle', { phase: 'end', aborted: true });
  return { controller, emit, abortChat, abortLifecycle, setItem };
}

test.each([
  { background: false, lifecycleFirst: false },
  { background: true, lifecycleFirst: true },
])('keeps interrupted commentary in its original process items: %j', async scenario => {
  const { controller, abortChat, abortLifecycle, setItem } = setup();
  if (scenario.background) await controller.switchSession('agent:main:other-commentary');

  if (scenario.lifecycleFirst) abortLifecycle();
  abortChat();
  if (!scenario.lifecycleFirst) abortLifecycle();

  if (scenario.background) await controller.switchSession(sessionKey);
  expect(controller.state.chatMessages).toEqual([]);
  expect(setItem).not.toHaveBeenCalled();
  expect(controller.state.transcript.activeTurn?.status).toBe('aborted');
  const items = projectTurnItems(controller.state.transcript.activeTurn);
  expect(items.flatMap(item => item.kind === 'content' ? [item.item.text] : []))
    .toEqual(['First step.', 'Second step.']);
  expect(items.filter(item => item.kind === 'terminal')).toHaveLength(1);

  const nativeMessages = ['First step.', 'Second step.'].map((text, index) => ({
    role: 'assistant', content: text, phase: 'commentary', stopReason: 'toolUse',
    __openclaw: { id: `native-commentary-${index}`, seq: index + 1, runId },
  }));
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ messages: nativeMessages }), stop: vi.fn(),
  } as never;
  controller.state.connected = true;
  await controller.loadHistory(true);
  expect(controller.state.chatMessages).toEqual(nativeMessages);
  expect(controller.state.transcript.activeTurn).toBeNull();
});

test('preserves only the actual interrupted reply after the last tool, including late abort frames', async () => {
  const { controller, emit, abortChat, abortLifecycle } = setup();
  emit('thinking', { text: 'Thinking about the reply.' });
  emit('assistant', {
    itemId: 'partial-reply', text: 'Partial reply.', replace: true,
    assistantTextScope: { id: 'reply-message' },
  });

  abortLifecycle();
  abortChat();

  expect(controller.state.chatMessages).toHaveLength(1);
  const message = controller.state.chatMessages[0];
  expect(extractSnapshotText(message)).toBe('Partial reply.');
  expect(message).toMatchObject({
    content: [
      { type: 'thinking', thinking: 'Thinking about the reply.' },
      { type: 'text', text: 'Partial reply.', interrupted: true },
    ],
  });

  controller.state.client = {
    request: vi.fn().mockResolvedValue({ messages: [] }), stop: vi.fn(),
  } as never;
  controller.state.connected = true;
  await controller.loadHistory(true);
  expect(extractSnapshotText(controller.state.chatMessages[0])).toBe('Partial reply.');
});

test('does not promote an older reply past a newer preamble into interrupted output', () => {
  const { controller, emit, abortLifecycle } = setup();
  emit('assistant', { itemId: 'earlier-reply', text: 'Earlier reply.', replace: true });
  emit('thinking', { text: 'Preparing the next tool.' });
  emit('item', {
    kind: 'preamble', phase: 'update', itemId: 'next-preamble', progressText: 'Next step.',
    assistantTextScope: { id: 'next-message' },
  });

  abortLifecycle();

  expect(controller.state.chatMessages).toEqual([]);
  expect(projectTurnItems(controller.state.transcript.activeTurn).flatMap(item =>
    item.kind === 'content' ? [item.item.text] : [],
  )).toEqual(['First step.', 'Second step.', 'Earlier reply.', 'Next step.']);
});

test('keeps a visible reply when a newer preamble has been withdrawn', () => {
  const { controller, emit, abortLifecycle } = setup();
  emit('assistant', { itemId: 'retained-reply', text: 'Retained reply.', replace: true });
  const preamble = {
    kind: 'preamble', phase: 'update', itemId: 'withdrawn-preamble',
    assistantTextScope: { id: 'withdrawn-message' },
  };
  emit('item', { ...preamble, progressText: 'Temporary step.' });
  emit('item', { ...preamble, progressText: '', replace: true });

  abortLifecycle();

  expect(controller.state.chatMessages).toHaveLength(1);
  expect(extractSnapshotText(controller.state.chatMessages[0])).toBe('Retained reply.');
});

test.each([
  { role: 'assistant', content: 'NO_REPLY' },
  { role: 'assistant', content: 'Hidden reply.', display: false },
])('respects native visibility before building an interrupted reply: %j', message => {
  const { controller, emit, abortChat, setItem } = setup();
  emit('thinking', { text: 'Thinking about the reply.' });
  emit('assistant', { itemId: 'partial-reply', text: 'Partial reply.', replace: true });

  abortChat(message);

  expect(controller.state.chatMessages).toEqual([]);
  expect(setItem).not.toHaveBeenCalled();
});

test.each([false, true])('preserves native deliveries across repeated abort notifications (background=%s)', async background => {
  const { controller, abortChat, abortLifecycle } = setup();
  const canvas = {
    type: 'canvas',
    preview: {
      kind: 'canvas', surface: 'assistant_message', render: 'url',
      url: '/__openclaw__/canvas/documents/completed/index.html',
      viewId: 'completed', sandbox: 'scripts',
    },
    rawText: null,
  };
  if (background) await controller.switchSession('agent:main:other-delivery');

  abortChat({
    role: 'assistant', content: [{ type: 'text', text: 'First step.Second step.' }, canvas],
    timestamp: 1000,
  });
  abortLifecycle();
  abortChat();

  if (background) await controller.switchSession(sessionKey);
  expect(controller.state.chatMessages).toHaveLength(1);
  expect(controller.state.chatMessages[0]).toMatchObject({ content: [canvas], timestamp: 1000 });
});
