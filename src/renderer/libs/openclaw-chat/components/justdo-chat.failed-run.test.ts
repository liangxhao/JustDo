/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, describe, expect, test } from 'vitest';

import {
  beginAssistantTurn,
  createChatTranscriptState,
} from '@/libs/openclaw-chat/model/chat-transcript-state';
import { FAILED_RUN_MESSAGE_FLAG } from '@/libs/openclaw-chat/model/turn/failed-run-message';
import { i18nService } from '@/services/i18n';

import type { JustDoChatElement } from './justdo-chat';

afterEach(() => {
  document.body.replaceChildren();
});

describe('justdo-chat failed runs', () => {
  test('renders the public native contention diagnostic in the error details', async () => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    const diagnostic =
      'SQLite transaction admission remained busy. Execution may have occurred; check the recorded outcome before resending.';
    chat.messages = [
      {
        role: 'custom',
        customType: 'run-failed-before-reply',
        content:
          'Your request was interrupted while the server was busy. Check its status before trying again.',
        display: true,
        details: { errorKind: 'state_contention', diagnostic, error: 'Private report detail' },
        __openclaw: { id: 'failure-receipt', runId: 'run-1' },
      },
    ];
    document.body.append(chat);
    await chat.updateComplete;

    expect(chat.shadowRoot?.querySelector('.process-terminal__details pre')?.textContent).toContain(
      diagnostic,
    );
    expect(chat.shadowRoot?.textContent).not.toContain('Private report detail');
    expect(chat.shadowRoot?.querySelector('.chat-avatar.error')).not.toBeNull();
  });

  test('shows a native receipt alongside a differing live error without replacing the live cause', async () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const turn = beginAssistantTurn(
      state,
      { runId: 'run-1' },
      {
        now: () => 1,
        createId: prefix => `${prefix}-1`,
      },
    );
    const liveError = 'The request could not finish.';
    turn.status = 'error';
    turn.items.push({
      id: 'terminal',
      runId: turn.runId,
      firstSeq: 2,
      lastSeq: 2,
      startedAt: 1,
      updatedAt: 2,
      type: 'terminal',
      status: 'error',
      message: liveError,
    });
    const receipt = {
      role: 'custom',
      customType: 'run-failed-before-reply',
      content:
        "Your request couldn't be completed: Persisted user turn changed before replay admission",
      display: true,
      __openclaw: { id: 'failure-receipt', runId: turn.runId },
    };
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.activeTurn = turn;
    chat.messages = [receipt];
    document.body.append(chat);
    await chat.updateComplete;

    const errors = chat.shadowRoot?.querySelectorAll('.process-terminal--error');
    expect(errors).toHaveLength(2);
    expect(chat.shadowRoot?.textContent).toContain(liveError);
    expect(chat.shadowRoot?.textContent).toContain(receipt.content);
    expect(chat.shadowRoot?.querySelector('.chat-avatar.other')).toBeNull();
    expect(turn.items).toMatchObject([{ type: 'terminal', message: liveError }]);
    expect(turn.status).toBe('error');
  });

  test.each([false, true])(
    'renders native failure receipts with the error avatar (enveloped=%s)',
    async enveloped => {
      const chat = document.createElement('justdo-chat') as JustDoChatElement;
      const receipt = {
        role: 'custom',
        customType: 'run-failed-before-reply',
        content:
          "Your request couldn't be completed: Persisted user turn changed before replay admission",
        display: true,
        timestamp: 6_000,
        __openclaw: { id: 'failure-receipt', runId: 'run-1' },
      };
      const message = enveloped ? { role: receipt.role, message: receipt } : receipt;
      const before = structuredClone(message);
      chat.messages = [message];
      document.body.append(chat);
      await chat.updateComplete;

      const errors = chat.shadowRoot?.querySelectorAll('.process-terminal--error');
      expect(errors).toHaveLength(1);
      expect(errors?.[0].textContent).toContain(receipt.content);
      expect(chat.shadowRoot?.querySelectorAll('.chat-avatar.error')).toHaveLength(1);
      expect(chat.shadowRoot?.querySelector('.chat-avatar.other')).toBeNull();
      expect(chat.shadowRoot?.querySelector('.chat-bubble')).toBeNull();
      expect(chat.messages).toEqual([before]);
    },
  );

  test('renders restored failed reasoning, content and one error without repeating the content', async () => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    const body = 'Checking the environment first.';
    const error = 'Provider returned an incomplete or malformed tool call';
    chat.messages = [
      {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: error,
        content: [
          { type: 'thinking', thinking: 'Inspect the installed tools.' },
          { type: 'text', text: body },
        ],
        __openclaw: { id: 'failure-1', runId: 'run-1' },
      },
    ];
    document.body.append(chat);
    await chat.updateComplete;
    const text = chat.shadowRoot?.textContent ?? '';
    expect(text.split(body)).toHaveLength(2);
    expect(chat.shadowRoot?.querySelectorAll('.process-terminal--error')).toHaveLength(1);
    expect(chat.shadowRoot?.querySelector('.process-terminal--error')?.textContent).toContain(
      error,
    );
    expect(JSON.stringify(chat.messages)).toContain('Inspect the installed tools.');
  });

  test.each([
    [{ type: 'thinking', thinking: 'Partial reasoning' }],
    [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }],
    [
      { type: 'text', text: 'Before tool' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
      { type: 'text', text: 'After tool' },
    ],
  ])('shows exactly one native failure detail for content shape %#', async (...content) => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.messages = [
      {
        role: 'assistant',
        content,
        stopReason: 'error',
        errorMessage: 'Provider finish_reason: unsupported_terminal',
        __openclaw: { id: 'failure-1', runId: 'run-1' },
      },
    ];
    document.body.append(chat);
    await chat.updateComplete;
    const errors = chat.shadowRoot?.querySelectorAll('.process-terminal--error');
    expect(errors).toHaveLength(1);
    expect(errors?.[0].textContent).toContain('Provider finish_reason: unsupported_terminal');
  });

  test('shows the native diagnostic after a partial reply without requiring a local failure cache', async () => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.messages = [
      {
        role: 'assistant',
        content: 'Partial reply',
        stopReason: 'error',
        errorMessage: 'Provider finish_reason: unsupported_terminal',
        __openclaw: { id: 'failure-1', runId: 'run-1' },
      },
    ];
    document.body.append(chat);
    await chat.updateComplete;
    expect(chat.shadowRoot?.textContent).toContain('Partial reply');
    expect(chat.shadowRoot?.querySelector('.process-terminal--error')?.textContent).toContain(
      'Provider finish_reason: unsupported_terminal',
    );
  });
  test('keeps a persisted failed run in the terminal error presentation', async () => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.runTimings = [
      {
        id: 'timing-1',
        sessionId: 'session-1',
        clientTurnId: 'run-1',
        rootRunId: 'run-1',
        modelRef: 'zcode/glm-5.3-flash',
        startedAt: 1_000,
        endedAt: 6_000,
        state: 'failed',
      },
    ];
    chat.messages = [
      {
        role: 'system',
        content:
          'Provider request failed. To view logs, run `openclaw logs --follow` in a terminal.',
        timestamp: 6_000,
        runId: 'run-1',
        isError: true,
        provider: 'zcode',
        model: 'glm-5.3-flash',
        [FAILED_RUN_MESSAGE_FLAG]: true,
      },
    ];
    document.body.append(chat);
    await chat.updateComplete;

    const terminal = chat.shadowRoot?.querySelector<HTMLElement>(
      '.process-terminal.process-terminal--error',
    );
    expect(terminal?.textContent).toContain('Provider request failed.');
    expect(terminal?.textContent).not.toContain('To view logs');
    expect(terminal?.textContent).not.toContain('openclaw');
    expect(chat.shadowRoot?.querySelector('.chat-avatar.error')).not.toBeNull();
    expect(chat.shadowRoot?.querySelector('.chat-avatar.assistant')).toBeNull();
    expect(chat.shadowRoot?.querySelector('.chat-avatar.other')).toBeNull();
    expect(chat.shadowRoot?.querySelector('.chat-bubble')).toBeNull();
    expect(chat.shadowRoot?.querySelector('.process-terminal__footer')?.textContent).toContain(
      'zcode/glm-5.3-flash',
    );
    expect(chat.shadowRoot?.querySelector('.process-terminal__footer')?.textContent).toContain(
      i18nService.t('coworkRunFailedDuration').replace('{duration}', '5s'),
    );
    expect(chat.shadowRoot?.querySelector('.process-terminal__footer')?.textContent).not.toContain(
      i18nService.t('coworkRunWorkedDuration').replace('{duration}', '5s'),
    );
  });
});
