import { expect, test } from 'vitest';

import {
  HISTORY_FAILURE_PARTIAL_MAX_CHARS,
  HISTORY_FAILURE_PARTIAL_TRUNCATION_SUFFIX,
} from '../../openclaw-extensions/runtime-services/contracts/history-failure';
import {
  isEmptyFailureSourceContent,
  projectFailurePartialContent,
} from '../../openclaw-extensions/runtime-services/history-failure';

const failedMessage = (body: string) => ({
  role: 'assistant',
  stopReason: 'error',
  __openclaw: { runId: 'run-1' },
  content: [
    { type: 'thinking', thinking: 'Reasoning can discuss ANNOUNCE_SKIP.' },
    { type: 'text', text: body },
  ],
});

test.each([
  ['ANNOUNCE_SKIP', ''],
  ['REPLY_SKIP', ''],
  ['NO_REPLY NO_REP', ''],
  ['reply_skip reply_skip', ''],
  ['**NO_REPLY**', ''],
  ['HEARTBEAT_OK', ''],
  ['Hello\nREPLY_SKIP', 'Hello'],
  ['Hello\nNO_REPLY\nANNOUNCE_SKIP\nREPLY_SKIP', 'Hello'],
  [
    'A report mentions ANNOUNCE_SKIP in the middle.',
    'A report mentions ANNOUNCE_SKIP in the middle.',
  ],
])('suppresses control reply text while retaining real reasoning: %s', (body, expected) => {
  const partial = projectFailurePartialContent(failedMessage(body), value => value);
  expect(partial?.content.filter(block => block.type === 'text')).toEqual(
    expected ? [{ type: 'text', text: expected }] : [],
  );
  expect(partial?.content[0]).toEqual({
    type: 'thinking',
    thinking: 'Reasoning can discuss ANNOUNCE_SKIP.',
  });
});

test('makes text and reasoning truncation visible within the shared character budget', () => {
  for (const type of ['text', 'thinking'] as const) {
    const source = {
      role: 'assistant',
      stopReason: 'error',
      __openclaw: { runId: 'run-1' },
      content: [
        type === 'text'
          ? { type, text: 'x'.repeat(HISTORY_FAILURE_PARTIAL_MAX_CHARS + 1) }
          : { type, thinking: 'x'.repeat(HISTORY_FAILURE_PARTIAL_MAX_CHARS + 1) },
      ],
    };
    const partial = projectFailurePartialContent(source, value => value);
    expect(partial?.truncated).toBe(true);
    const block = partial!.content[0];
    const value = block.type === 'text' ? block.text : block.thinking;
    expect(value).toHaveLength(HISTORY_FAILURE_PARTIAL_MAX_CHARS);
    expect(value.endsWith(HISTORY_FAILURE_PARTIAL_TRUNCATION_SUFFIX)).toBe(true);
  }
});

test('suppresses repeated control fragments across text blocks', () => {
  const source = failedMessage('NO_REPLY');
  source.content.push({ type: 'text', text: 'NO_REP' });
  const partial = projectFailurePartialContent(source, value => value);
  expect(partial?.content).toEqual([source.content[0]]);
});

test('does not mistake a native stream-error placeholder for actual partial content', () => {
  const fallback = '[assistant turn failed before producing content]';
  const source = {
    role: 'assistant',
    stopReason: 'error',
    __openclaw: { runId: 'run-1' },
    content: [{ type: 'text', text: fallback }],
  };
  expect(projectFailurePartialContent(source, value => value)).toBeUndefined();
  expect(isEmptyFailureSourceContent(source)).toBe(true);
  expect(
    isEmptyFailureSourceContent({
      ...source,
      openclawDisplayContent: [
        { type: 'attachment', attachment: { url: 'https://example.test/report.pdf' } },
      ],
    }),
  ).toBe(false);
  expect(
    projectFailurePartialContent(
      { ...source, content: [{ type: 'text', text: `${fallback}Partial reply` }] },
      value => value,
    )?.content,
  ).toEqual([{ type: 'text', text: 'Partial reply' }]);
});

test('does not produce an unmarked tiny partial when the remaining batch budget cannot hold the suffix', () => {
  expect(
    projectFailurePartialContent(
      {
        role: 'assistant',
        stopReason: 'error',
        __openclaw: { runId: 'run-1' },
        content: [{ type: 'text', text: 'A longer partial reply' }],
      },
      value => value,
      5,
    ),
  ).toBeUndefined();
});
