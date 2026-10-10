/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

import type { JustDoChatElement } from './justdo-chat';

const controllers: ChatController[] = [];
const initialLanguage = i18nService.getLanguage();

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
  document.body.replaceChildren();
  i18nService.setLanguage(initialLanguage, { persist: false });
  vi.useRealTimers();
});

async function renderMessages(messages: GatewayMessage[]): Promise<JustDoChatElement> {
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = messages;
  document.body.append(chat);
  await chat.updateComplete;
  return chat;
}

function createController(sessionKey: string) {
  const controller = new ChatController();
  controller.state.sessionKey = sessionKey;
  controller.state.transcript.sessionKey = sessionKey;
  controllers.push(controller);
  let sequence = 0;
  const emit = (stream: string, data: Record<string, unknown>) =>
    (
      controller as unknown as {
        handleEvent(event: { event: string; payload: unknown }): void;
      }
    ).handleEvent({
      event: 'agent',
      payload: { sessionKey, runId: 'run-1', seq: ++sequence, stream, data },
    });
  return { controller, emit };
}

test.each(['zh', 'en'] as const)(
  'shows failure, cancellation and skip reasons without hovering in %s',
  async language => {
    i18nService.setLanguage(language, { persist: false });
    const phases = [
      ['failed', 'coworkCompactFailure'],
      ['aborted', 'coworkCompactAborted'],
      ['skipped', 'coworkCompactSkipped'],
    ] as const;
    const reason = 'Native failure <script>unsafe()</script>\nNext useful step';
    const chat = await renderMessages(
      phases.map(([phase], index) => ({
        role: 'system',
        timestamp: index + 1,
        __openclaw: {
          kind: 'compaction-status',
          id: phase,
          phase,
          reason,
          summary: 'Incomplete output must stay hidden',
          tokensBefore: 12_000,
          tokensAfter: 4_000,
        },
      })),
    );

    const dividers = chat.shadowRoot!.querySelectorAll('.chat-divider');
    expect(dividers).toHaveLength(3);
    for (const [index, [, labelKey]] of phases.entries()) {
      expect(dividers[index].querySelector('.chat-divider__summary')?.textContent).toBe(
        i18nService.t(labelKey),
      );
      expect(dividers[index].querySelector('.chat-divider__description')?.textContent).toBe(reason);
      expect(dividers[index].textContent).not.toContain('Incomplete output');
      expect(dividers[index].querySelector('details')).toBeNull();
      expect(dividers[index].querySelector('script')).toBeNull();
    }
  },
);

test('keeps blank terminal reasons out of the visible layout', async () => {
  const chat = await renderMessages([
    {
      role: 'system',
      timestamp: 1,
      __openclaw: { kind: 'compaction-status', id: 'aborted', phase: 'aborted', reason: ' \n ' },
    },
  ]);
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toBe(
    i18nService.t('coworkCompactAborted'),
  );
  expect(chat.shadowRoot!.querySelector('.chat-divider__description')).toBeNull();
});

test('shows successful token counts and expands long summaries as safe plain text', async () => {
  const summary = `保留当前任务\n${'长摘要内容 '.repeat(1_000)}\n<script>alert(1)</script> & <img src=x>`;
  const chat = await renderMessages([
    {
      role: 'system',
      timestamp: 1,
      __openclaw: {
        kind: 'compaction',
        id: 'committed-compaction',
        tokensBefore: 12_000,
        tokensAfter: 4_000,
        summary,
      },
    },
  ]);

  const details = chat.shadowRoot!.querySelector<HTMLDetailsElement>('.chat-divider__details')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')?.textContent?.trim()).toBe('12,000 → 4,000 tokens');
  details.querySelector('summary')!.click();
  expect(details.open).toBe(true);
  expect(details.querySelector('.chat-divider__content')?.textContent).toBe(summary);
  expect(details.querySelector('script, img')).toBeNull();
});

test('updates the active compaction clock and stops it after the terminal event', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(1_000);
  const { controller, emit } = createController('agent:main:justdo:compaction-clock');
  emit('lifecycle', { phase: 'start' });
  emit('compaction', { phase: 'start', itemId: 'compact-1' });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toContain('0s');

  await vi.advanceTimersByTimeAsync(2_000);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toContain('2s');
  emit('compaction', { phase: 'end', itemId: 'compact-1', completed: false, outcome: 'aborted' });
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toBe(
    i18nService.t('coworkCompactAborted'),
  );
  await vi.advanceTimersByTimeAsync(2_000);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toBe(
    i18nService.t('coworkCompactAborted'),
  );
});

test('renders a background compaction outcome only in its owning session', async () => {
  const sessionKey = 'agent:main:justdo:compacting-session';
  const { controller, emit } = createController(sessionKey);
  emit('lifecycle', { phase: 'start' });
  emit('compaction', { phase: 'start', itemId: 'compact-1' });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider')).not.toBeNull();

  await controller.switchSession('agent:main:justdo:other-session');
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider')).toBeNull();
  emit('compaction', {
    phase: 'end',
    itemId: 'compact-1',
    completed: false,
    outcome: 'failed',
    reason: 'Background provider failed',
  });
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider')).toBeNull();

  await controller.switchSession(sessionKey);
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelector('.chat-divider__summary')?.textContent).toBe(
    i18nService.t('coworkCompactFailure'),
  );
  expect(chat.shadowRoot!.querySelector('.chat-divider__description')?.textContent).toBe(
    'Background provider failed',
  );
});
