import { describe, expect, test } from 'vitest';

import { normalizeAgentEvent, normalizeChatEvent } from './agentEvent';

describe('normalizeAgentEvent', () => {
  test('preserves native lifecycle evidence and error observations unchanged', () => {
    const data = {
      phase: 'error',
      error: 'Provider request failed.',
      executionSettled: true,
      errorObservation: {
        providerErrorMessagePreview: 'Deployment is paused',
        rawErrorPreview: 'PRIVATE',
      },
    };
    const event = normalizeAgentEvent({
      deliveryEvent: 'agent',
      payload: { runId: 'run-1', seq: 2, stream: 'lifecycle', data },
    }).event;
    expect(event?.data).toBe(data);
    expect(event?.data.executionSettled).toBe(true);
    expect(data.error).toBe('Provider request failed.');
  });
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
  test('keeps internal handoff errors recognizable for existing suppression', () => {
    const errorMessage = 'Managed subagent terminal handoff could not be persisted.';
    expect(
      normalizeChatEvent({
        payload: {
          runId: 'run-1',
          sessionKey: 'session-1',
          state: 'error',
          errorMessage,
          errorDetail: { providerErrorMessagePreview: 'Internal detail' },
        },
      })?.errorMessage,
    ).toBe(errorMessage);
  });
  test('preserves classified guidance while adding the public provider diagnostic', () => {
    expect(
      normalizeChatEvent({
        payload: {
          runId: 'run-1',
          sessionKey: 'session-1',
          state: 'error',
          errorMessage: 'LLM request failed: provider rejected the request schema or tool payload.',
          errorDetail: { providerErrorMessagePreview: '400 Unsupported response format' },
        },
      })?.errorMessage,
    ).toBe(
      'LLM request failed: provider rejected the request schema or tool payload.\n400 Unsupported response format',
    );
  });
  test('uses a public diagnostic without a summary only on failed chat events', () => {
    const payload = {
      runId: 'run-1',
      sessionKey: 'session-1',
      errorDetail: { providerErrorMessagePreview: 'Deployment is paused' },
    };
    expect(normalizeChatEvent({ payload: { ...payload, state: 'error' } })?.errorMessage).toBe(
      'Deployment is paused',
    );
    expect(normalizeChatEvent({ payload: { ...payload, state: 'final' } })).not.toHaveProperty(
      'errorMessage',
    );
  });
  test('retains the public provider diagnostic in a generic chat error', () => {
    expect(
      normalizeChatEvent({
        payload: {
          runId: 'run-1',
          sessionKey: 'session-1',
          state: 'error',
          errorMessage: 'Provider request failed.',
          errorDetail: {
            providerErrorMessagePreview: 'Selected deployment is paused',
            rawErrorPreview: 'PRIVATE',
          },
        },
      })?.errorMessage,
    ).toBe('Provider request failed. Selected deployment is paused');
  });
  test('keeps a native retraction sequence separate from its transport frame', () => {
    expect(
      normalizeChatEvent({
        frameSeq: 90,
        payload: {
          runId: 'run-1',
          sessionKey: 'session-1',
          state: 'delta',
          seq: 7,
          replace: true,
          deltaText: '',
        },
      }),
    ).toMatchObject({ sourceSeq: 7, frameSeq: 90, replace: true, deltaText: '' });
  });

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
