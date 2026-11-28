import { expect, test } from 'vitest';

import type { AssistantTurn } from '../chat-transcript-state';
import { projectPersistedMessagesForActiveTurn } from '../history/optimistic-history-tail';
import {
  FAILED_RUN_MESSAGE_FLAG,
  isFailedRunMessage,
  projectRecoveredOutputCutoffMessages,
  readFailedRunMessageText,
  readNativeFailureDetails,
  readUncoveredFailureDetail,
  withFailureDetailsForDisplay,
} from './failed-run-message';

const detail = 'Provider finish_reason: unsupported_terminal';
const nativeFailure = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Partial reply' }],
  stopReason: 'error',
  errorMessage: detail,
  __openclaw: { id: 'message-1', runId: 'run-1' },
};

const cutoffNotice = {
  role: 'system',
  runId: 'run-1',
  content: '⚠️ The model was cut off at its output token limit. Some work may be unfinished.',
  [FAILED_RUN_MESSAGE_FLAG]: true,
};
const cutoffSummary = {
  role: 'assistant',
  content: [{ type: 'text', text: 'The saved file is ready.' }],
  stopReason: 'stop',
  __openclaw: { id: 'summary-entry', runId: 'run-1' },
};
const cutoffToolResult = {
  role: 'toolResult',
  content: [{ type: 'text', text: 'saved' }],
  __openclaw: { id: 'tool-entry', runId: 'run-1' },
};

test('hides only the duplicate cutoff row when the same run has a visible native summary', () => {
  const otherFailure = { ...cutoffNotice, content: 'The provider rejected the request.' };
  const cutoffWithTools = { ...cutoffNotice, __justdoAttachedToolMessages: [cutoffToolResult] };
  const original = [nativeFailure, cutoffToolResult, cutoffNotice, cutoffSummary, otherFailure, cutoffWithTools];

  expect(projectRecoveredOutputCutoffMessages(original))
    .toEqual([nativeFailure, cutoffToolResult, cutoffSummary, otherFailure, cutoffWithTools]);
  expect(original).toContain(cutoffNotice);
});

test('keeps cutoff notices when a successful-looking summary cannot be used for the same run', () => {
  for (const messages of [
    [cutoffNotice],
    [cutoffNotice, cutoffSummary],
    [cutoffToolResult, cutoffNotice, { ...cutoffSummary, __openclaw: { id: 'other', runId: 'run-2' } }],
    [cutoffToolResult, cutoffNotice, { runId: 'different-run', message: cutoffSummary }],
    [cutoffToolResult, cutoffNotice, { run_id: 'different-run', message: cutoffSummary }],
    [cutoffToolResult, cutoffNotice, { openclawStreamFallback: { source: 'segment' }, message: cutoffSummary }],
    [cutoffToolResult, cutoffNotice, { ...cutoffSummary, endTurn: false }],
    [cutoffToolResult, cutoffNotice, { ...cutoffSummary, content: [...cutoffSummary.content, { type: 'toolCall', id: 'next', name: 'read' }] }],
    [cutoffToolResult, cutoffNotice, { ...cutoffSummary, content: 'NO_REPLY' }],
    [cutoffToolResult, cutoffNotice, cutoffSummary, { ...cutoffSummary, stopReason: 'length' }],
    [cutoffToolResult, cutoffNotice, cutoffSummary, { ...cutoffToolResult, __openclaw: { id: 'later-tool', runId: 'run-1' } }],
  ]) {
    expect(projectRecoveredOutputCutoffMessages(messages)).toContain(cutoffNotice);
  }
});

test('leaves the active turn failed and removes only the separate notice after the summary is visible', () => {
  const terminal = {
    type: 'terminal', runId: 'run-1', status: 'error', message: cutoffNotice.content,
  };
  const content = {
    type: 'content', runId: 'run-1', status: 'completed', text: cutoffSummary.content[0].text,
  };
  const turn = { runId: 'run-1', status: 'error', items: [content, terminal], toolById: new Map() } as AssistantTurn;
  const history = [cutoffToolResult, cutoffSummary, { ...cutoffNotice, __openclaw: { id: 'notice', runId: 'run-1' } }];
  const display = withFailureDetailsForDisplay(turn, history);

  expect(display).toMatchObject({
    status: 'error',
    items: [content],
  });
  expect(turn.items).toContain(terminal);
  expect(projectPersistedMessagesForActiveTurn(history, turn, null, display)).toEqual([]);
  expect(withFailureDetailsForDisplay({ ...turn, items: [terminal] } as AssistantTurn, history)?.items)
    .toEqual([terminal]);
});

test('replaces an interrupted summary preview without repeating or dropping earlier work', () => {
  const reply = 'The saved file is ready.';
  const preamble = { type: 'content', runId: 'run-1', status: 'completed', text: 'I will save the file.' };
  const tool = { type: 'tool', runId: 'run-1', status: 'completed' };
  const preview = { type: 'content', runId: 'run-1', status: 'interrupted', text: 'The saved file' };
  const cutoff = { type: 'terminal', runId: 'run-1', status: 'error', message: cutoffNotice.content };
  const turn = {
    runId: 'run-1', status: 'error', outputCutoffReply: reply, items: [preamble, tool, preview, cutoff],
  } as AssistantTurn;

  expect(withFailureDetailsForDisplay(turn, [])?.items).toEqual([
    preamble, tool, { ...preview, text: reply, status: 'completed', sourceMode: 'snapshot' },
  ]);
  expect(turn.items).toEqual([preamble, tool, preview, cutoff]);
});

test.each([false, true])(
  'recognizes native pre-reply failure receipts (enveloped=%s)',
  enveloped => {
    const receipt = {
      role: 'custom',
      customType: 'run-failed-before-reply',
      content:
        "Your request couldn't be completed: Persisted user turn changed before replay admission",
      display: true,
      __openclaw: { id: 'failure-receipt', runId: 'run-1' },
    };
    expect(isFailedRunMessage(enveloped ? { message: receipt } : receipt)).toBe(true);
    for (const message of [
      { ...receipt, role: 'assistant' },
      { ...receipt, role: 'user' },
      { ...receipt, customType: 'another-notice', isError: true },
      { ...receipt, customType: undefined },
    ]) {
      expect(isFailedRunMessage(enveloped ? { message } : message)).toBe(false);
    }
  },
);

test.each([false, true])(
  'keeps only the public native contention diagnostic (enveloped=%s)',
  enveloped => {
    const summary =
      'Your request was interrupted while the server was busy. Check its status before trying again.';
    const diagnostic =
      'SQLite transaction admission remained busy. Execution may have occurred; check the recorded outcome before resending.';
    const receipt = {
      role: 'custom',
      customType: 'run-failed-before-reply',
      content: summary,
      details: { errorKind: 'state_contention', diagnostic, error: 'Private report detail' },
    };
    const wrap = (message: unknown) => (enveloped ? { message } : message);
    expect(readFailedRunMessageText(wrap(receipt))).toBe(`${summary}\n${diagnostic}`);
    expect(
      readFailedRunMessageText(wrap({ ...receipt, content: [{ type: 'text', text: summary }] })),
    ).toBe(`${summary}\n${diagnostic}`);
    expect(
      readFailedRunMessageText(wrap({ ...receipt, content: `${summary}\n${diagnostic}` })),
    ).toBe(`${summary}\n${diagnostic}`);
    expect(readFailedRunMessageText(wrap({ ...receipt, customType: 'another-notice' }))).toBe(
      summary,
    );
    expect(
      readFailedRunMessageText(
        wrap({ ...receipt, details: { ...receipt.details, errorKind: 'unknown' } }),
      ),
    ).toBe(summary);
    expect(
      readFailedRunMessageText(
        wrap({ ...receipt, details: { ...receipt.details, diagnostic: 'x'.repeat(5000) } }),
      ),
    ).toBe(`${summary}\n${'x'.repeat(2000)}`);
  },
);

test('collects only exact native run diagnostics and preserves partial reply identity', () => {
  const messages = [
    nativeFailure,
    {
      ...nativeFailure,
      __openclaw: { id: 'other', runId: 'other-run' },
      errorMessage: 'Other error',
    },
    { ...nativeFailure, __openclaw: undefined, errorMessage: 'Unbound error' },
  ];
  expect(readNativeFailureDetails(messages, 'run-1')).toBe(detail);
  expect(readUncoveredFailureDetail(nativeFailure, [])).toBe(detail);
  expect(
    readUncoveredFailureDetail(nativeFailure, [
      {
        role: 'system',
        runId: 'run-1',
        content: `Provider request failed. ${detail}`,
        [FAILED_RUN_MESSAGE_FLAG]: true,
      },
    ]),
  ).toBe('');
});

test('bounds the visible diagnostic even when complete-message hydration supplies a longer error', () => {
  const failure = { ...nativeFailure, errorMessage: 'x'.repeat(5000) };
  expect(readUncoveredFailureDetail(failure, [])).toHaveLength(2000);
  expect(readNativeFailureDetails([failure], 'run-1')).toHaveLength(2000);
});

test('keeps internal handoff details out of the visible native diagnostics', () => {
  const failure = {
    ...nativeFailure,
    errorMessage: 'Managed subagent terminal handoff could not be persisted.',
  };
  expect(readUncoveredFailureDetail(failure, [])).toBe('');
  expect(readNativeFailureDetails([failure], 'run-1')).toBe('');
});

test('enriches a display copy of a generic terminal without changing execution state', () => {
  const turn = {
    runId: 'run-1',
    status: 'error',
    items: [{ type: 'terminal', message: '⚠️ Agent run failed (model: provider/model).' }],
  } as AssistantTurn;
  const before = structuredClone(turn);
  const display = withFailureDetailsForDisplay(turn, [nativeFailure]);
  expect(display?.items[0]).toMatchObject({ message: expect.stringContaining(detail) });
  expect(turn).toEqual(before);
  expect(display?.status).toBe(turn.status);
  expect(
    withFailureDetailsForDisplay({ ...turn, status: 'running' }, [nativeFailure]),
  ).toMatchObject({ status: 'running', items: before.items });
  const specific = {
    ...turn,
    items: [{ ...turn.items[0], message: 'Session writer lost ownership' }],
  } as AssistantTurn;
  expect(withFailureDetailsForDisplay(specific, [nativeFailure])?.items[0]).toMatchObject({
    message: `Session writer lost ownership\n${detail}`,
  });
  expect(specific.items[0]).toMatchObject({ message: 'Session writer lost ownership' });
});

test('reads normalized model failures but never arbitrary system notices or private receipts', () => {
  const failure = {
    ...nativeFailure,
    role: 'system',
    content: detail,
    [FAILED_RUN_MESSAGE_FLAG]: true,
  };
  expect(readNativeFailureDetails([failure], 'run-1')).toBe(detail);
  expect(
    readNativeFailureDetails(
      [{ ...failure, errorMessage: `⚠️ OpenClaw couldn't finish this reply.\n${detail}` }],
      'run-1',
    ),
  ).toBe(`⚠️ OpenClaw couldn't finish this reply.\n${detail}`);
  for (const unrelated of [
    { ...failure, [FAILED_RUN_MESSAGE_FLAG]: false },
    { ...failure, stopReason: undefined },
    { ...failure, __openclaw: { seq: 1, runId: 'run-1' } },
    { ...failure, __openclaw: { id: 'other', runId: 'run-2' } },
    { ...failure, role: 'custom', customType: 'run-failed-before-reply' },
  ]) {
    expect(readNativeFailureDetails([unrelated], 'run-1')).toBe('');
  }
});
