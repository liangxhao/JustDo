import { describe, expect, test, vi } from 'vitest';

import { projectPersistedTimeline } from '../model/project-history-timeline';
import { normalizeGatewayHistoryForDisplay } from '../pipeline/history-display-normalizer';
import type { GatewayMessage } from '../types';
import {
  decodeHistoryOffsetCursor,
  hydrateTruncatedHistoryMessages,
  parseChatHistoryPage,
} from './chat-history-protocol';
import type { GatewayClient } from './client';

describe('OpenClaw chat history protocol', () => {
  test('does not fetch details for partial replies, tool blocks or actionable provider guidance', async () => {
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
    expect(request).not.toHaveBeenCalled();
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
      'justdoRuntimeBridge.historyDetails',
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
        expect(method).toBe('justdoRuntimeBridge.historyDetails');
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
        if (method === 'justdoRuntimeBridge.historyMessage') {
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
      request.mock.calls.filter(([method]) => method === 'justdoRuntimeBridge.historyMessage')
        .length,
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
      if (method === 'justdoRuntimeBridge.historyMessage') {
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
