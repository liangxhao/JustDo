import { expect, test } from 'vitest';

import type { AssistantTurn } from './chat-transcript-state';
import {
  FAILED_RUN_MESSAGE_FLAG,
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
