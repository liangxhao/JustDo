import { describe, expect, it } from 'vitest';

import { readChromeExtensionHistoryDisplay, readChromeQuestionResult } from './chromeExtensionHistoryDisplay';

describe('authenticated browser history display metadata', () => {
  it('keeps only the native assistant message timestamp and actual model', () => {
    const timestampMs = Date.parse('2026-11-10T10:30:45.000Z');
    expect(readChromeExtensionHistoryDisplay({
      timestamp: timestampMs - 5000, model: 'wrong-wrapper-model',
      message: {
        role: 'assistant', timestamp: '2026-11-10T18:30:45+08:00',
        provider: 'internal', model: 'family/model',
        content: 'Answer', metadata: { token: 'private-token' },
      },
    })).toEqual({ display: { timestampMs, modelName: 'internal/family/model' } });
    expect(readChromeExtensionHistoryDisplay({
      role: 'assistant', timestamp: timestampMs, modelName: 'internal/native-model',
    })).toEqual({ display: { timestampMs, modelName: 'internal/native-model' } });
    expect(readChromeExtensionHistoryDisplay({
      model: 'wrapper-model', message: { role: 'assistant', content: 'Answer' },
    })).toEqual({});
  });

  it('omits absent or untrusted footer metadata without inventing a time or model', () => {
    for (const timestamp of [undefined, null, 0, -1, Infinity, NaN, 9e15, '123', '11/10/2026', '2026-11-10T10:30:45', 'not a date']) {
      expect(readChromeExtensionHistoryDisplay({
        role: 'assistant', timestamp, model: 'gateway-injected', startedAt: 100,
        updatedAt: 200, modelRef: 'selected-model', content: 'Answer',
      })).toEqual({});
    }
    for (const role of ['user', 'toolResult', 'system'])
      expect(readChromeExtensionHistoryDisplay({ role, timestamp: 100, model: 'native-model' })).toEqual({});
    expect(readChromeExtensionHistoryDisplay({ role: 'assistant', timestamp: 100, display: false })).toEqual({});
    expect(readChromeExtensionHistoryDisplay({ role: 'assistant', model: 'x'.repeat(501) })).toEqual({});
  });

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
    expect(readChromeQuestionResult(result, 'ask_user_question', 'call-1')).toMatchObject(questionResult);
    expect(readChromeQuestionResult({ ...result, content: undefined, result: { content: result.content } }, 'ask_user_question', 'call-1')).toMatchObject(questionResult);
    const nested = { role: 'custom', customType: 'openclaw.nested-tool.v1', content: [{ ...result, type: 'toolResult' }] };
    expect(readChromeQuestionResult(nested, 'ask_user_question', 'call-1')).toMatchObject(questionResult);
    for (const value of [
      { ...result, role: 'assistant' },
      { ...result, isError: true },
      { ...result, content: 'User selected: React' },
      { ...nested, customType: 'untrusted-custom' },
      { ...nested, content: [nested.content[0], nested.content[0]] },
    ]) expect(readChromeQuestionResult(value, 'ask_user_question', 'call-1')).toBeNull();
    expect(readChromeQuestionResult(result, 'other_tool', 'call-1')).toBeNull();
    expect(readChromeQuestionResult(result, 'ask_user_question', 'other-call')).toBeNull();
  });

  it('preserves the exact native commentary discriminator separately from its owner id', () => {
    expect(
      readChromeExtensionHistoryDisplay({
        role: 'assistant',
        content: 'Commentary',
        __openclaw: { id: 'owner-1' },
        openclawStreamFallback: { source: 'segment', itemId: 'segment-1', token: 'private-token' },
      }),
    ).toEqual({ display: { sourceId: 'owner-1', sourceSegmentId: 'segment-1' } });
  });
  it('keeps native reply errors separate from tool failures and unrelated run timing', () => {
    expect(
      readChromeExtensionHistoryDisplay({ role: 'assistant', stop_reason: 'aborted' }),
    ).toEqual({
      display: { stopReason: 'aborted' },
    });
    for (const source of [
      { role: 'toolResult', isError: true, content: 'failed' },
      { role: 'assistant', runState: 'failed', content: 'ordinary commentary' },
      { role: 'assistant', content: 'The agent run failed.' },
    ])
      expect(readChromeExtensionHistoryDisplay(source).display?.nativeFailure).toBeUndefined();
    expect(
      readChromeExtensionHistoryDisplay({
        message: { role: 'custom', customType: 'run-failed-before-reply' },
      }).display?.nativeFailure,
    ).toBe(true);
  });

  it('allows only presentation fields from compaction markers, including empty content', () => {
    const result = readChromeExtensionHistoryDisplay({
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
      readChromeExtensionHistoryDisplay({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Visible' },
          { type: 'canvas', code: 'private-html' },
        ],
      }),
    ).toEqual({ display: { keepVisible: true } });
    expect(
      readChromeExtensionHistoryDisplay({ role: 'system', __openclaw: { kind: 'reset' } }),
    ).toEqual({
      display: { kind: 'phase-boundary' },
      compactionMessage: { role: 'system', content: '', __openclaw: { kind: 'reset' } },
    });
    expect(
      readChromeExtensionHistoryDisplay({
        role: 'system',
        display: false,
        __openclaw: { kind: 'compaction', summary: 'Hidden' },
      }),
    ).toEqual({});
  });
});
