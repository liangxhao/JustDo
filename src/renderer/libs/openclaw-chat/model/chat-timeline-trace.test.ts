import { afterEach, expect, test, vi } from 'vitest';

import { summarizeTimelineEvent, traceTextIdentity } from './chat-timeline-trace';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('summarizes ordering identities without copying text, arguments, results or credentials', () => {
  const summary = summarizeTimelineEvent({
    event: 'agent',
    seq: 20,
    payload: {
      runId: 'run-1',
      sessionKey: 'session-1',
      seq: 18,
      stream: 'thinking',
      ts: 1000,
      token: 'credential-never-log',
      data: {
        text: 'private reasoning',
        delta: 'private delta',
        args: { password: 'secret' },
        result: 'private output',
        progressSegmentFirstSeq: 10,
        progressSegmentStartedAt: 900,
      },
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'private history' },
          { type: 'toolCall', id: 'tool-1', arguments: { password: 'secret' } },
        ],
      },
    },
  });
  const serialized = JSON.stringify(summary);
  for (const forbidden of ['private', 'credential', 'secret', 'password', 'arguments']) {
    expect(serialized).not.toContain(forbidden);
  }
  expect(summary).toMatchObject({
    frameSeq: 20,
    seq: 18,
    firstSeq: 10,
    segmentStartedAt: 900,
    text: { length: 17 },
    message: { blocks: [{ type: 'thinking' }, { type: 'toolCall', id: 'tool-1' }] },
  });
});

test('ignores authentication frames and bounds message block summaries', () => {
  expect(
    summarizeTimelineEvent({ type: 'req', method: 'connect', params: { auth: 'secret' } }),
  ).toBeNull();
  expect(
    summarizeTimelineEvent({ event: 'connect.challenge', payload: { nonce: 'secret' } }),
  ).toBeNull();
  const summary = summarizeTimelineEvent({
    event: 'session.message',
    payload: {
      message: { content: Array.from({ length: 1000 }, () => ({ type: 'text', text: 'private' })) },
    },
  });
  expect((summary?.message as { blocks: unknown[] }).blocks).toHaveLength(80);
});

test('keeps tracing silent without an explicit flag and hashes matching text consistently', async () => {
  vi.stubEnv('VITE_DEBUG_CHAT_TIMELINE', undefined);
  vi.resetModules();
  const { traceTimelineWire } = await import('./chat-timeline-trace');
  const output = vi.spyOn(console, 'debug').mockImplementation(() => {});
  traceTimelineWire({ event: 'agent', payload: { seq: 1, stream: 'thinking' } });
  expect(output).not.toHaveBeenCalled();
  expect(traceTextIdentity('same')).toEqual(traceTextIdentity('same'));
  expect(traceTextIdentity('same')).not.toEqual(traceTextIdentity('else'));
});

test.each([true, false])(
  'requires a development build even when tracing is enabled (DEV=%s)',
  async development => {
    vi.stubEnv('DEV', development);
    vi.stubEnv('VITE_DEBUG_CHAT_TIMELINE', 'true');
    vi.resetModules();
    const { traceTimelineWire } = await import('./chat-timeline-trace');
    const output = vi.spyOn(console, 'debug').mockImplementation(() => {});
    traceTimelineWire({
      event: 'agent',
      payload: {
        seq: 1,
        stream: 'thinking',
        data: { text: 'private reasoning', auth: { token: 'secret' } },
      },
    });
    expect(output).toHaveBeenCalledTimes(development ? 1 : 0);
    expect(JSON.stringify(output.mock.calls)).not.toMatch(/private|secret|auth/);
  },
);
