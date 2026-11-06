import { expect, test } from 'vitest';

import { isEmptyFailureSourceContent, projectFailurePartialContent } from '../history-failure';

const diagnostic =
  'OpenClaw stopped this turn after 3 consecutive identical tool failures. Check the tool arguments or switch to a model with native tool calling before retrying.';
const nativeFailure = {
  role: 'assistant',
  stopReason: 'error',
  errorCode: 'openclaw_repeated_tool_error',
  errorMessage: diagnostic,
  content: [{ type: 'text', text: diagnostic }],
  __openclaw: { runId: 'run-1' },
};

test('keeps a native repeated-tool terminal diagnostic out of recovered reply content', () => {
  const source = structuredClone(nativeFailure);
  expect(isEmptyFailureSourceContent(source)).toBe(true);
  expect(projectFailurePartialContent(source, value => value)).toBeUndefined();
  expect(source).toEqual(nativeFailure);
});

test('requires native failure metadata rather than recognizing the diagnostic wording', () => {
  for (const source of [
    { ...nativeFailure, errorCode: undefined },
    { ...nativeFailure, errorCode: 'another_failure' },
    { ...nativeFailure, stopReason: 'stop' },
    { ...nativeFailure, role: 'user' },
  ]) {
    expect(isEmptyFailureSourceContent(source)).toBe(false);
  }
  expect(
    projectFailurePartialContent({ ...nativeFailure, errorCode: undefined }, value => value)
      ?.content,
  ).toEqual(nativeFailure.content);
});

test('uses the source diagnostic contract without depending on an English template', () => {
  const source = {
    ...nativeFailure,
    errorMessage: '  工具连续失败，本轮已停止。  ',
    content: [{ type: 'text', text: '工具连续失败，本轮已停止。' }],
  };
  expect(isEmptyFailureSourceContent(source)).toBe(true);
  expect(projectFailurePartialContent(source, value => value)).toBeUndefined();
});

test('preserves real partial replies and reasoning on a coded failure source', () => {
  const content = [
    { type: 'thinking', thinking: 'The last tool request needs a different path.' },
    { type: 'text', text: 'I found the project settings.' },
  ];
  const source = { ...nativeFailure, content };
  expect(isEmptyFailureSourceContent(source)).toBe(false);
  expect(projectFailurePartialContent(source, value => value)?.content).toEqual(content);
  expect(
    isEmptyFailureSourceContent({ ...nativeFailure, errorMessage: 'A different failure' }),
  ).toBe(false);
});

test('does not clear competing display content, fallback text or tool activity', () => {
  for (const retained of [
    { openclawDisplayContent: [{ type: 'text', text: 'Visible attachment' }] },
    { text: 'A real partial reply' },
    { activity: [{ type: 'toolCall', id: 'call-1', name: 'read' }] },
    { __justdoAttachedToolMessages: [{ role: 'toolResult', content: 'File content' }] },
    { openclawDelivery: { mediaUrls: ['output/report.pdf'] } },
    { __openclaw: { runId: 'run-1', media: [{ path: 'output/chart.png' }] } },
    { content: [...nativeFailure.content, { type: 'toolCall', id: 'call-1', name: 'read' }] },
  ]) {
    expect(isEmptyFailureSourceContent({ ...nativeFailure, ...retained })).toBe(false);
  }
});
