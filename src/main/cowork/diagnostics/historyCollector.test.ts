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
    const result = await collectDiagnosticHistory(report, clientWith(request));
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
    const result = await collectDiagnosticHistory(report, clientWith(request));
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
    expect(await collectDiagnosticHistory(report, clientWith(request))).toMatchObject({
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
    const result = await collectDiagnosticHistory(report, clientWith(request));
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
    expect(await collectDiagnosticHistory(report, clientWith(request))).toMatchObject({
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
    expect(await collectDiagnosticHistory(report, clientWith(request))).toMatchObject({
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
    const result = await collectDiagnosticHistory(report, clientWith(request));
    expect(result).toMatchObject({ status: 'partial', omitted: 5 });
    expect(result.failures).toHaveLength(40);
    expect(result.failures[0]).toMatchObject({ clipped: true });
    expect(result.failures[0].excerpt).toHaveLength(1600);
    expect(await collectDiagnosticHistory(report, null)).toMatchObject({ status: 'unavailable' });
    const aborted = AbortSignal.abort();
    request.mockClear();
    await collectDiagnosticHistory(report, clientWith(request), aborted);
    expect(request).not.toHaveBeenCalled();
  });
});
