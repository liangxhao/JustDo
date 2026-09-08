/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, describe, expect, test } from 'vitest';

import { FAILED_RUN_MESSAGE_FLAG } from '@/libs/openclaw-chat/model/failed-run-message';
import { i18nService } from '@/services/i18n';

import type { JustDoChatElement } from './justdo-chat';

afterEach(() => {
  document.body.replaceChildren();
});

describe('justdo-chat failed runs', () => {
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
        content: 'Provider request failed.',
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
