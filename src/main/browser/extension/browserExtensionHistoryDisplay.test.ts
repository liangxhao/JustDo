import { describe, expect, it } from 'vitest';

import { readBrowserExtensionHistoryDisplay, readBrowserQuestionResult } from './browserExtensionHistoryDisplay';

describe('authenticated browser history display metadata', () => {
  it('projects question answers only from their matched native result and structured envelope', () => {
    const questionResult = {
      version: 1,
      questions: [{ id: 'stack', question: 'Which stack?', options: [{ id: 'react', label: 'React' }, { id: 'vue', label: 'Vue' }] }],
      response: { status: 'answered', answers: { stack: { selected: ['react'] } } },
    };
    const result = {
      role: 'toolResult', toolCallId: 'call-1', toolName: 'ask_user_question',
      content: [{ type: 'text', text: JSON.stringify({ askUserQuestion: questionResult, summary: 'User selected: React' }) }],
    };
    expect(readBrowserQuestionResult(result, 'ask_user_question', 'call-1')).toMatchObject(questionResult);
    expect(readBrowserQuestionResult({ ...result, content: undefined, result: { content: result.content } }, 'ask_user_question', 'call-1')).toMatchObject(questionResult);
    const nested = { role: 'custom', customType: 'openclaw.nested-tool.v1', content: [{ ...result, type: 'toolResult' }] };
    expect(readBrowserQuestionResult(nested, 'ask_user_question', 'call-1')).toMatchObject(questionResult);
    for (const value of [
      { ...result, role: 'assistant' },
      { ...result, isError: true },
      { ...result, content: 'User selected: React' },
      { ...nested, customType: 'untrusted-custom' },
      { ...nested, content: [nested.content[0], nested.content[0]] },
    ]) expect(readBrowserQuestionResult(value, 'ask_user_question', 'call-1')).toBeNull();
    expect(readBrowserQuestionResult(result, 'other_tool', 'call-1')).toBeNull();
    expect(readBrowserQuestionResult(result, 'ask_user_question', 'other-call')).toBeNull();
  });

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
