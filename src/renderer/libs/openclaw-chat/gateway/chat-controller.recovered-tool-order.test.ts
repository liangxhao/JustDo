import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from './chat-controller';

const controllers: ChatController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
  vi.useRealTimers();
});

test('orders delayed native Thinking before a result-only Tool even after its canonical start arrives', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const sessionKey = 'agent:main:justdo:recovered-tool-order';
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.initialHistoryReady = true;
  const internal = controller as unknown as {
    handleEvent(event: { event: string; payload: unknown }): void;
  };
  const agent = (seq: number, stream: string, ts: number, data: Record<string, unknown>) =>
    internal.handleEvent({
      event: 'agent',
      payload: { sessionKey, runId: 'run-1', seq, stream, ts, data },
    });
  agent(1, 'lifecycle', 1000, { phase: 'start' });

  internal.handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'toolResult',
        timestamp: 1500,
        toolCallId: 'tool-1',
        toolName: 'read',
        content: 'done',
      },
    },
  });
  const tool = controller.state.transcript.activeTurn!.toolById.get('tool-1')!;
  expect(tool).toMatchObject({ status: 'completed', firstSeq: 1 });

  agent(2, 'thinking', 1100, {
    text: 'Reasoning before the tool',
    progressSegmentFirstSeq: 2,
    progressSegmentStartedAt: 1100,
  });
  expect(controller.state.transcript.activeTurn!.items.map(item => item.type)).toEqual([
    'thinking',
    'tool',
  ]);
  agent(3, 'tool', 1300, { phase: 'start', name: 'read', toolCallId: 'tool-1', args: {} });

  expect(controller.state.transcript.activeTurn!.items.map(item => item.type)).toEqual([
    'thinking',
    'tool',
  ]);
  expect(tool.firstSeq).toBe(3);
  expect(tool).toMatchObject({ status: 'completed', output: 'done' });
});

test('does not treat an assistant message start timestamp as the recovered Tool execution boundary', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const sessionKey = 'agent:main:justdo:recovered-tool-time';
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.initialHistoryReady = true;
  const internal = controller as unknown as {
    handleEvent(event: { event: string; payload: unknown }): void;
  };
  const agent = (seq: number, stream: string, ts: number, data: Record<string, unknown>) =>
    internal.handleEvent({
      event: 'agent',
      payload: { sessionKey, runId: 'run-1', seq, stream, ts, data },
    });
  agent(1, 'lifecycle', 1000, { phase: 'start' });
  internal.handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'assistant',
        timestamp: 1000,
        content: [
          { type: 'thinking', thinking: 'Reasoning before the tool' },
          { type: 'toolCall', id: 'tool-1', name: 'read', arguments: {} },
        ],
      },
    },
  });
  expect(controller.state.transcript.activeTurn!.toolById.get('tool-1')).toMatchObject({
    agentSequencePending: true,
    startedAt: 1000,
  });

  agent(2, 'thinking', 1100, {
    text: 'Reasoning before the tool',
    progressSegmentFirstSeq: 2,
    progressSegmentStartedAt: 1100,
  });
  expect(controller.state.transcript.activeTurn!.items.map(item => item.type)).toEqual([
    'thinking',
    'tool',
  ]);
  agent(3, 'tool', 1300, { phase: 'start', name: 'read', toolCallId: 'tool-1', args: {} });

  expect(controller.state.transcript.activeTurn!.items.map(item => item.type)).toEqual([
    'thinking',
    'tool',
  ]);
});

test('keeps a new Thinking owner after a recovered Tool with an earlier real result timestamp', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const sessionKey = 'agent:main:justdo:recovered-tool-new-thinking';
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.initialHistoryReady = true;
  const internal = controller as unknown as {
    handleEvent(event: { event: string; payload: unknown }): void;
  };
  internal.handleEvent({
    event: 'agent',
    payload: {
      sessionKey,
      runId: 'run-1',
      seq: 1,
      stream: 'lifecycle',
      ts: 1000,
      data: { phase: 'start' },
    },
  });
  internal.handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'toolResult',
        timestamp: 1500,
        toolCallId: 'tool-1',
        toolName: 'read',
        content: 'done',
      },
    },
  });

  internal.handleEvent({
    event: 'agent',
    payload: {
      sessionKey,
      runId: 'run-1',
      seq: 5,
      stream: 'thinking',
      ts: 1600,
      data: {
        text: 'New reasoning after completion',
        progressSegmentFirstSeq: 5,
        progressSegmentStartedAt: 1600,
      },
    },
  });

  expect(controller.state.transcript.activeTurn!.items.map(item => item.type)).toEqual([
    'tool',
    'thinking',
  ]);
});

test('keeps normally ordered Thinking before a recovered nested tool_call and agents_wait pair', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const sessionKey = 'agent:main:justdo:recovered-nested-tools';
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.initialHistoryReady = true;
  const internal = controller as unknown as {
    handleEvent(event: { event: string; payload: unknown }): void;
  };
  const agent = (seq: number, stream: string, ts: number, data: Record<string, unknown>) =>
    internal.handleEvent({
      event: 'agent',
      payload: { sessionKey, runId: 'run-1', seq, stream, ts, data },
    });
  agent(560, 'lifecycle', 1000, { phase: 'start' });
  agent(561, 'thinking', 1200, {
    text: 'Wait for the five agents',
    progressSegmentFirstSeq: 561,
    progressSegmentStartedAt: 1200,
  });
  const thinking = controller.state.transcript.activeTurn!.items[0];
  internal.handleEvent({
    event: 'session.message',
    payload: {
      sessionKey,
      activeRunIds: ['run-1'],
      message: {
        role: 'assistant',
        timestamp: 1000,
        content: [
          { type: 'thinking', thinking: 'Wait for the five agents' },
          {
            type: 'toolCall',
            id: 'outer',
            name: 'tool_call',
            arguments: { id: 'agents_wait', args: { ids: ['a', 'b', 'c', 'd', 'e'] } },
          },
          {
            type: 'toolCall',
            id: 'inner',
            name: 'agents_wait',
            arguments: { ids: ['a', 'b', 'c', 'd', 'e'] },
          },
        ],
      },
    },
  });
  agent(584, 'tool', 1400, {
    phase: 'start',
    toolCallId: 'outer',
    name: 'tool_call',
    args: { id: 'agents_wait' },
  });
  agent(585, 'tool', 1401, {
    phase: 'start',
    toolCallId: 'inner',
    name: 'agents_wait',
    args: { ids: ['a', 'b', 'c', 'd', 'e'] },
  });

  expect(
    controller.state.transcript.activeTurn!.items.map(item =>
      item.type === 'tool' ? item.toolCallId : item.type,
    ),
  ).toEqual(['thinking', 'outer', 'inner']);
  expect(controller.state.transcript.activeTurn!.items[0]).toBe(thinking);
  expect(thinking.firstSeq).toBe(561);
});
