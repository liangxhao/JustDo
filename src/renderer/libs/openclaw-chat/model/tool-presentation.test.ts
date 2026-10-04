import { describe, expect, test } from 'vitest';

import type { ToolItem } from './chat-transcript-state';
import { readToolOutput } from './tool-message-adapter';
import {
  patchOperations,
  readToolPresentation,
  resolveFullToolOutput,
  summarizeTools,
  toolNesting,
  toolOutcome,
  toolTarget,
} from './tool-presentation';
const tool = (id: string, overrides: Partial<ToolItem> = {}): ToolItem => ({
  id,
  toolCallId: id,
  runId: 'r',
  type: 'tool',
  name: 'exec',
  status: 'completed',
  output: 'ok\n',
  firstSeq: 1,
  lastSeq: 2,
  startedAt: 1,
  updatedAt: 2,
  ...overrides,
});
describe('native tool presentation', () => {
  test.each([
    [
      'browser',
      { action: 'act', request: { kind: 'type', ref: 'e10', text: 'hello' } },
      'type · e10 · hello',
    ],
    [
      'browser',
      { action: 'navigate', targetUrl: 'https://example.com' },
      'navigate · https://example.com',
    ],
    ['tool_call', { tool: 'exec', arguments: { command: 'npm test' } }, 'exec · npm test'],
    ['read', { path: 'file.ts', offset: 0, limit: 50 }, 'file.ts · offset 0 · limit 50'],
  ])('extracts readable %s targets', (name, input, expected) => {
    expect(toolTarget(tool('preview', { name, input }))).toBe(expected);
  });
  test('counts operations rather than progress events or command text', () => {
    const first = tool('a');
    expect(
      summarizeTools([...Array(20).fill(first), tool('b'), tool('a', { runId: 'other' })]),
    ).toEqual({ commands: 3 });
  });
  test('preserves child failure when its wrapper succeeds without changing execution status', () => {
    const parent = tool('parent', { presentation: { suppressChannelProgress: true } });
    const child = tool('child', {
      presentation: readToolPresentation({
        result: { details: { exitCode: 1 } },
        parentToolCallId: 'parent',
      }),
    });
    expect(summarizeTools([parent, child])).toEqual({ commands: 1, failed: 1 });
    expect(toolNesting([parent, child]).get(child)).toBe(1);
    expect(child.status).toBe('completed');
  });
  test('includes failed routine activity after its running snapshot hid it', () => {
    const running = readToolPresentation({
      itemId: 'tool:poll',
      phase: 'start',
      kind: 'tool',
      status: 'running',
      hideFromChannelProgress: true,
    });
    const ended = readToolPresentation({
      itemId: 'tool:poll',
      phase: 'end',
      kind: 'tool',
      status: 'failed',
    });
    expect(
      summarizeTools([
        tool('poll', {
          name: 'process',
          presentation: { ...running, ...ended },
        }),
      ]),
    ).toEqual({ other: 1, failed: 1 });
  });
  test('keeps manual cancellation distinct from a completed command contract', () => {
    const presentation = readToolPresentation({
      kind: 'tool',
      status: 'completed',
      details: { exitReason: 'manual-cancel', exitCode: 1 },
    });
    expect(toolOutcome(tool('cancelled', { presentation }))).toBe('cancelled');
  });
  test('flattens missing, cross-run, duplicate and cyclic parents', () => {
    const a = tool('a', { presentation: { parentToolCallId: 'b' } });
    const b = tool('b', { presentation: { parentToolCallId: 'a' } });
    const missing = tool('missing', { presentation: { parentToolCallId: 'absent' } });
    const other = tool('other', { runId: 'other', presentation: { parentToolCallId: 'a' } });
    expect([...toolNesting([a, b, missing, other]).values()]).toEqual([0, 0, 0, 0]);
    const child = tool('child', { presentation: { parentToolCallId: 'parent' } });
    expect(toolNesting([tool('parent'), tool('parent'), child]).get(child)).toBe(0);
  });
  test('does not infer a successful result from a completed call with no result', () => {
    expect(toolOutcome(tool('a', { output: undefined }))).toBe('unknown');
  });
  test('reads native activity and keeps source whitespace intact', () => {
    expect(
      readToolPresentation({
        toolCallId: 'a',
        activity: [{ toolCallId: 'a', kind: 'tool', title: 'Inspect build', status: 'blocked' }],
      }),
    ).toMatchObject({ title: 'Inspect build', outcome: 'blocked' });
    expect(
      readToolOutput({
        content: [
          { type: 'text', text: '  first\n' },
          { type: 'text', text: ' second\n' },
        ],
      }),
    ).toBe('  first\n\n second\n');
  });
});

test('loads only one exact result identity and rejects partial, foreign and ambiguous results', () => {
  const identity = { runId: 'r', toolCallId: 'a', messageId: 'entry' };
  const result = { type: 'toolResult', toolCallId: 'a', text: '  output\n' };
  expect(resolveFullToolOutput({ content: [result] }, identity)).toBe('  output\n');
  expect(resolveFullToolOutput({ content: [result, result] }, identity)).toBeNull();
  expect(resolveFullToolOutput({ runId: 'other', content: [result] }, identity)).toBeNull();
  expect(
    resolveFullToolOutput({ content: [result], __openclaw: { id: 'other' } }, identity),
  ).toBeNull();
  expect(
    resolveFullToolOutput(
      { content: [result], __openclaw: { toolOutput: { captureTruncated: true } } },
      identity,
    ),
  ).toBeNull();
});
test('summarizes declared patch hunks without inventing complete before and after files', () => {
  expect(
    patchOperations(
      '*** Begin Patch\n*** Update File: 中文 file.ts\n@@\n-old\n+new\n*** End Patch',
    ),
  ).toEqual([{ path: '中文 file.ts', added: 1, removed: 1 }]);
  expect(patchOperations('not a patch')).toEqual([]);
});

test('retains explicit tool media without guessing paths from text output', () => {
  const media = readToolPresentation({ result: { content: [{ type: 'audio', mimeType: 'audio/wav', data: 'YWJj' }] } });
  expect(media.media?.[0].path).toBe('data:audio/wav;base64,YWJj');
  expect(readToolPresentation({ content: [{ type: 'text', text: 'C:/secret.wav' }] }).media).toBeUndefined();
});

test.each([
  { kind: 'tool', phase: 'end', status: 'skipped' },
  { result: { details: { status: 'skipped', deniedReason: 'steering' } } },
  { toolCallId: 'skipped', activity: [{ kind: 'tool', toolCallId: 'skipped', status: 'skipped' }] },
])('preserves native skipped operations in live and restored history: %j', source => {
  const item = tool('skipped', { status: 'failed', presentation: readToolPresentation(source) });
  expect(toolOutcome(item)).toBe('skipped');
  expect(summarizeTools([item])).toEqual({ commands: 1, skipped: 1 });
  expect(item.status).toBe('failed');
});
