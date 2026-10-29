import type { NormalizedChatEvent } from '@shared/openclaw/agentEvent';
import { expect, test } from 'vitest';

import { createChatTranscriptState } from '../../model/chat-transcript-state';
import { reduceAgentEvent } from '../../model/turn/agent-event-reducer';
import { findPersistedChatFinal } from './chat-final-source';

const final: NormalizedChatEvent = {
  runId: 'run', sessionKey: 'session', sessionId: 'sid', lifecycleGeneration: null,
  frameSeq: 100, state: 'final', replace: false,
  message: { role: 'assistant', content: 'ABCDEF', __openclaw: { idempotencyKey: 'final-key' } },
};
const durable = {
  role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'F' }],
  __openclaw: { id: 'final-message', seq: 9, runId: 'run', idempotencyKey: 'final-key' },
  openclawDelivery: { messageScopeId: 'final-scope' },
};

test('matches the native final key even when the Agent final was missed', () => {
  expect(findPersistedChatFinal(final, [durable], null)).toBe(durable);
  const nativeFinal = {
    ...final, message: { role: 'assistant', __openclaw: { id: 'final-message' } },
  };
  expect(findPersistedChatFinal(nativeFinal, [durable], null)).toBe(durable);
});

test.each([
  { phase: 'commentary' },
  { openclawStreamFallback: { source: 'segment' } },
  { stopReason: 'toolUse' },
  { content: [{ type: 'toolCall', id: 'call', name: 'read' }] },
  { content: [] },
  { __justdoOptimisticHistoryTail: true },
  { __openclaw: { ...durable.__openclaw, truncated: true } },
  { __openclaw: { ...durable.__openclaw, runId: 'another-run' } },
  { __openclaw: { runId: 'run', idempotencyKey: 'final-key' } },
])('does not promote an ineligible historical row: %j', change => {
  expect(findPersistedChatFinal(final, [{ ...durable, ...change }], null)).toBeNull();
});

test('requires an exact latest live scope when the Chat final lacks identity', () => {
  const state = createChatTranscriptState('session', 'sid');
  let id = 0;
  const dependencies = { now: () => 100, createId: () => `item-${++id}` };
  const emit = (seq: number, stream: string, data: Record<string, unknown>) => reduceAgentEvent(state, {
    sessionKey: 'session', sessionId: 'sid', runId: 'run', lifecycleGeneration: null,
    agentId: null, spawnedBy: null, agentSeq: seq, frameSeq: seq, timestamp: 100,
    deliveryEvent: 'agent', stream, data,
  }, dependencies);
  emit(1, 'assistant', {
    itemId: 'final-owner', text: 'F', assistantTextScope: { id: 'final-scope', commentaryItemIds: [] },
  });
  const unkeyed = { ...final, message: { role: 'assistant', content: 'ABCDEF' } };
  expect(findPersistedChatFinal(unkeyed, [durable], state.activeTurn)).toBe(durable);
  const earlier = { ...durable, openclawDelivery: { messageScopeId: 'earlier-scope' } };
  expect(findPersistedChatFinal(unkeyed, [earlier], state.activeTurn)).toBeNull();
  const conflictingKey = {
    ...final, message: { role: 'assistant', __openclaw: { idempotencyKey: 'different-key' } },
  };
  expect(findPersistedChatFinal(conflictingKey, [durable], state.activeTurn)).toBeNull();
  expect(findPersistedChatFinal(unkeyed, [durable, {
    ...durable, __openclaw: { ...durable.__openclaw, id: 'later-message', seq: 10 },
    openclawDelivery: { messageScopeId: 'later-scope' },
  }], state.activeTurn)).toBeNull();

  emit(2, 'tool', { phase: 'start', toolCallId: 'later-tool', name: 'read' });
  expect(findPersistedChatFinal(unkeyed, [durable], state.activeTurn)).toBeNull();
});
