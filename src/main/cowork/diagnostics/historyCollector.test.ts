import { describe, expect, it, vi } from 'vitest';

import type { DiagnosticReport } from '../../../shared/cowork/sessionDiagnostics';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { collectDiagnosticHistory } from './historyCollector';

const report = {
  sessionId: 'session-1',
  collectedAt: 3000,
  run: { id: 'product-run', startedAt: 1000, endedAt: 2000 },
  events: [{ nativeRunId: 'run-1' }],
} as DiagnosticReport;
const failedTool = {
  role: 'toolResult',
  toolName: 'exec',
  toolCallId: 'call-1',
  timestamp: 1500,
  isError: true,
  content: [{ type: 'text', text: 'ENOENT: missing file\npassword=private-value' }],
};
const clientWith = (request: ReturnType<typeof vi.fn>) =>
  ({ request }) as unknown as GatewayClientLike;

describe('native conversation diagnostic scan', () => {
  it('keeps only the latest response shape and treats timestamp ties as uncertain', async () => {
    const messages = [
      {
        role: 'assistant',
        timestamp: 1400,
        stopReason: 'stop',
        content: [{ type: 'thinking', thinking: 'SECRET' }],
      },
      {
        role: 'assistant',
        timestamp: 1500,
        stopReason: 'stop',
        content: [{ type: 'text', text: 'SECRET answer' }],
      },
    ];
    const request = vi.fn().mockResolvedValue({ messages });
    const result = await collectDiagnosticHistory(report, clientWith(request), 'native');
    expect(result.lastResponse).toMatchObject({
      timestamp: 1500,
      text: true,
      thinking: false,
      complete: true,
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    messages[0].timestamp = 1500;
    const tied = await collectDiagnosticHistory(report, clientWith(request), 'native');
    expect(tied.lastResponse?.complete).toBe(false);
  });
  it('matches native nested ids and anonymous fallback ids using tool-only block positions', async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          timestamp: 1500,
          __openclaw: { id: 'message' },
          content: [
            { type: 'text', text: 'not a tool index' },
            { type: 'toolCall', id: 'call-1', arguments: 'private' },
            { type: 'toolResult', id: 'call-1', content: 'nested failure' },
            { type: 'toolResult', content: 'anonymous failure' },
          ],
        },
        {
          role: 'toolResult',
          id: 'not-the-call-id',
          timestamp: 1600,
          __openclaw: { id: 'envelope' },
          content: 'envelope failure',
        },
      ],
      activity: [
        {
          messageId: 'message',
          items: [
            { toolCallId: 'call-1', phase: 'end', status: 'failed' },
            { toolCallId: 'history:message:2', phase: 'end', status: 'failed' },
          ],
        },
        {
          messageId: 'envelope',
          items: [{ toolCallId: 'history:envelope:0', phase: 'end', status: 'failed' }],
        },
      ],
    });
    const result = await collectDiagnosticHistory(report, clientWith(request), 'native');
    expect(result.failures.map(item => item.excerpt)).toEqual([
      'nested failure',
      'anonymous failure',
      'envelope failure',
    ]);
    expect(result.failures.every(item => item.basis === 'activity')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('retains the native startup failure receipt even when no assistant reply exists', async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [
        {
          role: 'custom',
          customType: 'run-failed-before-reply',
          timestamp: 1500,
          __openclaw: { id: 'receipt', runId: 'run-1' },
          content: 'This turn ended before a reply: state is busy',
          details: { errorKind: 'state_contention' },
        },
        {
          role: 'custom',
          customType: 'unrelated-notice',
          timestamp: 1600,
          content: 'private unrelated content',
        },
      ],
    });
    const result = await collectDiagnosticHistory(report, clientWith(request), 'native');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      kind: 'runtime',
      basis: 'failure_receipt',
      cause: 'state_contention',
      association: 'run',
      outcome: 'failed',
    });
    expect(JSON.stringify(result)).not.toContain('private unrelated content');
  });
  it('reads 9.8 activity failures after private execution details are removed', async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [
        { ...failedTool, isError: false, __openclaw: { id: 'message-1', runId: 'run-1' } },
      ],
      activity: [
        {
          messageId: 'message-1',
          items: [
            {
              itemId: 'tool:call-1',
              toolCallId: 'call-1',
              phase: 'end',
              kind: 'tool',
              status: 'failed',
              name: 'exec',
              title: 'private command',
              meta: 'private arguments',
            },
          ],
        },
      ],
    });
    const result = await collectDiagnosticHistory(report, clientWith(request), 'native');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      basis: 'activity',
      outcome: 'failed',
      association: 'run',
      tool: 'exec',
    });
    expect(JSON.stringify(result)).not.toContain('private command');
    expect(JSON.stringify(result)).not.toContain('private arguments');
  });

  it('matches both message and tool-call identity and excludes normal and skipped activity', async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [{ ...failedTool, isError: false, __openclaw: { id: 'message-1' } }],
      activity: [
        { messageId: 'other', items: [{ toolCallId: 'call-1', phase: 'end', status: 'failed' }] },
        {
          messageId: 'message-1',
          items: [
            { toolCallId: 'other', phase: 'end', status: 'failed' },
            { toolCallId: 'call-1', phase: 'end', status: 'skipped' },
          ],
        },
      ],
    });
    expect(
      (await collectDiagnosticHistory(report, clientWith(request), 'native')).failures,
    ).toEqual([]);
  });

  it('uses activity from delta pages and distinguishes blocked steps from model interruption', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ messages: [], deltaCursor: 'before' })
      .mockResolvedValueOnce({
        kind: 'delta',
        deltaCursor: 'after',
        messages: [
          { ...failedTool, isError: false, __openclaw: { id: 'message-1' } },
          { role: 'assistant', timestamp: 1800, stopReason: 'aborted' },
        ],
        activity: [
          {
            messageId: 'message-1',
            items: [{ toolCallId: 'call-1', phase: 'end', status: 'blocked' }],
          },
        ],
      });
    const result = await collectDiagnosticHistory(report, clientWith(request), 'native');
    expect(result.failures.map(item => item.outcome)).toEqual(['blocked', 'aborted']);
  });

  it('handles snake-case failures without treating user examples as tool evidence', async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [
        { ...failedTool, isError: undefined, is_error: true },
        { role: 'user', timestamp: 1500, content: [{ ...failedTool, type: 'tool_result' }] },
      ],
    });
    expect(
      (await collectDiagnosticHistory(report, clientWith(request), 'native')).failures,
    ).toHaveLength(1);
  });

  it('cancels a pending request promptly and reports why history is unavailable', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockImplementation(() => new Promise(() => {}));
    const pending = collectDiagnosticHistory(
      report,
      clientWith(request),
      'native',
      controller.signal,
    );
    controller.abort();
    expect(await pending).toMatchObject({
      status: 'unavailable',
      reason: 'canceled',
      failures: [],
    });
    expect(await collectDiagnosticHistory(report, null, 'native')).toMatchObject({
      reason: 'offline',
    });
    expect(await collectDiagnosticHistory(report, clientWith(request), null)).toMatchObject({
      reason: 'no_binding',
    });
  });
  it('uses the trusted native binding for assistant and child sessions and skips missing identities', async () => {
    const request = vi.fn().mockResolvedValue({ messages: [] });
    for (const key of ['agent:researcher:justdo:session-1', 'agent:researcher:subagent:child-1']) {
      await collectDiagnosticHistory(report, clientWith(request), key);
      expect(request).toHaveBeenLastCalledWith(
        'chat.history',
        expect.objectContaining({ sessionKey: key }),
      );
    }
    request.mockClear();
    expect(await collectDiagnosticHistory(report, clientWith(request), null)).toMatchObject({
      status: 'unavailable',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('scans older pages, extracts actual errors and excludes other runs and successful outputs', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ ...failedTool, timestamp: 2500 }],
        hasMore: true,
        nextOffset: 1,
        totalMessages: 5,
      })
      .mockResolvedValueOnce({
        messages: [
          failedTool,
          { ...failedTool, runId: 'other' },
          { ...failedTool, isError: false },
          { role: 'user', timestamp: 1500, content: 'my error example' },
        ],
        totalMessages: 5,
      });
    const result = await collectDiagnosticHistory(
      report,
      clientWith(request),
      'agent:main:justdo:session-1',
    );
    expect(result.status).toBe('scanned');
    expect(result.messagesScanned).toBe(5);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ tool: 'exec', association: 'run_window' });
    expect(result.failures[0].excerpt).toContain('ENOENT: missing file');
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(request).toHaveBeenLastCalledWith(
      'chat.history',
      expect.objectContaining({ sessionKey: 'agent:main:justdo:session-1', offset: 1 }),
    );
  });

  it('reads nested native tool results and model errors without copying user content or tool inputs', async () => {
    const request = vi.fn().mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          timestamp: 1600,
          content: [{ ...failedTool, role: undefined, type: 'toolResult' }],
        },
        {
          role: 'assistant',
          timestamp: 1700,
          stopReason: 'error',
          errorMessage: 'HTTP 429 rate limit',
          runId: 'run-1',
        },
        {
          role: 'assistant',
          timestamp: 1800,
          content: [{ type: 'toolCall', arguments: 'private prompt' }],
        },
      ],
    });
    const result = await collectDiagnosticHistory(
      report,
      clientWith(request),
      'agent:main:justdo:session-1',
    );
    expect(result.failures).toHaveLength(2);
    expect(result.failures[1]).toMatchObject({
      kind: 'model',
      excerpt: 'HTTP 429 rate limit',
      association: 'run',
    });
    expect(JSON.stringify(result)).not.toContain('private prompt');
  });

  it('discards evidence when the native history generation changed during pagination', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ messages: [failedTool], deltaCursor: 'cursor' })
      .mockResolvedValueOnce({ kind: 'reset' });
    expect(
      await collectDiagnosticHistory(report, clientWith(request), 'agent:main:justdo:session-1'),
    ).toMatchObject({
      status: 'changed',
      failures: [],
    });
  });

  it('retains native projected model failures after the Gateway removes errorMessage', async () => {
    // Native chat.history sanitizes provider errors into content text while retaining stopReason.
    const request = vi.fn().mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          timestamp: 1700,
          stopReason: 'error',
          content: [{ type: 'text', text: 'The model provider rejected the request.' }],
          __openclaw: { runId: 'run-1' },
        },
      ],
    });
    const result = await collectDiagnosticHistory(
      report,
      clientWith(request),
      'agent:main:justdo:session-1',
    );
    expect(result.status).toBe('scanned');
    expect(result.failures).toEqual([
      expect.objectContaining({
        kind: 'model',
        excerpt: 'The model provider rejected the request.',
        association: 'run',
      }),
    ]);
  });

  it('does not publish unverified evidence when the final generation check fails', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ messages: [failedTool], deltaCursor: 'cursor' })
      .mockRejectedValueOnce(new Error('disconnected'));
    expect(
      await collectDiagnosticHistory(report, clientWith(request), 'agent:main:justdo:session-1'),
    ).toMatchObject({
      status: 'partial',
      messagesScanned: 1,
      failures: [],
    });
  });

  it('discards unverified pages when pagination fails before the generation check', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [failedTool],
        deltaCursor: 'cursor',
        hasMore: true,
        nextOffset: 1,
      })
      .mockRejectedValueOnce(new Error('disconnected'));
    expect(
      await collectDiagnosticHistory(report, clientWith(request), 'agent:main:justdo:session-1'),
    ).toMatchObject({
      status: 'partial',
      messagesScanned: 1,
      failures: [],
    });
  });

  it('reports partial reads, handles offline/cancellation and bounds retained excerpts', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        messages: Array.from({ length: 45 }, (_, i) => ({
          ...failedTool,
          toolCallId: `call-${i}`,
          content: 'x'.repeat(2000),
        })),
        hasMore: true,
        nextOffset: 45,
      })
      .mockRejectedValueOnce(new Error('offline'));
    const result = await collectDiagnosticHistory(
      report,
      clientWith(request),
      'agent:main:justdo:session-1',
    );
    expect(result).toMatchObject({ status: 'partial', omitted: 5 });
    expect(result.failures).toHaveLength(40);
    expect(result.failures[0]).toMatchObject({ clipped: true });
    expect(result.failures[0].excerpt).toHaveLength(1600);
    expect(
      await collectDiagnosticHistory(report, null, 'agent:main:justdo:session-1'),
    ).toMatchObject({ status: 'unavailable' });
    const aborted = AbortSignal.abort();
    request.mockClear();
    await collectDiagnosticHistory(
      report,
      clientWith(request),
      'agent:main:justdo:session-1',
      aborted,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
