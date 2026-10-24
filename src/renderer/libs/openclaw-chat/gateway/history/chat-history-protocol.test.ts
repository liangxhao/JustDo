import { describe, expect, test, vi } from 'vitest';

import { projectPersistedTimeline } from '../../model/timeline/project-history-timeline';
import {
  normalizeGatewayHistoryForDisplay,
  persistFailedRun,
} from '../../pipeline/history-display-normalizer';
import type { GatewayMessage } from '../../types';
import type { GatewayClient } from '../client';
import {
  decodeHistoryOffsetCursor,
  hydrateTruncatedHistoryMessages,
  parseChatHistoryPage,
} from './chat-history-protocol';

describe('OpenClaw chat history protocol', () => {
  test('binds native message hydration and bounded fallback to the confirmed physical session', async () => {
    const complete = { role: 'toolResult', content: 'complete original output' };
    const request = vi.fn(async (method: string) =>
      method === 'chat.message.get'
        ? { ok: false, unavailableReason: 'oversized' }
        : {
            ok: true,
            chunk: JSON.stringify(complete),
            complete: true,
            transferId: 'original-transfer',
          },
    );
    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      [{ role: 'toolResult', content: 'preview', __openclaw: { id: 'message', truncated: true } }],
      'key',
      () => true,
      'physical-original',
    );
    expect(hydrated[0]).toMatchObject(complete);
    expect(request.mock.calls).toEqual([
      [
        'chat.message.get',
        {
          sessionKey: 'key',
          sessionId: 'physical-original',
          messageId: 'message',
          maxChars: 2_000_000,
        },
      ],
      [
        'runtimeServices.historyMessage',
        {
          sessionKey: 'key',
          sessionId: 'physical-original',
          messageId: 'message',
          cursor: 0,
          maxChars: 512 * 1024,
        },
      ],
    ]);
  });
  test('renders a generated assistant error once as a failure and retains actual partial replies', async () => {
    const error = 'LLM request failed: network connection was interrupted.';
    const timestamp = Date.now();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    try {
      for (const emptyContent of [true, false]) {
        persistFailedRun({
          sessionKey: 'session-1',
          runId: 'run-1',
          timestamp,
          error: `⚠️ Agent failed before reply: ${error}`,
        });
        const reply = {
          role: 'assistant',
          stopReason: 'error',
          content: [{ type: 'text', text: emptyContent ? error : 'Completed the first step.' }],
          timestamp: timestamp - 100,
          __openclaw: { id: 'failure', runId: 'run-1' },
        };
        const input = [{ role: 'user', content: 'Continue', timestamp: timestamp - 500 }, reply];
        const original = structuredClone(input);
        const request = vi.fn().mockResolvedValue({
          failureDetails: { failure: { errorMessage: 'Connection error.', emptyContent } },
        });
        const hydrated = await hydrateTruncatedHistoryMessages(
          { request } as unknown as GatewayClient,
          input,
          'session-1',
        );
        const normalized = await normalizeGatewayHistoryForDisplay(hydrated, {
          sessionKey: 'session-1',
        });
        const rows = projectPersistedTimeline(normalized as GatewayMessage[]).filter(
          item => item.kind === 'history-message',
        );
        expect(input).toEqual(original);
        expect(rows).toHaveLength(emptyContent ? 2 : 3);
        if (emptyContent) {
          expect(rows[1].message).toMatchObject({
            role: 'system',
            content: `${error}\nConnection error.`,
            isError: true,
            __justdoFailedRunMessage: true,
          });
        } else {
          expect(rows[1].message).toMatchObject(reply);
          expect(rows[2].message).toMatchObject({
            role: 'system',
            content: expect.stringContaining('Connection error.'),
            isError: true,
          });
        }
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test.each([false, true])(
    'preserves native commentary siblings when hydrating the main projection (capped=%s)',
    async capped => {
      const commentary = {
        role: 'assistant',
        content: [{ type: 'text', text: capped ? 'Progress\n...(truncated)...' : 'Progress' }],
        openclawStreamFallback: { source: 'segment', itemId: 'progress-1' },
        __openclaw: { id: 'm1', seq: 1, ...(capped ? { truncated: true } : {}) },
      };
      const preview = {
        role: 'assistant',
        content: 'Answer preview',
        __openclaw: { id: 'm1', seq: 1, truncated: true },
      };
      const full = { role: 'assistant', content: [{ type: 'text', text: 'Complete answer' }] };
      const request = vi.fn().mockResolvedValue({ ok: true, message: full });

      const hydrated = await hydrateTruncatedHistoryMessages(
        { request } as unknown as GatewayClient,
        [commentary, preview],
        'session-1',
      );

      expect(hydrated).toEqual([commentary, { ...full, __openclaw: { id: 'm1', seq: 1 } }]);
      expect(request.mock.calls.map(([method]) => method)).toEqual(['chat.message.get']);
    },
  );

  test('retains mixed admitted commentary when no complete matching display projection exists', async () => {
    const mixed = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Thought' },
        { type: 'text', text: 'Admitted progress\n...(truncated)...' },
        { type: 'toolCall', id: 'tool-1', name: 'read', arguments: {} },
      ],
      __openclaw: { id: 'mixed-1', seq: 1, truncated: true, reason: 'display-cap' },
    };
    const raw = {
      ...mixed,
      content: [
        ...mixed.content,
        { type: 'text', text: 'NO_REPLY', textSignature: '{"v":1,"phase":"commentary"}' },
      ],
      errorMessage: 'private provider diagnostics',
    };
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, chunk: JSON.stringify(raw), complete: true });

    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      [mixed],
      'session-1',
    );

    expect(hydrated).toEqual([mixed]);
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(hydrated)).not.toContain('private provider diagnostics');
    expect(JSON.stringify(hydrated)).not.toContain('NO_REPLY');
  });

  test('keeps admitted sibling placeholders if native get cannot return a complete display row', async () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Progress',
        openclawStreamFallback: { source: 'segment', itemId: 'progress-1' },
        __openclaw: { id: 'm1', seq: 1 },
      },
      { role: 'assistant', content: 'Preview', __openclaw: { id: 'm1', seq: 1, truncated: true } },
    ];
    const request = vi.fn().mockResolvedValue({ ok: false, unavailableReason: 'oversized' });

    expect(
      await hydrateTruncatedHistoryMessages(
        { request } as unknown as GatewayClient,
        messages,
        'session-1',
      ),
    ).toEqual(messages);
    expect(request.mock.calls.map(([method]) => method)).toEqual(['chat.message.get']);
  });

  test('does not replace a standalone capped commentary projection with the main answer', async () => {
    const messages = [
      {
        role: 'assistant',
        content: 'Progress\n...(truncated)...',
        openclawStreamFallback: { source: 'segment', itemId: 'progress-1' },
        __openclaw: { id: 'm1', truncated: true },
      },
    ];
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, message: { role: 'assistant', content: 'Answer' } });

    expect(
      await hydrateTruncatedHistoryMessages(
        { request } as unknown as GatewayClient,
        messages,
        'session-1',
      ),
    ).toEqual(messages);
    expect(request).not.toHaveBeenCalled();
  });

  test('replaces both capped and uncapped sibling projections with one complete native message', async () => {
    const thought = { type: 'thinking', thinking: 'complete thought' };
    const answer = { type: 'text', text: 'complete answer' };
    const request = vi.fn().mockResolvedValue({
      ok: true,
      message: {
        role: 'assistant',
        content: [thought, answer],
      },
    });
    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      [
        { role: 'assistant', content: [thought], __openclaw: { id: 'm1', seq: 1 } },
        {
          role: 'assistant',
          content: 'answer preview',
          __openclaw: { id: 'm1', seq: 1, truncated: true },
        },
        { role: 'user', content: 'next', __openclaw: { id: 'm2', seq: 2 } },
      ],
      'session-1',
    );
    expect(hydrated).toEqual([
      { role: 'assistant', content: [thought, answer], __openclaw: { id: 'm1', seq: 1 } },
      { role: 'user', content: 'next', __openclaw: { id: 'm2', seq: 2 } },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('stops queued hydration and chunk reads when the selected history changes', async () => {
    let current = true;
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: 'assistant',
      content: 'preview',
      __openclaw: { id: `m${index}`, truncated: true },
    }));
    const request = vi.fn(async (method: string) => {
      if (method === 'chat.message.get') return { ok: false, unavailableReason: 'oversized' };
      current = false;
      return { ok: true, chunk: '{', nextCursor: 1, complete: false, transferId: 'transfer-1' };
    });
    expect(
      await hydrateTruncatedHistoryMessages(
        { request } as unknown as GatewayClient,
        messages,
        'session-1',
        () => current,
      ),
    ).toEqual(messages);
    expect(request.mock.calls.filter(([method]) => method === 'chat.message.get')).toHaveLength(4);
    expect(
      request.mock.calls.filter(([method]) => method === 'runtimeServices.historyMessage'),
    ).toHaveLength(1);
  });

  test('checks failed assistant messages of every content shape and preserves unavailable details', async () => {
    const messages = [
      'Partial answer before the failure',
      'Context overflow: try /compact',
      [{ type: 'toolCall', id: 'tool-1', name: 'read', arguments: {} }],
    ].map((content, index) => ({
      role: 'assistant',
      stopReason: 'error',
      content,
      __openclaw: { id: `m${index}` },
    }));
    const request = vi.fn();
    expect(
      await hydrateTruncatedHistoryMessages(
        { request } as unknown as GatewayClient,
        messages,
        'session-1',
      ),
    ).toEqual(messages);
    expect(request).toHaveBeenCalledExactlyOnceWith('runtimeServices.historyDetails', {
      sessionKey: 'session-1',
      failureMessageIds: ['m0', 'm1', 'm2'],
      includeFailurePartialContent: true,
    });
  });

  test('restores failed thinking and commentary once instead of keeping generated failure copy', async () => {
    const marker = { id: 'failed-source', runId: 'run-1', seq: 153 };
    const partial = [
      { type: 'thinking', thinking: 'Partial reasoning' },
      { type: 'text', text: 'I will check the environment first.' },
    ];
    const errorMessage = 'Provider returned an incomplete or malformed tool call';
    const input = [
      {
        role: 'assistant',
        stopReason: 'error',
        content: 'Older commentary projection',
        openclawStreamFallback: { source: 'segment', itemId: 'commentary-1' },
        __openclaw: marker,
      },
      {
        role: 'assistant',
        stopReason: 'error',
        content: [{ type: 'text', text: 'The agent run failed before producing a reply.' }],
        __openclaw: marker,
      },
    ];
    const before = structuredClone(input);
    const request = vi.fn().mockResolvedValue({
      failureDetails: {
        'failed-source': {
          errorMessage,
          emptyContent: false,
          partialContent: { runId: 'run-1', content: partial, truncated: false },
        },
      },
    });

    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      input,
      'session-1',
    );
    const normalized = await normalizeGatewayHistoryForDisplay(hydrated, {
      sessionKey: 'session-1',
    });
    const timeline = projectPersistedTimeline(normalized as GatewayMessage[]);

    expect(input).toEqual(before);
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({
      content: partial,
      errorMessage,
      stopReason: 'error',
      __openclaw: marker,
    });
    const serialized = JSON.stringify(timeline);
    expect(serialized.split('Partial reasoning')).toHaveLength(2);
    expect(serialized.split('I will check the environment first.')).toHaveLength(2);
    const errors = timeline.filter(
      item => item.kind === 'history-message' && item.message.__justdoFailedRunMessage === true,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: { content: errorMessage } });
    expect(serialized).not.toContain('The agent run failed before producing a reply.');
  });

  test.each([
    { runId: 'other-run', content: [{ type: 'text', text: 'Wrong source' }], truncated: false },
    { runId: 'run-1', content: [{ type: 'toolCall', name: 'exec' }], truncated: false },
    { runId: 'run-1', content: [{ type: 'text', text: 'x'.repeat(200_001) }], truncated: false },
  ])('does not admit mismatched or invalid failure content %#', async partialContent => {
    const input = [
      {
        role: 'assistant',
        stopReason: 'error',
        content: 'Existing display',
        __openclaw: { id: 'failure', runId: 'run-1' },
      },
    ];
    const request = vi.fn().mockResolvedValue({
      failureDetails: {
        failure: { errorMessage: 'Failure', emptyContent: false, partialContent },
      },
    });
    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      input,
      'session-1',
    );
    expect(hydrated).toEqual([{ ...input[0], errorMessage: 'Failure' }]);
  });

  test('does not replace native display attachments or remove sibling tool activity', async () => {
    const marker = { id: 'failure', runId: 'run-1' };
    const attachment = {
      type: 'attachment',
      attachment: { url: 'https://example.test/report.pdf', label: 'report.pdf' },
    };
    const tool = { role: 'toolResult', toolCallId: 'call-1', content: 'Retained tool output' };
    const cases = [
      [
        {
          role: 'assistant',
          stopReason: 'error',
          __openclaw: marker,
          content: [{ type: 'text', text: 'Partial reply' }, attachment],
        },
      ],
      [
        {
          role: 'assistant',
          stopReason: 'error',
          __openclaw: marker,
          content: 'Commentary',
          __justdoAttachedToolMessages: [tool],
          activity: [{ toolCallId: 'call-1' }],
        },
        {
          role: 'assistant',
          stopReason: 'error',
          __openclaw: marker,
          content: 'Failure placeholder',
        },
      ],
    ];
    const request = vi.fn().mockResolvedValue({
      failureDetails: {
        failure: {
          errorMessage: 'Failure',
          emptyContent: false,
          partialContent: {
            runId: 'run-1',
            content: [{ type: 'text', text: 'Recovered source' }],
            truncated: false,
          },
        },
      },
    });
    for (const input of cases) {
      const hydrated = await hydrateTruncatedHistoryMessages(
        { request } as unknown as GatewayClient,
        input,
        'session-1',
      );
      expect(hydrated).toEqual(input.map(message => ({ ...message, errorMessage: 'Failure' })));
    }
  });

  test('marks bounded failure content as truncated and discards it after a history change', async () => {
    const input = [
      {
        role: 'assistant',
        stopReason: 'error',
        content: 'Failure placeholder',
        __openclaw: { id: 'failure', runId: 'run-1' },
      },
    ];
    const detail = {
      errorMessage: 'Failure',
      emptyContent: false,
      partialContent: {
        runId: 'run-1',
        content: [{ type: 'thinking', thinking: 'Partial' }],
        truncated: true,
      },
    };
    const request = vi.fn().mockResolvedValue({ failureDetails: { failure: detail } });
    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      input,
      'session-1',
    );
    expect(hydrated[0]).toMatchObject({
      __openclaw: { ...input[0].__openclaw, truncated: true, reason: 'display-cap' },
    });
    const completeRequest = vi.fn().mockResolvedValue({
      failureDetails: {
        failure: {
          ...detail,
          partialContent: { ...detail.partialContent, truncated: false },
        },
      },
    });
    const complete = await hydrateTruncatedHistoryMessages(
      { request: completeRequest } as unknown as GatewayClient,
      [
        {
          ...input[0],
          __openclaw: { ...input[0].__openclaw, truncated: true, reason: 'display-cap' },
        },
      ],
      'session-1',
    );
    expect(complete[0]).toMatchObject({ __openclaw: input[0].__openclaw });
    expect((complete[0] as Record<string, unknown>).__openclaw).not.toHaveProperty('truncated');
    let current = true;
    request.mockImplementation(async () => {
      current = false;
      return { failureDetails: { failure: detail } };
    });
    expect(
      await hydrateTruncatedHistoryMessages(
        { request } as unknown as GatewayClient,
        input,
        'session-1',
        () => current,
      ),
    ).toEqual(input);
  });

  test.each([
    'Provider finish_reason: content_filter',
    'Provider finish_reason: unsupported_terminal',
    'Deployment is paused',
  ])('retains the native cause after replacing generated failure copy: %s', errorMessage => {
    const input = [
      {
        role: 'assistant',
        stopReason: 'error',
        content: [{ type: 'text', text: '⚠️ Agent run failed (model: provider/model).' }],
        __openclaw: { id: 'failure', runId: 'run-1' },
      },
    ];
    const request = vi
      .fn()
      .mockResolvedValue({ failureDetails: { failure: { errorMessage, emptyContent: true } } });
    return hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      input,
      'session-1',
    ).then(hydrated => {
      expect(hydrated[0]).toMatchObject({
        content: [],
        errorMessage: expect.stringContaining(errorMessage),
        __openclaw: input[0].__openclaw,
      });
      expect(input[0].content).toHaveLength(1);
    });
  });

  test('discards late failure details after the history generation changes', async () => {
    const input = [
      { role: 'assistant', stopReason: 'error', content: [], __openclaw: { id: 'failure' } },
    ];
    let current = true;
    const request = vi.fn(async () => {
      current = false;
      return { failureDetails: { failure: { errorMessage: 'Stale error', emptyContent: true } } };
    });
    expect(
      await hydrateTruncatedHistoryMessages(
        { request } as unknown as GatewayClient,
        input,
        'session-1',
        () => current,
      ),
    ).toEqual(input);
  });

  test('keeps a restored internal handoff failure suppressible after generated copy is removed', async () => {
    const input = [
      {
        role: 'assistant',
        stopReason: 'error',
        content: 'Agent run failed (model: provider/model).',
        __openclaw: { id: 'failure', runId: 'run-1' },
      },
    ];
    const request = vi.fn().mockResolvedValue({
      failureDetails: {
        failure: {
          errorMessage: 'Managed subagent terminal handoff could not be persisted.',
          emptyContent: true,
        },
      },
    });
    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      input,
      'internal-session',
    );
    expect(
      await normalizeGatewayHistoryForDisplay(hydrated, { sessionKey: 'internal-session' }),
    ).toEqual([]);
  });

  test('bounds failure batches and preserves later results when a batch fails', async () => {
    const messages = Array.from({ length: 251 }, (_, index) => ({
      role: 'assistant',
      content: [],
      stopReason: 'error',
      __openclaw: { id: `m${index}` },
    }));
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        failureDetails: {
          m250: { errorMessage: 'Connection error.' },
          m0: { errorMessage: 'Wrong batch' },
        },
      });
    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      messages,
      'session-1',
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][1].failureMessageIds).toHaveLength(250);
    expect(request.mock.calls[1][1].failureMessageIds).toEqual(['m250']);
    expect(hydrated[0]).toEqual(messages[0]);
    expect(hydrated[250]).toEqual({ ...messages[250], errorMessage: 'Connection error.' });
  });

  test('recovers the exact error after hydrating a truncated failure placeholder', async () => {
    const input = [
      {
        role: 'assistant',
        content: 'Truncated',
        __openclaw: { id: 'm1', seq: 8, truncated: true },
      },
    ];
    const request = vi.fn(async (method: string) => {
      if (method === 'chat.message.get')
        return {
          ok: true,
          message: {
            role: 'assistant',
            stopReason: 'error',
            content: 'The agent run failed before producing a reply.',
          },
        };
      return { failureDetails: { m1: { errorMessage: 'Connection error.' } } };
    });
    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      input,
      'session-1',
    );
    expect(hydrated[0]).toEqual({
      role: 'assistant',
      stopReason: 'error',
      content: 'The agent run failed before producing a reply.',
      errorMessage: 'Connection error.',
      __openclaw: { id: 'm1', seq: 8 },
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'chat.message.get',
      'runtimeServices.historyDetails',
    ]);
  });

  test('restores exact errors after restart before collapsing retries and preserves later failures', async () => {
    const failure = (id: string) => ({
      role: 'assistant',
      stopReason: 'error',
      content: [{ type: 'text', text: 'The agent run failed before producing a reply.' }],
      __openclaw: { id },
    });
    const input = [
      { role: 'user', content: 'First request' },
      ...['a', 'b', 'c', 'd'].map(failure),
      { role: 'user', content: 'Second request' },
      failure('e'),
    ];
    const original = structuredClone(input);
    const request = vi.fn(
      async (method: string, params: { failureMessageIds: string[]; sessionKey: string }) => {
        expect(method).toBe('runtimeServices.historyDetails');
        expect(params.sessionKey).toBe('session-1');
        return {
          failureDetails: Object.fromEntries(
            params.failureMessageIds.map(id => [
              id,
              {
                errorMessage: id === 'e' ? 'Authentication failed.' : 'Connection error.',
                diagnostics: { private: 'must not copy' },
                errorBody: 'must not copy',
              },
            ]),
          ),
        };
      },
    );
    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      input,
      'session-1',
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(hydrated).toHaveLength(input.length);
    expect(hydrated[1]).toEqual({ ...input[1], errorMessage: 'Connection error.' });
    expect(input).toEqual(original);
    const normalized = await normalizeGatewayHistoryForDisplay(hydrated, {
      sessionKey: 'session-1',
    });
    const projected = projectPersistedTimeline(normalized as GatewayMessage[]);
    expect(
      projected.filter(item => item.kind === 'history-message').map(item => item.message.content),
    ).toEqual(['First request', 'Connection error.', 'Second request', 'Authentication failed.']);
  });

  test('keeps a fallback when the exact failure detail is unavailable and leaves other rows alone', async () => {
    const input = [
      {
        role: 'assistant',
        stopReason: 'error',
        content: 'The agent run failed before producing a reply.',
        __openclaw: { id: 'missing' },
      },
      {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'Known error',
        __openclaw: { id: 'known' },
      },
      { role: 'user', content: 'Next request', __openclaw: { id: 'user' } },
      { role: 'assistant', content: 'Success', __openclaw: { id: 'success' } },
    ];
    const request = vi.fn().mockRejectedValue(new Error('disconnected'));
    expect(
      await hydrateTruncatedHistoryMessages(
        { request } as unknown as GatewayClient,
        input,
        'session-2',
      ),
    ).toEqual(input);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('uses the native numeric offset without inventing a second pagination protocol', () => {
    const page = parseChatHistoryPage({
      messages: [{ role: 'assistant', content: 'recent' }],
      hasMore: true,
      nextOffset: 750,
    });

    expect(page).toEqual({
      messages: [{ role: 'assistant', content: 'recent' }],
      hasMore: true,
      nextCursor: 'offset:750',
    });
    expect(decodeHistoryOffsetCursor(page.nextCursor!)).toBe(750);
  });

  test('rejects partial pages that omit the next native offset', () => {
    expect(() => parseChatHistoryPage({ messages: [], hasMore: true })).toThrow('nextOffset');
  });

  test('reassembles an oversized native transcript message without losing characters', async () => {
    const output = `head:${'x'.repeat(2_100_000)}:tail`;
    const serialized = JSON.stringify({ role: 'toolResult', content: output });
    const request = vi
      .fn()
      .mockImplementation((method: string, params: Record<string, unknown>) => {
        if (method === 'chat.message.get') {
          return Promise.resolve({ ok: false, unavailableReason: 'oversized' });
        }
        if (method === 'runtimeServices.historyMessage') {
          const cursor = params.cursor as number;
          const maxChars = params.maxChars as number;
          if (cursor > 0) expect(params.transferId).toBe('transfer-1');
          const end = Math.min(serialized.length, cursor + maxChars);
          return Promise.resolve({
            ok: true,
            transferId: 'transfer-1',
            chunk: serialized.slice(cursor, end),
            complete: end === serialized.length,
            ...(end < serialized.length ? { nextCursor: end } : {}),
          });
        }
        throw new Error(`Unexpected method: ${method}`);
      });
    const placeholder = {
      role: 'assistant',
      content: '[chat.history omitted: message too large]',
      __openclaw: { id: 'message-1', seq: 7, truncated: true, reason: 'oversized' },
    };

    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      [placeholder],
      'agent:main:justdo:session-1',
    );

    expect(hydrated).toEqual([
      {
        role: 'toolResult',
        content: output,
        __openclaw: { id: 'message-1', seq: 7 },
      },
    ]);
    expect(request.mock.calls.filter(([method]) => method === 'chat.message.get')).toHaveLength(1);
    expect(
      request.mock.calls.filter(([method]) => method === 'runtimeServices.historyMessage').length,
    ).toBeGreaterThan(1);
  });

  test('falls back to the bounded transfer when chat.message.get exceeds transport limits', async () => {
    const full = {
      role: 'toolResult',
      content: 'complete output',
      __openclaw: { id: 'native-id', seq: 99, senderId: 'tool' },
    };
    const serialized = JSON.stringify(full);
    const request = vi.fn().mockImplementation((method: string) => {
      if (method === 'chat.message.get') return Promise.reject(new Error('frame too large'));
      if (method === 'runtimeServices.historyMessage') {
        return Promise.resolve({
          ok: true,
          transferId: 'transfer-2',
          chunk: serialized,
          complete: true,
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const placeholder = {
      role: 'assistant',
      content: '...(truncated)...',
      __openclaw: {
        id: 'display-id',
        seq: 7,
        replyToId: 'parent-id',
        truncated: true,
        reason: 'display-cap',
      },
    };

    const [hydrated] = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      [placeholder],
      'agent:main:justdo:session-1',
    );

    expect(hydrated).toEqual({
      role: 'toolResult',
      content: 'complete output',
      __openclaw: {
        id: 'display-id',
        seq: 7,
        senderId: 'tool',
        replyToId: 'parent-id',
      },
    });
  });

  test('hydrates one native source row only once when capped sibling projections share its id', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'complete thought' },
          { type: 'text', text: 'complete answer' },
        ],
      },
    });
    const marker = { id: 'source-1', seq: 4, truncated: true, reason: 'display-cap' };

    const hydrated = await hydrateTruncatedHistoryMessages(
      { request } as unknown as GatewayClient,
      [
        { role: 'assistant', content: 'thought preview', __openclaw: marker },
        { role: 'assistant', content: 'answer preview', __openclaw: marker },
      ],
      'agent:main:justdo:session-1',
    );

    expect(hydrated).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'complete thought' },
          { type: 'text', text: 'complete answer' },
        ],
        __openclaw: { id: 'source-1', seq: 4 },
      },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
