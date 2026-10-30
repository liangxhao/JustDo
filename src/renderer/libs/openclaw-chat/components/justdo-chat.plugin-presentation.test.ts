/** @vitest-environment jsdom */
import './justdo-chat';

import { afterEach, expect, test } from 'vitest';

import { registerMessagePresentation } from '@/features/plugins/app/messagePresentation';
import { projectGatewayHistoryForDisplay } from '@/libs/openclaw-chat/pipeline/history-display-normalizer';

import type { JustDoChatElement } from './justdo-chat';

const releases: (() => void)[] = [];
afterEach(() => {
  document.body.replaceChildren();
  releases.splice(0).forEach(release => release());
});

test('late display lease reformats the same mounted native history and revocation restores source text', async () => {
  const instruction = 'Fixture plugin instruction';
  const source = instruction + '\nVisible question';
  const messages = projectGatewayHistoryForDisplay([
    { id: 'legacy', role: 'user', content: source },
  ]);
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = messages as typeof chat.messages;
  document.body.append(chat);
  await chat.historyRenderComplete;
  expect(chat.shadowRoot?.textContent).toContain(instruction);
  const release = registerMessagePresentation('late-pure-fixture', { text: text => text.replace(instruction + '\n', '') });
  releases.push(release);
  await chat.historyRenderComplete;
  expect(chat.messages).toBe(messages);
  expect(chat.shadowRoot?.textContent).toContain('Visible question');
  expect(chat.shadowRoot?.textContent).not.toContain(instruction);
  release();
  await chat.historyRenderComplete;
  expect(chat.shadowRoot?.textContent).toContain(instruction);
});

test('late display classification invalidates mounted perspective caches without changing native records', async () => {
  const messages = [
    { id: 'user', role: 'user', content: 'Actual user text' },
    { id: 'dispatcher', role: 'user', content: 'Dispatcher fixture text' },
  ];
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.messages = messages;
  document.body.append(chat);
  await chat.historyRenderComplete;
  expect(chat.shadowRoot?.textContent).toContain('Dispatcher fixture text');
  const release = registerMessagePresentation('late-classification-fixture', {
    nativeInput: message => (message as { id?: string }).id === 'dispatcher'
      ? { senderLabel: 'Dispatcher', senderId: 'fixture:dispatcher' } : undefined,
  });
  releases.push(release);
  await chat.historyRenderComplete;
  expect(chat.shadowRoot?.textContent).toContain('Actual user text');
  expect(chat.shadowRoot?.textContent).not.toContain('Dispatcher fixture text');
  expect(chat.messages).toBe(messages);
  release();
  await chat.historyRenderComplete;
  expect(chat.shadowRoot?.textContent).toContain('Dispatcher fixture text');
});
