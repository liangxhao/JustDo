/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, describe, expect, test } from 'vitest';

import { FAILED_RUN_MESSAGE_FLAG } from '@/libs/openclaw-chat/model/turn/failed-run-message';
import { i18nService } from '@/services/i18n';

import type { JustDoChatElement } from './justdo-chat';

afterEach(() => {
  document.body.replaceChildren();
});

describe('justdo-chat failed runs', () => {
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
