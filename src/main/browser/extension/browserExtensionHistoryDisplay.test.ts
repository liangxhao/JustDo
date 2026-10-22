import { describe, expect, it } from 'vitest';

import { readBrowserExtensionHistoryDisplay } from './browserExtensionHistoryDisplay';

describe('authenticated browser history display metadata', () => {
  it('preserves the exact native commentary discriminator separately from its owner id', () => {
    expect(
      readBrowserExtensionHistoryDisplay({
        role: 'assistant',
        content: 'Commentary',
        __openclaw: { id: 'owner-1' },
        openclawStreamFallback: { source: 'segment', itemId: 'segment-1', token: 'private-token' },
      }),
    ).toEqual({ display: { sourceId: 'owner-1', sourceSegmentId: 'segment-1' } });
  });
  it('keeps native reply errors separate from tool failures and unrelated run timing', () => {
    expect(
      readBrowserExtensionHistoryDisplay({ role: 'assistant', stop_reason: 'aborted' }),
    ).toEqual({
      display: { stopReason: 'aborted' },
    });
    for (const source of [
      { role: 'toolResult', isError: true, content: 'failed' },
      { role: 'assistant', runState: 'failed', content: 'ordinary commentary' },
      { role: 'assistant', content: 'The agent run failed.' },
    ])
      expect(readBrowserExtensionHistoryDisplay(source).display?.nativeFailure).toBeUndefined();
    expect(
      readBrowserExtensionHistoryDisplay({
        message: { role: 'custom', customType: 'run-failed-before-reply' },
      }).display?.nativeFailure,
    ).toBe(true);
  });

  it('allows only presentation fields from compaction markers, including empty content', () => {
    const result = readBrowserExtensionHistoryDisplay({
      role: 'system',
      content: '',
      timestamp: 123,
      __openclaw: {
        id: 'native-compaction',
        kind: 'compaction-status',
        phase: 'completed',
        summary: 'Retained task summary',
        reason: 'Native reason',
        tokensBefore: 100,
        tokensAfter: 40,
        rawReport: 'private-report',
        token: 'private-token',
        runId: 'native-run',
      },
    });
    expect(result).toEqual({
      display: { sourceId: 'native-compaction', kind: 'compaction-status', phase: 'completed' },
      compactionMessage: {
        role: 'system',
        content: '',
        timestamp: 123,
        __openclaw: {
          id: 'native-compaction',
          kind: 'compaction-status',
          phase: 'completed',
          summary: 'Retained task summary',
          reason: 'Native reason',
          tokensBefore: 100,
          tokensAfter: 40,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(JSON.stringify(result)).not.toContain('native-run');
  });

  it('protects filtered interactive content and forwards a real reset as an empty boundary', () => {
    expect(
      readBrowserExtensionHistoryDisplay({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Visible' },
          { type: 'canvas', code: 'private-html' },
        ],
      }),
    ).toEqual({ display: { keepVisible: true } });
    expect(
      readBrowserExtensionHistoryDisplay({ role: 'system', __openclaw: { kind: 'reset' } }),
    ).toEqual({
      display: { kind: 'phase-boundary' },
      compactionMessage: { role: 'system', content: '', __openclaw: { kind: 'reset' } },
    });
    expect(
      readBrowserExtensionHistoryDisplay({
        role: 'system',
        display: false,
        __openclaw: { kind: 'compaction', summary: 'Hidden' },
      }),
    ).toEqual({});
  });
});
