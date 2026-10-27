import { describe, expect, it } from 'vitest';

import { ChatController } from '../gateway/chat-controller';
import { createChatTranscriptState } from '../model/chat-transcript-state';
import { projectPersistedTimeline } from '../model/timeline/project-history-timeline';
import { projectTurnItems } from '../model/timeline/project-turn-items';
import { boardReferenceIsRealtime } from './native-board';
import { decodeNativeBoardResult, isNativeBoardWidgetReference } from './native-board';
import { decodeNativeCanvasResult } from './native-canvas';

const payload = {
  kind: 'canvas',
  presentation: { target: 'assistant_message', sandbox: 'scripts', title: 'Earth' },
  view: { id: 'cv_inline', boardWidgetName: 'earth', url: '/ignored' },
  capabilityState: 'pending',
};
const output = JSON.stringify(payload);
const envelope = (details: unknown) =>
  JSON.stringify({
    tool: { id: 'openclaw:core:show_widget', name: 'show_widget', source: 'openclaw' },
    result: { content: [{ type: 'text', text: output }], details },
  });

describe('native board reference admission', () => {
  it('admits native pending and rejected name references without fabricating a Canvas identity', () => {
    for (const status of ['pending', 'rejected', 'pinned']) {
      const reference = decodeNativeBoardResult(
        JSON.stringify({ status, boardWidgetName: 'earth' }),
        'show_widget',
        'call',
      );
      expect(reference).toMatchObject({ kind: 'native-board', name: 'earth' });
      expect(reference).not.toHaveProperty('docId');
      expect(isNativeBoardWidgetReference(reference)).toBe(true);
      expect(isNativeBoardWidgetReference({ ...reference })).toBe(false);
    }
  });
  it('gives board precedence over the inline copy in direct and exact core-dispatcher results', () => {
    for (const [name, result] of [
      ['show_widget', output],
      ['tool_call', envelope(payload)],
    ]) {
      expect(decodeNativeCanvasResult(result, name, 'call')).toBeUndefined();
      expect(decodeNativeBoardResult(result, name, 'call')).toMatchObject({
        name: 'earth',
        suppressedInlineDocId: 'cv_inline',
      });
      const items = projectPersistedTimeline([
        {
          role: 'toolResult',
          toolName: name,
          toolCallId: 'call',
          content: [{ type: 'text', text: result }],
        },
        { role: 'assistant', content: '[embed ref="cv_inline" /]' },
      ]);
      expect(items.filter(item => item.kind === 'native-widget')).toHaveLength(1);
      expect(items.some(item => item.kind === 'history-message')).toBe(false);
    }
  });
  it.each(['show_widget', 'tool_call'] as const)(
    'suppresses every admitted inline fallback after same-name board updates through %s', name => {
      const messages = ['cv_inline', 'cv_updated'].flatMap((id, index) => {
        const details = { ...payload, view: { ...payload.view, id } };
        const result = name === 'show_widget' ? JSON.stringify(details) : envelope(details);
        return [
          {
            role: 'toolResult', toolName: name, toolCallId: `call-${index}`,
            content: [{ type: 'text', text: result }],
          },
          { role: 'assistant', content: `[embed ref="${id}" /]` },
        ];
      });
      const keep = '[embed url="https://example.test/live" ref="cv_updated" /]';
      const rows = projectPersistedTimeline([...messages, { role: 'assistant', content: keep }]);
      expect(rows.filter(row => row.kind === 'native-widget')).toHaveLength(1);
      expect(rows.filter(row => row.kind === 'history-message')).toMatchObject([
        { message: { content: keep } },
      ]);
    },
  );
  it('rejects failures, unrelated/nested envelopes, invalid names and missing native call identity', () => {
    for (const value of [
      { ...payload, isError: true },
      { ...payload, error: 'failure' },
      { ...payload, status: 'failed' },
      { nested: payload },
      { ...payload, view: { boardWidgetName: '../earth' } },
      { ...payload, boardWidgetName: 'other' },
    ])
      expect(decodeNativeBoardResult(JSON.stringify(value), 'show_widget', 'call')).toBeUndefined();
    expect(decodeNativeBoardResult(output, 'plugin:show_widget', 'call')).toBeUndefined();
    expect(decodeNativeBoardResult(output, 'show_widget', undefined)).toBeUndefined();
    const fake = JSON.parse(envelope(payload));
    fake.tool.source = 'plugin';
    expect(decodeNativeBoardResult(JSON.stringify(fake), 'tool_call', 'call')).toBeUndefined();
    expect(decodeNativeBoardResult(JSON.stringify({ ...JSON.parse(envelope(payload)), isError: true }), 'tool_call', 'call')).toBeUndefined();
    expect(
      projectPersistedTimeline([{ role: 'assistant', content: output }]).some(
        item => item.kind === 'native-widget',
      ),
    ).toBe(false);
  });
  it.each(['agent', 'session.tool'] as const)(
    'keeps a live core dispatcher result automatic when %s arrives before its duplicate',
    firstDelivery => {
      const controller = new ChatController();
      const client = { generation: 1, request: async () => ({}), stop: () => {} };
      const key = 'agent:main:board-transport-test';
      const owner = { client, generation: 1, sessionKey: key, sessionId: 'session-1' };
      Object.assign(controller.state, {
        client,
        connected: true,
        initialHistoryReady: true,
        sessionKey: key,
        currentSessionId: owner.sessionId,
        transcript: createChatTranscriptState(key, owner.sessionId),
      });
      const handle = (
        controller as unknown as {
          handleEvent(event: { event: string; seq: number; payload: unknown }): void;
        }
      ).handleEvent.bind(controller);
      const result = {
        runId: 'run',
        sessionKey: key,
        sessionId: owner.sessionId,
        seq: 118,
        ts: 118_000,
        stream: 'tool',
        data: {
          phase: 'result',
          toolCallId: 'outer-call',
          name: 'tool_call',
          result: envelope(payload),
        },
      };
      const board = () =>
        projectTurnItems(controller.state.transcript.activeTurn).find(
          item => item.kind === 'native-widget',
        );
      const isAutomatic = () => {
        const item = board();
        return Boolean(
          item?.kind === 'native-widget' &&
          item.preview.kind === 'native-board' &&
          boardReferenceIsRealtime(item.preview, owner),
        );
      };
      try {
        handle({ event: firstDelivery, seq: 1001, payload: result });
        expect(controller.state.transcript.activeTurn?.toolById.get('outer-call')).toMatchObject({
          status: 'completed',
          name: 'tool_call',
          output: envelope(payload),
        });
        const firstAutomatic = isAutomatic();
        handle({
          event: firstDelivery === 'session.tool' ? 'agent' : 'session.tool',
          seq: 1002,
          payload: result,
        });
        handle({
          event: 'agent',
          seq: 1003,
          payload: {
            ...result,
            seq: 119,
            stream: 'item',
            data: { kind: 'tool', phase: 'end', toolCallId: 'outer-call' },
          },
        });
        const item = board();
        expect(item?.kind === 'native-widget' && item.preview.toolCallId).toBe('outer-call');
        expect([firstAutomatic, isAutomatic()]).toEqual([true, true]);
      } finally {
        controller.disconnect();
      }
    },
  );
  it.each([
    { sessionKey: 'agent:main:other', sessionId: 'session-1' },
    { sessionKey: 'agent:main:board-transport-test', sessionId: 'retired-session' },
    { sessionKey: 'agent:main:board-transport-test', sessionId: null },
  ])(
    'does not grant live execution to a session.tool with a different or absent identity: %j',
    identity => {
      const controller = new ChatController();
      const client = { generation: 1, request: async () => ({}), stop: () => {} };
      const key = 'agent:main:board-transport-test';
      const owner = { client, generation: 1, sessionKey: key, sessionId: 'session-1' };
      Object.assign(controller.state, {
        client,
        connected: true,
        initialHistoryReady: true,
        sessionKey: key,
        currentSessionId: owner.sessionId,
        transcript: createChatTranscriptState(key, owner.sessionId),
      });
      const handle = (
        controller as unknown as { handleEvent(event: { event: string; payload: unknown }): void }
      ).handleEvent.bind(controller);
      try {
        handle({
          event: 'session.tool',
          payload: {
            runId: 'run',
            ...identity,
            seq: 1,
            ts: 1000,
            stream: 'tool',
            data: {
              phase: 'result',
              toolCallId: 'outer-call',
              name: 'tool_call',
              result: envelope(payload),
            },
          },
        });
        const item = projectTurnItems(controller.state.transcript.activeTurn).find(
          value => value.kind === 'native-widget',
        );
        expect(
          Boolean(
            item?.kind === 'native-widget' &&
            item.preview.kind === 'native-board' &&
            boardReferenceIsRealtime(item.preview, owner),
          ),
        ).toBe(false);
      } finally {
        controller.disconnect();
      }
    },
  );
  it('only marks an accepted current realtime result; history and replay never gain automatic execution', () => {
    const controller = new ChatController();
    const client = { generation: 1, request: async () => ({}) };
    const key = 'agent:main:board-test';
    Object.assign(controller.state, {
      client,
      connected: true,
      initialHistoryReady: true,
      sessionKey: key,
      currentSessionId: 'session-1',
      transcript: createChatTranscriptState(key, 'session-1'),
    });
    const apply = (
      controller as unknown as {
        applyNormalizedAgentEvent: (event: unknown, options?: unknown) => void;
      }
    ).applyNormalizedAgentEvent.bind(controller);
    const event = (call: string, seq: number) => ({
      runId: 'run',
      sessionKey: key,
      sessionId: 'session-1',
      lifecycleGeneration: null,
      agentId: 'main',
      spawnedBy: null,
      agentSeq: seq,
      frameSeq: seq,
      deliveryEvent: 'agent',
      timestamp: seq * 1000,
      stream: 'tool',
      data: { phase: 'result', toolCallId: call, name: 'show_widget', result: output },
    });
    apply(event('first', 1));
    apply(event('second', 2));
    const item = projectTurnItems(controller.state.transcript.activeTurn).find(
      value => value.kind === 'native-widget',
    );
    expect(item?.kind === 'native-widget' && item.preview.toolCallId).toBe('second');
    const owner = { client, generation: 1, sessionKey: key, sessionId: 'session-1' };
    expect(
      item?.kind === 'native-widget' &&
        item.preview.kind === 'native-board' &&
        boardReferenceIsRealtime(item.preview, owner),
    ).toBe(true);
    apply(event('replay', 3), { replaySnapshot: true });
    apply(
      { ...event('session-replay', 4), deliveryEvent: 'session.tool' },
      { replaySnapshot: true },
    );
    const replay = projectTurnItems(controller.state.transcript.activeTurn).find(
      value => value.kind === 'native-widget',
    );
    expect(replay?.kind === 'native-widget' && replay.preview.toolCallId).toBe('second');
    const historical = projectPersistedTimeline([
      { role: 'toolResult', toolName: 'show_widget', toolCallId: 'second', content: output },
    ]).find(value => value.kind === 'native-widget');
    expect(
      historical?.kind === 'native-widget' &&
        historical.preview.kind === 'native-board' &&
        boardReferenceIsRealtime(historical.preview, owner),
    ).toBe(false);
  });
});
