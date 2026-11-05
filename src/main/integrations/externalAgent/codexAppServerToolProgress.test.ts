import { describe, expect, it, vi } from 'vitest';

import type { NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import type { AppServerNotify } from '../../appServer/appServerProtocol';
import { CodexAppServerToolProgress } from './codexAppServerToolProgress';

const event = (data: Record<string, unknown>, stream = 'tool'): NormalizedAgentEvent => ({
  runId: 'run',
  sessionKey: 'key',
  sessionId: null,
  lifecycleGeneration: null,
  agentId: 'main',
  spawnedBy: null,
  agentSeq: 1,
  frameSeq: null,
  deliveryEvent: 'agent',
  stream,
  timestamp: 1,
  data,
});

function fixture() {
  const notify = vi.fn<AppServerNotify>();
  const fail = vi.fn();
  const beforeTool = vi.fn();
  const now = vi.fn(() => 1000);
  const progress = new CodexAppServerToolProgress(notify, fail, beforeTool, now);
  return { progress, notify, fail, beforeTool, now };
}

describe('Codex app-server tool progress', () => {
  it('retains tool arguments and name when later events only carry output', () => {
    const { progress, notify, beforeTool, now, fail } = fixture();
    const args = { path: 'fixture.txt' };
    progress.accept(event({ phase: 'start', toolCallId: 'call', name: 'read', args }));
    args.path = 'changed-after-delivery';
    now.mockReturnValue(1234);
    progress.accept(event({ phase: 'result', toolCallId: 'call', result: 'Contents' }));

    expect(beforeTool).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
    expect(notify.mock.calls[0]).toEqual(['item/started', {
      startedAtMs: 1000,
      item: {
        type: 'mcpToolCall', id: 'call', server: PRODUCT_NAME, tool: 'read',
        arguments: { path: 'fixture.txt' }, status: 'inProgress', appContext: null,
        mcpAppUi: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null,
      },
    }]);
    expect(notify.mock.calls[1]).toEqual(['item/completed', {
      completedAtMs: 1234,
      item: {
        type: 'mcpToolCall', id: 'call', server: PRODUCT_NAME, tool: 'read',
        arguments: { path: 'fixture.txt' }, status: 'completed', appContext: null,
        mcpAppUi: null, pluginId: null, readOnlyHint: null, error: null, durationMs: 234,
        result: { content: [{ type: 'text', text: 'Contents' }], structuredContent: null, _meta: null },
      },
    }]);
  });

  it('preserves structured MCP results and explicit error information', () => {
    const { progress, notify } = fixture();
    const result = {
      content: [{ type: 'text', text: 'Could not open file' }],
      structuredContent: { reason: 'missing' },
      _meta: { source: 'fixture' },
      isError: true,
    };
    progress.accept(event({ phase: 'start', toolCallId: 'call', name: 'read' }));
    progress.accept(event({ phase: 'result', toolCallId: 'call', result, error: { message: 'File is missing.' } }));
    expect(notify.mock.calls.at(-1)?.[1].item).toMatchObject({
      status: 'failed', error: { message: 'File is missing.' },
      result: { content: result.content, structuredContent: result.structuredContent, _meta: result._meta },
    });
  });

  it('maps native textResult details to structured content while preserving explicit MCP null', () => {
    const { progress, notify } = fixture();
    const details = { status: 'completed', exitCode: 0, sessionId: 'terminal-fixture', pid: 1234 };
    const content = [{ type: 'text', text: 'Command completed' }];
    // Native textResult/jsonResult produce content plus details, rather than structuredContent.
    progress.accept(event({ phase: 'result', toolCallId: 'native', result: { content, details } }));
    expect(notify.mock.calls.at(-1)?.[1].item).toMatchObject({
      status: 'completed', result: { content, structuredContent: details },
    });
    progress.accept(event({
      phase: 'result', toolCallId: 'explicit-null',
      result: { content, details, structuredContent: null },
    }));
    expect(notify.mock.calls.at(-1)?.[1].item).toMatchObject({
      result: { content, structuredContent: null },
    });
  });

  it('uses native toolErrorSummary when a failed result has no direct error message', () => {
    const { progress, notify } = fixture();
    progress.accept(event({
      phase: 'result', toolCallId: 'invalid', isError: true,
      toolErrorSummary: 'read tool validation failed: invalid arguments',
      result: { content: [{ type: 'text', text: 'Tool validation failed' }], details: { status: 'blocked' } },
    }));
    expect(notify.mock.calls.at(-1)?.[1].item).toMatchObject({
      status: 'failed',
      error: { message: 'read tool validation failed: invalid arguments' },
      result: { structuredContent: { status: 'blocked' } },
    });
  });

  it('maps ordinary JSON output without losing its structured value', () => {
    const { progress, notify } = fixture();
    progress.accept(event({ phase: 'result', toolCallId: 'call', name: 'lookup', output: { count: 2 } }));
    expect(notify.mock.calls.map(([method]) => method)).toEqual(['item/started', 'item/completed']);
    expect(notify.mock.calls.at(-1)?.[1].item).toMatchObject({
      tool: 'lookup', durationMs: null,
      result: { content: [{ type: 'text', text: '{"count":2}' }], structuredContent: { count: 2 }, _meta: null },
    });
  });

  it('updates in-flight metadata while emitting each lifecycle once', () => {
    const { progress, notify, beforeTool } = fixture();
    progress.accept(event({ phase: 'update', toolCallId: 'call' }));
    progress.accept(event({ phase: 'start', toolCallId: 'call', name: 'actual-tool', args: { value: 1 } }));
    progress.accept(event({ phase: 'result', toolCallId: 'call', result: null }));
    progress.accept(event({ phase: 'result', toolCallId: 'call', result: 'duplicate' }));
    progress.accept(event({ phase: 'start', toolCallId: 'call' }));
    expect(beforeTool).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.at(-1)?.[1].item).toMatchObject({
      tool: 'actual-tool', arguments: { value: 1 },
      result: { content: [{ type: 'text', text: 'null' }], structuredContent: null },
    });
  });

  it('keeps a hidden native tool invisible when later events omit the visibility flag', () => {
    const { progress, notify, beforeTool, fail } = fixture();
    const args: Record<string, unknown> = { secret: 'hidden-start-input' };
    args.cyclic = args;
    progress.accept(event({
      phase: 'start', toolCallId: 'hidden', name: 'hidden-tool', args,
      hideFromChannelProgress: true,
    }));
    progress.accept(event({ phase: 'update', toolCallId: 'hidden', partialResult: 'hidden-progress' }));
    progress.accept(event({ phase: 'result', toolCallId: 'hidden', result: 'hidden-output' }));
    expect(notify).not.toHaveBeenCalled();
    expect(beforeTool).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it('stops later output and releases metadata when a visible tool becomes hidden', () => {
    const { progress, notify, beforeTool, fail } = fixture();
    const args = { value: 'x'.repeat(1800 * 1024) };
    for (let index = 0; index < 4; index++) {
      progress.accept(event({ phase: 'start', toolCallId: `visible-${index}`, args }));
    }
    progress.accept(event({ phase: 'update', toolCallId: 'visible-0', hideFromChannelProgress: true }));
    progress.accept(event({ phase: 'result', toolCallId: 'visible-0', result: 'hidden-output' }));
    // Reclaiming the hidden call's arguments leaves room for another visible call.
    progress.accept(event({ phase: 'start', toolCallId: 'visible-next', args }));
    expect(notify).toHaveBeenCalledTimes(5);
    expect(notify.mock.calls.every(([method]) => method === 'item/started')).toBe(true);
    expect(beforeTool).toHaveBeenCalledTimes(5);
    expect(fail).not.toHaveBeenCalled();
    expect(JSON.stringify(notify.mock.calls)).not.toContain('hidden-output');
  });

  it('counts hidden native identities toward the per-turn limit', () => {
    const { progress, notify, fail } = fixture();
    for (let index = 0; index <= 10_000; index++) {
      progress.accept(event({ phase: 'start', toolCallId: `hidden-${index}`, hideFromChannelProgress: true }));
    }
    expect(notify).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledExactlyOnceWith('Tool output exceeded the event limit.');
  });

  it('ignores unrelated events and rejects oversized or unserializable items', () => {
    const { progress, notify, fail } = fixture();
    progress.accept(event({ phase: 'start', toolCallId: 'not-tool' }, 'assistant'));
    progress.accept(event({ phase: 'unknown', toolCallId: 'unknown' }));
    progress.accept(event({ phase: 'start', toolCallId: 'huge', args: { value: 'x'.repeat(2 * 1024 * 1024) } }));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    progress.accept(event({ phase: 'start', toolCallId: 'cyclic', args: cyclic }));
    expect(notify).not.toHaveBeenCalled();
    expect(fail.mock.calls).toEqual([
      ['Tool output exceeded the event limit.'],
      ['Tool output could not be serialized.'],
    ]);
  });

  it('bounds outstanding metadata and releases it as tools complete', () => {
    const args = { value: 'x'.repeat(1800 * 1024) };
    const busy = fixture();
    for (let index = 0; index < 5; index++) {
      busy.progress.accept(event({ phase: 'start', toolCallId: `busy-${index}`, args }));
    }
    expect(busy.notify).toHaveBeenCalledTimes(4);
    expect(busy.fail).toHaveBeenCalledWith('Pending tool output exceeded the buffer limit.');

    const sequential = fixture();
    for (let index = 0; index < 6; index++) {
      const toolCallId = `sequential-${index}`;
      sequential.progress.accept(event({ phase: 'start', toolCallId, args }));
      sequential.progress.accept(event({ phase: 'result', toolCallId }));
    }
    expect(sequential.notify).toHaveBeenCalledTimes(12);
    expect(sequential.fail).not.toHaveBeenCalled();
  });
});
