import { describe, expect, test, vi } from 'vitest';

import {
  decodeHistoryOffsetCursor,
  hydrateTruncatedHistoryMessages,
  parseChatHistoryPage,
} from './chat-history-protocol';
import type { GatewayClient } from './client';

describe('OpenClaw chat history protocol', () => {
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
