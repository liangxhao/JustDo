import { normalizeAgentEvent, normalizeChatEvent } from '@shared/openclaw/agentEvent';
import { expect, test, vi } from 'vitest';

import {
  beginAssistantTurn,
  createChatTranscriptState,
  type TranscriptReducerDependencies,
} from '../../model/chat-transcript-state';
import { projectTurnItems } from '../../model/timeline/project-turn-items';
import { reduceAgentEvent, reduceChatEvent } from '../../model/turn/agent-event-reducer';
import type { GatewayClient } from '../client';
import { recoverAssistantText } from './assistant-text-recovery';

const sessionKey = 'agent:main:assistant-baseline-recovery';
const sessionId = 'physical-session';
const runId = 'baseline-recovery-run';

function setup() {
  let id = 0;
  const dependencies: TranscriptReducerDependencies = {
    now: () => 100,
    createId: prefix => `${prefix}-${++id}`,
  };
  const transcript = createChatTranscriptState(sessionKey, sessionId);
  const turn = beginAssistantTurn(
    transcript,
    {
      runId,
      sessionId,
      lifecycleGeneration: 'incarnation-1',
    },
    dependencies,
  );
  const chat = (seq: number, text: string) =>
    reduceChatEvent(
      transcript,
      normalizeChatEvent({
        payload: {
          sessionKey,
          sessionId,
          runId,
          seq,
          state: 'delta',
          message: { role: 'assistant', content: text },
        },
      })!,
      dependencies,
    );
  const agent = (seq: number, data: Record<string, unknown>) =>
    reduceAgentEvent(
      transcript,
      normalizeAgentEvent({
        deliveryEvent: 'agent',
        payload: {
          sessionKey,
          sessionId,
          runId,
          seq,
          stream: 'assistant',
          ts: 100 + seq,
          data,
        },
      }).event!,
      dependencies,
      { allowSequenceBackfill: true },
    );
  chat(8, 'Hello world');
  agent(6, { itemId: 'reply-1', delta: 'Hello' });
  const response = (text: string | undefined = 'Hello world') => ({
    sessionKey,
    sessionId,
    sessionInfo: { key: sessionKey, sessionId, hasActiveRun: true, activeRunIds: [runId] },
    inFlightRun: {
      runId,
      events: [
        {
          runId,
          sessionKey,
          seq: 7,
          ts: 107,
          stream: 'assistant',
          data: {
            itemId: 'reply-1',
            assistantTextSnapshot: true,
            ...(text !== undefined ? { text } : {}),
            replace: true,
          },
        },
      ],
    },
  });
  let generation = 1;
  const request = vi.fn(async () => response());
  const client = {
    get generation() {
      return generation;
    },
    request,
  } as unknown as Pick<GatewayClient, 'generation' | 'request'>;
  let current = true;
  const notify = vi.fn();
  const context = { transcript, client, dependencies, isCurrent: () => current, notify };
  const visible = () =>
    projectTurnItems(transcript.activeTurn).flatMap(item =>
      item.kind === 'content' ? [item.item.text] : [],
    );
  return {
    transcript,
    turn,
    chat,
    agent,
    response,
    request,
    context,
    notify,
    visible,
    changeGeneration: () => {
      generation += 1;
    },
    unbind: () => {
      current = false;
    },
  };
}

test('recovers the exact owner using a causal keyed snapshot below a Chat Tool-boundary seq', async () => {
  const { context, request, turn, visible, notify } = setup();
  expect(await recoverAssistantText(context)).toBe(true);
  expect(request).toHaveBeenCalledWith(
    'chat.history',
    { sessionKey, limit: 1 },
    {
      timeoutMs: 10_000,
    },
  );
  expect(visible()).toEqual(['Hello world']);
  expect(turn.items.some(item => item.type === 'content' && item.chatFallback)).toBe(false);
  expect(turn.assistantTextRecoveryOwnerIds?.size ?? 0).toBe(0);
  expect(notify).toHaveBeenCalled();
});

test('keeps the Chat preview for omitted text and bounds attempts across later triggers', async () => {
  const { context, request, response, turn, visible } = setup();
  const omitted = response();
  delete (omitted.inFlightRun.events[0].data as { text?: string }).text;
  request.mockResolvedValue(omitted);
  expect(await recoverAssistantText(context)).toBe(false);
  expect(await recoverAssistantText(context)).toBe(false);
  expect(request).toHaveBeenCalledTimes(3);
  expect(visible()).toEqual(['Hello world']);
  expect(turn.assistantTextRecoveryOwnerIds?.has('reply-1')).toBe(true);
});

test('keeps the Chat preview when the authenticated read fails', async () => {
  const { context, request, visible } = setup();
  request.mockRejectedValue(new Error('connection unavailable'));
  expect(await recoverAssistantText(context)).toBe(false);
  expect(request).toHaveBeenCalledTimes(3);
  expect(visible()).toEqual(['Hello world']);
});

test.each(['client', 'history', 'session', 'turnSession', 'run', 'lifecycle', 'turn', 'binding'])(
  'rejects a late response after the captured %s binding changes',
  async binding => {
    const value = setup();
    let resolve!: (result: ReturnType<typeof value.response>) => void;
    value.request.mockImplementation(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const recovery = recoverAssistantText(value.context);
    if (binding === 'client') value.changeGeneration();
    if (binding === 'history') value.transcript.historyGeneration += 1;
    if (binding === 'session') value.transcript.sessionId = 'replacement-session';
    if (binding === 'turnSession') value.turn.sessionId = 'replacement-session';
    if (binding === 'run') value.turn.runId = 'replacement-run';
    if (binding === 'lifecycle') value.turn.lifecycleGeneration = 'incarnation-2';
    if (binding === 'turn') value.transcript.activeTurn = null;
    if (binding === 'binding') value.unbind();
    resolve(value.response());
    expect(await recovery).toBe(false);
    expect(value.request).toHaveBeenCalledTimes(1);
    expect(value.notify).not.toHaveBeenCalled();
  },
);

test.each(['run', 'session', 'key', 'eventOwner', 'eventRun', 'inactive'])(
  'rejects a recovery snapshot for a different %s',
  async mismatch => {
    const { context, request, response, visible, notify } = setup();
    const payload = response();
    if (mismatch === 'run') payload.inFlightRun.runId = 'another-run';
    if (mismatch === 'session') payload.sessionId = 'another-session';
    if (mismatch === 'key') payload.sessionKey = 'agent:main:another-key';
    if (mismatch === 'eventOwner') payload.inFlightRun.events[0].data.itemId = 'another-owner';
    if (mismatch === 'eventRun') payload.inFlightRun.events[0].runId = 'another-run';
    if (mismatch === 'inactive') payload.sessionInfo.hasActiveRun = false;
    request.mockResolvedValue(payload);
    expect(await recoverAssistantText(context)).toBe(false);
    expect(visible()).toEqual(['Hello world']);
    expect(notify).not.toHaveBeenCalled();
  },
);

test.each([
  'data.sessionId',
  'data.lifecycleGeneration',
  'data.gatewayGeneration',
  'gatewayGeneration',
  'data.sessionKey',
])('checks the original event identity before filling missing fields: %s', async alias => {
  const { context, request, response, visible, notify } = setup();
  const payload = response();
  const event = payload.inFlightRun.events[0] as Record<string, unknown>;
  const data = event.data as Record<string, unknown>;
  if (alias.startsWith('data.')) data[alias.slice(5)] = 'foreign-identity';
  else event[alias] = 'foreign-identity';
  if (alias === 'data.sessionKey') delete event.sessionKey;
  request.mockResolvedValue(payload);
  expect(await recoverAssistantText(context)).toBe(false);
  expect(visible()).toEqual(['Hello world']);
  expect(notify).not.toHaveBeenCalled();
});

test('shares one pending request and covers newer Chat only after a subsequent causal read', async () => {
  const value = setup();
  let resolve!: (result: ReturnType<typeof value.response>) => void;
  value.request.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const first = recoverAssistantText(value.context);
  expect(recoverAssistantText(value.context)).toBe(first);
  expect(value.request).toHaveBeenCalledTimes(1);
  value.chat(10, 'Hello world today');
  value.request.mockResolvedValue(value.response('Hello world today'));
  resolve(value.response());
  expect(await first).toBe(true);
  expect(value.request).toHaveBeenCalledTimes(2);
  expect(value.visible()).toEqual(['Hello world today']);
});
