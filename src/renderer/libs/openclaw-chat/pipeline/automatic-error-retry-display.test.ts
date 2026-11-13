import { FAILED_RUN_MESSAGE_FLAG } from '@shared/openclaw/runFailureDisplay';
import { describe, expect, it } from 'vitest';

import type { AssistantTurn } from '../model/chat-transcript-state';
import { projectRetryFailureMessages, projectRetryFailureTurn } from './automatic-error-retry-display';

const failure = {
  role: 'assistant', content: [{ type: 'text', text: 'terminal failure' }],
  runId: 'run', stopReason: 'error', errorMessage: 'terminal failure',
};

describe('automatic error retry display projection', () => {
  it('hides only selected intermediate failure copies and retains tools, media and original messages', () => {
    const tool = { role: 'toolResult', content: 'tool failure details', toolCallId: 'tool' };
    const file = { type: 'file', path: 'output.txt' };
    const failed = { ...failure, content: [...failure.content, file], __justdoAttachedToolMessages: [tool] };
    const other = { ...failure, runId: 'other' };
    const valid = { role: 'assistant', runId: 'run', content: 'Useful partial reply' };
    const input = [failed, other, valid];
    const projected = projectRetryFailureMessages(input, new Set(['run']));
    expect(projected[0]).toMatchObject({ content: [file], __justdoAttachedToolMessages: [tool] });
    expect(projected[0]).not.toHaveProperty('errorMessage');
    expect(projected[1]).toBe(other);
    expect(projected[2]).toBe(valid);
    expect(failed.content).toEqual([...failure.content, file]);
    expect(failed.errorMessage).toBe('terminal failure');
  });

  it('filters active terminal copy without changing native status, valid content or tools', () => {
    const terminal = { type: 'terminal', status: 'error', message: 'terminal failure' };
    const useful = { type: 'content', text: 'Useful partial reply' };
    const echoed = { type: 'content', text: 'terminal failure' };
    const tool = { type: 'tool', id: 'tool' };
    const turn = { runId: 'run', status: 'error', items: [useful, echoed, tool, terminal], toolById: new Map() } as unknown as AssistantTurn;
    const projected = projectRetryFailureTurn(turn, new Set(['run']))!;
    expect(projected.status).toBe('error');
    expect(projected.items).toEqual([useful, tool]);
    expect(turn.items).toHaveLength(4);
  });

  it('does not hide a final failure overlay or an unrelated authored message', () => {
    const overlay = { role: 'system', runId: 'final', content: 'Final error', [FAILED_RUN_MESSAGE_FLAG]: true };
    const authored = { role: 'user', runId: 'run', content: 'terminal failure' };
    expect(projectRetryFailureMessages([overlay, authored], new Set(['run']))).toEqual([overlay, authored]);
  });

  it('preserves useful failed assistant text even with an error code or no error message', () => {
    const partial = { ...failure, errorCode: 'openclaw_repeated_tool_error',
      content: [{ type: 'text', text: 'Useful partial answer' }, ...failure.content] };
    const withoutDetail = { role: 'assistant', runId: 'run', stopReason: 'error',
      content: [{ type: 'text', text: 'Another useful answer' }] };
    const stringPartial = { ...withoutDetail, content: 'Useful string answer' };
    const projected = projectRetryFailureMessages([partial, withoutDetail, stringPartial], new Set(['run']));
    expect(projected[0].content).toEqual([{ type: 'text', text: 'Useful partial answer' }]);
    expect(projected[1].content).toEqual(withoutDetail.content);
    expect(projected[2].content).toBe(stringPartial.content);
  });

  it.each([
    'OpenClaw stopped this turn after 3 consecutive identical tool failures. Check the tool arguments or switch to a model with native tool calling before retrying.',
    'This conversation is too long for the model. Try /compact, or start a new conversation with /new.',
  ])('hides native failure copy in public history while retaining partial text and media (%s)', failureCopy => {
    const copy = { type: 'text', text: failureCopy };
    const partial = { type: 'text', text: 'Useful partial answer' };
    const file = { type: 'file', path: 'output.txt' };
    const message = {
      role: 'assistant', stopReason: 'error', content: [partial, copy, file],
      __openclaw: { runId: 'run', idempotencyKey: 'run:terminal-error' },
    };
    const prefixed = { ...message, content: [{ ...partial, text: `${copy.text}\n\n${partial.text}` }] };
    const ordinary = { ...message, __openclaw: { runId: 'run', idempotencyKey: 'run:assistant' } };
    const final = { ...message, __openclaw: { runId: 'final', idempotencyKey: 'final:terminal-error' } };
    const conflicting = { runId: 'final', message };

    const projected = projectRetryFailureMessages([message, prefixed, ordinary, final, conflicting], new Set(['run']));

    expect(projected[0].content).toEqual([partial, file]);
    expect(projected[1].content).toEqual([partial]);
    expect(projected[2].content).toEqual([partial, copy, file]);
    expect(projected[3]).toBe(final);
    expect(projected[4]).toBe(conflicting);
  });
});
