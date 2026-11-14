import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayClientLike } from '../../engine/gateway/types';
import { collectDiagnosticExportContext, type DiagnosticExportContext } from './exportContext';

const binding = { key: 'agent:work:diagnostics', nativeSessionId: 'native-instance' };
const page = (data: Record<string, unknown> = {}) => ({
  sessionKey: binding.key,
  sessionId: binding.nativeSessionId,
  messages: [],
  totalMessages: 2,
  ...data,
});
const client = (request: unknown): GatewayClientLike => ({ request }) as GatewayClientLike;
let stagingDirectory: string;
const readEntry = (result: DiagnosticExportContext) => text(result.entry!.open());
beforeEach(async () => {
  stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-context-test-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(stagingDirectory, { recursive: true, force: true });
});

describe('diagnostic conversation export', () => {
  it('exports retained history, tool and compaction details in scope and masks nested credentials', async () => {
    const at = Date.parse('2026-11-14T12:00:00.123Z');
    const first = {
      role: 'user',
      content: 'ANALYZE_INPUT',
      timestamp: at,
      __openclaw: {
        id: 'user-row',
        recordTimestampMs: at,
        senderProfileAvatarUrl: 'https://PRIVATE_AVATAR',
      },
    };
    const compaction = {
      role: 'system',
      __openclaw: { id: 'compact', kind: 'compaction', tokensBefore: 111 },
    };
    const call = {
      role: 'assistant',
      timestamp: '2026-11-14T20:00:01.123+08:00',
      content: [{ type: 'toolCall', id: 'tool-1', name: 'inspect', timestamp: at + 1000 }],
      __openclaw: { id: 'assistant-row', runId: 'native-run', recordTimestampMs: at + 1100 },
    };
    const request = vi.fn().mockImplementation(async (method, params) => {
      if (method === 'runtimeServices.historyDetails') {
        return {
          sessionId: binding.nativeSessionId,
          compactionDetails: { compact: { summary: 'Compacted details', tokensAfter: 20 } },
          toolInputs: {
            'tool-1': {
              name: 'inspect',
              input: {
                nonce: 1,
                timestamp: at,
                authentication: 'PRIVATE_AUTH',
                arguments:
                  '[{"headers":{"custom":"PRIVATE_JSON_HEADER"},"jwt":"PRIVATE_JSON_JWT"}]',
                nested: {
                  'X-ACCESS-JWT': 'PRIVATE_JWT',
                  headers: { arbitrary: 'PRIVATE_HEADER' },
                  password: 'PRIVATE_PASS',
                },
              },
            },
            'foreign-tool': { input: 'PRIVATE_FOREIGN' },
          },
        };
      }
      if (params.cursor) return { kind: 'delta', deltaCursor: 'v2', messages: [] };
      if (params.offset > 0) return page({ messages: [first, compaction] });
      return page({
        messages: [call],
        hasMore: true,
        nextOffset: 1,
        deltaCursor: 'v1',
        sessionInfo: {
          model: 'sample',
          contextTokens: 128000,
          credential: 'PRIVATE_SESSION',
          contextBudgetStatus: {
            source: 'pre-prompt-estimate',
            estimatedPromptTokens: 200,
            updatedAt: at,
            route: 'fits',
          },
        },
        thinkingLevel: 'high',
        toolOverrides: { webSearch: false, skills: { search: true } },
        pendingInputs: [{ content: 'PRIVATE_PENDING' }],
        activity: [
          {
            messageId: 'assistant-row',
            items: [{ toolCallId: 'tool-1', phase: 'start', startedAt: at + 1000 }],
          },
        ],
      });
    });
    const result = await collectDiagnosticExportContext(client(request), binding, stagingDirectory);
    const entry = await readEntry(result);
    expect(result.nativeSessionId).toBe(binding.nativeSessionId);
    expect(result.coverage).toMatchObject({
      status: 'complete',
      messages: 3,
      activityItems: 1,
      toolInputs: 1,
      compactions: 1,
    });
    expect(request).toHaveBeenCalledWith(
      'runtimeServices.historyDetails',
      {
        sessionKey: binding.key,
        sessionId: binding.nativeSessionId,
        compactionEntryIds: ['compact'],
        toolCallIds: ['tool-1'],
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(entry).toContain(
      ['', '  "messages": [', '    {', '      "message": {', ''].join(os.EOL),
    );
    expect(result.coverage.bytes).toBe(Buffer.byteLength(entry));
    expect(JSON.parse(entry)).toEqual({
      session: expect.objectContaining({
        configuredModel: { model: 'sample', contextTokens: 128000 },
        thinkingLevel: 'high',
        contextBudget: expect.objectContaining({ updatedAt: '2026-11-14T12:00:00.123Z' }),
      }),
      messages: [
        {
          message: {
            ...first,
            timestamp: '2026-11-14T12:00:00.123Z',
            __openclaw: { id: 'user-row' },
          },
        },
        { message: compaction },
        {
          message: {
            ...call,
            timestamp: '2026-11-14T12:00:01.123Z',
            content: [
              {
                type: 'toolCall',
                id: 'tool-1',
                name: 'inspect',
                timestamp: '2026-11-14T12:00:01.123Z',
              },
            ],
            __openclaw: {
              id: 'assistant-row',
              runId: 'native-run',
              recordTimestamp: '2026-11-14T12:00:01.223Z',
            },
          },
          activity: [
            { toolCallId: 'tool-1', phase: 'start', startedAt: '2026-11-14T12:00:01.123Z' },
          ],
        },
      ],
      toolInputs: [
        expect.objectContaining({
          id: 'tool-1',
          detail: expect.objectContaining({ input: expect.objectContaining({ timestamp: at }) }),
        }),
      ],
      compactions: [{ id: 'compact', detail: { summary: 'Compacted details', tokensAfter: 20 } }],
    });
    expect(entry).not.toContain('PRIVATE_');
  });

  it.each(['identity', 'reset', 'details'])(
    'withdraws already-read content when native history changes during %s',
    async scenario => {
      const request = vi.fn().mockImplementation(async (method, params) => {
        if (method === 'runtimeServices.historyDetails') {
          if (scenario === 'details') return { status: 'changed' };
          return {
            sessionId: binding.nativeSessionId,
            toolInputs: {},
            compactionDetails: { compact: { summary: 'captured before verification' } },
          };
        }
        if (params.cursor)
          return scenario === 'reset'
            ? { kind: 'reset' }
            : { kind: 'delta', messages: [], deltaCursor: 'v2' };
        if (params.offset > 0) return page({ sessionId: 'other-instance' });
        return page({
          messages: [{ role: 'system', __openclaw: { id: 'compact', kind: 'compaction' } }],
          hasMore: scenario === 'identity',
          ...(scenario === 'identity' ? { nextOffset: 1 } : {}),
          deltaCursor: 'v1',
        });
      });
      const result = await collectDiagnosticExportContext(
        client(request),
        binding,
        stagingDirectory,
      );
      expect(result).toMatchObject({
        coverage: {
          status: 'changed',
          reasons: [scenario === 'reset' ? 'history_changed' : 'native_instance_changed'],
          messages: 0,
          bytes: 0,
        },
      });
      expect(result.entry).toBeUndefined();
      expect(result.nativeSessionId).toBeUndefined();
      if (scenario === 'reset') {
        const methods = request.mock.calls.map(([method, params]) =>
          params.cursor ? 'verify' : method,
        );
        expect(methods).toEqual(['chat.history', 'runtimeServices.historyDetails', 'verify']);
      }
    },
  );

  it('keeps partial history but omits hydrated details when the final verification fails', async () => {
    const request = vi.fn().mockImplementation(async (method, params) => {
      if (method === 'runtimeServices.historyDetails')
        return {
          sessionId: binding.nativeSessionId,
          toolInputs: {},
          compactionDetails: { compact: { summary: 'DETAIL_SHOULD_BE_WITHDRAWN' } },
        };
      if (params.cursor) throw new Error('deadline interrupted final cursor read');
      return page({
        messages: [{ role: 'system', __openclaw: { id: 'compact', kind: 'compaction' } }],
        deltaCursor: 'v1',
      });
    });
    const result = await collectDiagnosticExportContext(client(request), binding, stagingDirectory);
    expect(result.coverage).toMatchObject({
      status: 'partial',
      reasons: ['verification_failed'],
      messages: 1,
      compactions: 0,
    });
    const entry = await readEntry(result);
    expect(entry).toContain('compact');
    expect(entry).not.toContain('DETAIL_SHOULD_BE_WITHDRAWN');
    expect(JSON.parse(entry).compactions).toEqual([]);
  });

  it('rehydrates an oversized row through the authorized single-message API', async () => {
    const request = vi.fn().mockImplementation(async (method, params) => {
      if (method === 'chat.message.get')
        return {
          ok: true,
          message: { role: 'user', content: 'RECOVERED', __openclaw: { id: 'large' } },
        };
      if (params.cursor) return { kind: 'delta', messages: [], deltaCursor: 'v2' };
      return page({
        messages: [
          { role: 'user', content: 'PLACEHOLDER', __openclaw: { id: 'large', truncated: true } },
        ],
        deltaCursor: 'v1',
      });
    });
    const result = await collectDiagnosticExportContext(client(request), binding, stagingDirectory);
    expect(request).toHaveBeenCalledWith(
      'chat.message.get',
      {
        sessionKey: binding.key,
        sessionId: binding.nativeSessionId,
        messageId: 'large',
        maxChars: 500_000,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(result.coverage).toMatchObject({
      status: 'complete',
      recoveredMessages: 1,
      upstreamTruncatedMessages: 0,
    });
    const entry = await readEntry(result);
    expect(entry).toContain('RECOVERED');
    expect(entry).not.toContain('PLACEHOLDER');
  });

  it('exports every page in history order past the previous size and page limits', async () => {
    const totalMessages = 204;
    const message = (id: string) => ({
      role: 'user',
      content: Array.from({ length: 80 }, () => ({
        type: 'text',
        text: `${id} ${'中'.repeat(300)}`,
      })),
      __openclaw: { id },
    });
    const request = vi.fn().mockImplementation(async (_method, params) =>
      params.cursor
        ? { kind: 'delta', messages: [], deltaCursor: 'v2' }
        : page({
            messages: [message(`ROW-${params.offset}`)],
            hasMore: params.offset + 1 < totalMessages,
            nextOffset: params.offset + 1,
            deltaCursor: 'v1',
            totalMessages,
          }),
    );
    const result = await collectDiagnosticExportContext(client(request), binding, stagingDirectory);
    expect(result.coverage).toMatchObject({
      status: 'complete',
      pagesRead: totalMessages,
      messages: totalMessages,
    });
    const entry = await readEntry(result);
    expect(result.coverage.bytes).toBe(Buffer.byteLength(entry));
    expect(result.coverage.bytes).toBeGreaterThan(12 * 1024 * 1024);
    const messages = JSON.parse(entry).messages;
    expect(messages).toHaveLength(totalMessages);
    expect(messages[0].message.__openclaw.id).toBe(`ROW-${totalMessages - 1}`);
    expect(messages.at(-1).message.__openclaw.id).toBe('ROW-0');
  });

  it('releases pending reads on cancellation and publishes no content', async () => {
    const request = vi.fn().mockImplementation(() => new Promise(() => {}));
    const abort = new AbortController();
    const pending = collectDiagnosticExportContext(
      client(request),
      binding,
      stagingDirectory,
      abort.signal,
    );
    abort.abort();
    expect(await pending).toMatchObject({
      coverage: { status: 'unavailable', reasons: ['canceled'] },
    });
  });
});
