import { expect, test, vi } from 'vitest';

import {
  type NormalizedAgentEvent,
  TERMINAL_GUARD_OBSERVATION_KEY,
} from '../../../shared/openclaw/agentEvent';
import { AcpProgress } from './acpProgress';

const event = (stream: string, data: Record<string, unknown>) =>
  ({ stream, data }) as NormalizedAgentEvent;

test('native snapshots emit only new text and the final response does not duplicate streamed text', () => {
  const update = vi.fn();
  const progress = new AcpProgress(update);
  progress.accept(event('assistant', { text: 'hello' }));
  progress.accept(event('assistant', { text: 'hello world' }));
  progress.finish('hello world');
  expect(update.mock.calls.map(([value]) => value.content.text)).toEqual(['hello', ' world']);
});

test('distinct native messages with identical text are each delivered before the final response', () => {
  const update = vi.fn();
  const progress = new AcpProgress(update);
  for (const id of ['message-1', 'message-2']) {
    progress.accept(event('assistant', { text: 'Same.', assistantTextScope: { id } }));
  }
  progress.finish('Same.');
  expect(update.mock.calls.map(([value]) => value.content.text)).toEqual(['Same.', 'Same.']);
});

test('native item boundaries keep a new message whose text extends the previous message', () => {
  const update = vi.fn();
  const progress = new AcpProgress(update);
  progress.accept(event('assistant', { itemId: 'commentary', text: 'Answer:' }));
  progress.accept(event('assistant', { itemId: 'answer', delta: 'Answer:' }));
  progress.accept(event('assistant', { itemId: 'answer', delta: ' details.' }));
  progress.finish('Answer: details.');
  expect(update.mock.calls.map(([value]) => value.content.text)).toEqual([
    'Answer:',
    'Answer:',
    ' details.',
  ]);
});

test('a shared source scope keeps delivery aliases and later scope metadata in one message', () => {
  const update = vi.fn();
  const progress = new AcpProgress(update);
  progress.accept(event('assistant', { itemId: 'preview', text: 'hello' }));
  progress.accept(
    event('assistant', {
      itemId: 'preview',
      assistantTextScope: { id: 'source' },
      text: 'hello world',
    }),
  );
  progress.accept(
    event('assistant', {
      itemId: 'final',
      assistantTextScope: { id: 'source' },
      text: 'hello world',
    }),
  );
  progress.finish('hello world');
  expect(update.mock.calls.map(([value]) => value.content.text)).toEqual(['hello', ' world']);
});

test('speculative native output remains hidden until commit and rollback discards it', () => {
  const update = vi.fn();
  const progress = new AcpProgress(update);
  const guard = (token: string, action: 'update' | 'commit' | 'rollback', text?: string) =>
    event('assistant', {
      [TERMINAL_GUARD_OBSERVATION_KEY]: { token, action },
      ...(text === undefined ? {} : { text }),
    });
  progress.accept(guard('rejected', 'update', 'speculative'));
  progress.accept(guard('rejected', 'rollback'));
  expect(update).not.toHaveBeenCalled();
  progress.accept(guard('accepted', 'update', 'committed'));
  progress.accept(guard('stale', 'commit'));
  expect(update).not.toHaveBeenCalled();
  progress.accept(guard('accepted', 'commit'));
  progress.finish('committed');
  expect(update).toHaveBeenCalledExactlyOnceWith({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'committed' },
  });
});

test('thinking and tool results preserve separate updates around assistant message boundaries', () => {
  const update = vi.fn();
  const progress = new AcpProgress(update);
  progress.accept(event('thinking', { text: 'plan' }));
  progress.accept(event('assistant', { text: 'checking' }));
  progress.accept(
    event('tool', {
      phase: 'start',
      toolCallId: 'tool-1',
      name: 'read',
      args: { path: 'source.ts' },
    }),
  );
  progress.accept(
    event('tool', { phase: 'result', toolCallId: 'tool-1', result: { content: 'file' } }),
  );
  progress.finish('answer');
  expect(update.mock.calls.map(([value]) => value.sessionUpdate)).toEqual([
    'agent_thought_chunk',
    'agent_message_chunk',
    'tool_call',
    'tool_call_update',
    'agent_message_chunk',
  ]);
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      toolCallId: 'tool-1',
      status: 'completed',
      rawOutput: { content: 'file' },
    }),
  );
});

test('native partial tool results reach ACP while the tool is still running', () => {
  const update = vi.fn();
  const progress = new AcpProgress(update);
  const partialResult = { content: [{ type: 'text', text: 'half-way' }] };
  progress.accept(event('tool', { phase: 'start', toolCallId: 'tool-1', name: 'exec' }));
  progress.accept(event('tool', { phase: 'update', toolCallId: 'tool-1', partialResult }));
  expect(update).toHaveBeenLastCalledWith({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tool-1',
    status: 'in_progress',
    rawOutput: partialResult,
  });
});

test('oversized native text is rejected before it enters the protocol output queue', () => {
  const update = vi.fn();
  const progress = new AcpProgress(update);
  expect(() =>
    progress.accept(event('assistant', { text: 'a'.repeat(2 * 1024 * 1024 + 1) })),
  ).toThrow('limit');
  expect(update).not.toHaveBeenCalled();
});

test('a delta-only guard starts its own snapshot after previously streamed commentary', () => {
  const update = vi.fn();
  const progress = new AcpProgress(update);
  progress.accept(event('assistant', { text: 'Checking the source.' }));
  progress.accept(
    event('assistant', {
      delta: 'The answer is ready.',
      [TERMINAL_GUARD_OBSERVATION_KEY]: { token: 'final', action: 'update' },
    }),
  );
  progress.accept(
    event('assistant', {
      [TERMINAL_GUARD_OBSERVATION_KEY]: { token: 'final', action: 'commit' },
    }),
  );
  progress.finish('The answer is ready.');
  expect(update.mock.calls.map(([value]) => value.content.text)).toEqual([
    'Checking the source.',
    'The answer is ready.',
  ]);
});

test('guard commit retains its native message identity even when only an earlier update carries it', () => {
  const update = vi.fn();
  const progress = new AcpProgress(update);
  progress.accept(
    event('assistant', {
      text: 'Same.',
      assistantTextScope: { id: 'commentary' },
    }),
  );
  progress.accept(
    event('assistant', {
      text: 'Same.',
      assistantTextScope: { id: 'answer' },
      [TERMINAL_GUARD_OBSERVATION_KEY]: { token: 'final', action: 'update' },
    }),
  );
  progress.accept(
    event('assistant', {
      text: 'Same.',
      [TERMINAL_GUARD_OBSERVATION_KEY]: { token: 'final', action: 'update' },
    }),
  );
  progress.accept(
    event('assistant', {
      [TERMINAL_GUARD_OBSERVATION_KEY]: { token: 'final', action: 'commit' },
    }),
  );
  progress.finish('Same.');
  expect(update.mock.calls.map(([value]) => value.content.text)).toEqual(['Same.', 'Same.']);
});
