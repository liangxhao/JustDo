import { describe, expect, test } from 'vitest';

import { normalizeAgentEvent, normalizeChatEvent } from './agentEvent';

describe('normalizeAgentEvent', () => {
  test('keeps transport and canonical Agent sequences separate', () => {
    const result = normalizeAgentEvent({
      deliveryEvent: 'agent',
      frameSeq: 90,
      now: 1000,
      payload: {
        runId: 'run-1',
        seq: 7,
        aseq: 6,
        stream: 'thinking',
        sessionKey: 'agent:main:justdo:session-1',
        ts: 900,
        data: { text: 'secret text' },
      },
    });

    expect(result.event).toMatchObject({
      runId: 'run-1',
      agentSeq: 7,
      frameSeq: 90,
      timestamp: 900,
    });
    expect(result.usedAseqFallback).toBe(false);
  });

  test('uses the bundled runtime aseq compatibility fallback', () => {
    const result = normalizeAgentEvent({
      deliveryEvent: 'session.tool',
      payload: { runId: 'run-1', aseq: 8, stream: 'tool', data: {} },
    });

    expect(result.event?.agentSeq).toBe(8);
    expect(result.usedAseqFallback).toBe(true);
  });

  test('rejects malformed ordering fields', () => {
    expect(
      normalizeAgentEvent({
        deliveryEvent: 'agent',
        payload: { runId: 'run-1', seq: Number.NaN, stream: 'tool' },
      }),
    ).toMatchObject({ event: null, reason: 'missing-sequence' });
  });
});

describe('normalizeChatEvent', () => {
  test('does not reinterpret a chat frame sequence as an Agent sequence', () => {
    expect(
      normalizeChatEvent({
        frameSeq: 7,
        payload: { runId: 'run-1', sessionKey: 'session-1', state: 'final' },
      }),
    ).toEqual({
      runId: 'run-1',
      sessionKey: 'session-1',
      sessionId: null,
      lifecycleGeneration: null,
      frameSeq: 7,
      state: 'final',
      replace: false,
    });
  });
});
