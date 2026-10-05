/** @vitest-environment jsdom */
import './justdo-chat';

import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '../gateway/chat-controller';
import { queuedInputSnapshot, refreshNativePendingInputs } from '../gateway/chat-pending-inputs';
import type { JustDoChatElement } from './justdo-chat';

afterEach(() => document.body.replaceChildren());

test('renders an ordinary first send as a user bubble while native custody is pending', async () => {
  const controller = new ChatController();
  Object.assign(controller.state, {
    sessionKey: 'agent:main:justdo:first-send', currentSessionId: 'physical-first', connected: true,
    chatRunId: 'justdo-first-send', chatSending: true,
    pendingUserMessage: { role: 'user', content: 'First prompt', text: 'First prompt', timestamp: 1000 },
    client: { request: vi.fn(async () => ({
      inputReceipts: [{ runId: 'justdo-first-send', state: 'pending' }],
    })) },
  });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  const notify = () => (controller as unknown as { notify(): void }).notify();
  await refreshNativePendingInputs(controller.state, { pendingInputs: { total: 1, items: [{
    id: 'first', runId: 'justdo-first-send', state: 'queued', acceptedAt: 1000,
    message: { role: 'user', content: 'First prompt', __openclaw: { id: 'pending:first' } },
  }] } }, notify, vi.fn());
  await chat.updateComplete;
  expect(queuedInputSnapshot(controller.state, []).items).toEqual([]);
  const bubble = chat.shadowRoot!.querySelector('[data-entry-id="pending:first"]');
  expect(bubble?.textContent).toContain('First prompt');
  expect(chat.shadowRoot!.querySelectorAll('.chat-group--user')).toHaveLength(1);
  expect(bubble?.querySelector('.chat-avatar.user')).not.toBeNull();
  expect(bubble?.querySelector('[data-pending-input-state="queued"]')).toBeNull();
});

test('shows native pending statuses in accepted order without enabling transcript mutation actions', async () => {
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:fixture';
  controller.state.currentSessionId = 'physical-fixture';
  controller.state.connected = true;
  controller.state.client = {
    request: vi.fn(async (_method, params) => ({
      inputReceipts: params.inputRunIds.map((runId: string) => ({
        runId,
        state: 'pending',
        ...(runId === 'old' ? { cancelled: true } : {}),
      })),
    })),
  } as unknown as NonNullable<typeof controller.state.client>;
  const history = [
    {
      role: 'user',
      content: 'Canonical prompt',
      timestamp: 2000,
      __openclaw: { id: 'canonical-user', seq: 1 },
    },
    {
      role: 'assistant',
      content: 'Canonical reply',
      timestamp: 3000,
      __openclaw: { id: 'canonical-reply', seq: 2 },
    },
  ];
  (
    controller as unknown as {
      setCurrentSessionMessages(messages: unknown[], options: unknown): void;
    }
  ).setCurrentSessionMessages(history, { resetLoadedHistory: true });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  chat.onLastUserMessageAction = vi.fn();
  document.body.append(chat);
  const inputs = [
    {
      id: 'old',
      runId: 'old',
      acceptedAt: 1000,
      state: 'cancelled',
      message: {
        role: 'user',
        content: 'Older cancelled input',
        __openclaw: { id: 'pending:old' },
      },
    },
    {
      id: 'new',
      runId: 'new',
      acceptedAt: 4000,
      state: 'queued',
      queued: true,
      message: { role: 'user', content: 'New queued input', __openclaw: { id: 'pending:new' } },
    },
  ];
  const notify = () => (controller as unknown as { notify(): void }).notify();
  await refreshNativePendingInputs(
    controller.state,
    { pendingInputs: { items: inputs, total: 2 } },
    notify,
    vi.fn(),
  );
  await chat.updateComplete;
  const rows = Array.from(chat.shadowRoot!.querySelectorAll('[data-entry-id]'));
  expect(rows.map(row => row.getAttribute('data-entry-id'))).toEqual([
    'pending:old',
    'canonical-user',
    'canonical-reply',
  ]);
  expect(chat.shadowRoot!.querySelectorAll('[data-pending-input-state]')).toHaveLength(1);
  expect(chat.shadowRoot!.textContent).not.toContain('New queued input');
  expect(queuedInputSnapshot(controller.state, history).items).toEqual([
    { id: 'new', text: 'New queued input', canWithdraw: true },
  ]);
  for (const id of ['pending:old', 'pending:new']) {
    expect(
      chat.shadowRoot!.querySelector(`[data-entry-id="${id}"] .user-message-action`),
    ).toBeNull();
  }
  expect(controller.getLoadedMessages()).toEqual(history);
  await refreshNativePendingInputs(
    controller.state,
    { pendingInputs: { items: [], total: 0 } },
    notify,
    vi.fn(),
  );
  await chat.updateComplete;
  expect(chat.shadowRoot!.querySelectorAll('[data-pending-input-state]')).toHaveLength(0);
  expect(chat.shadowRoot!.textContent).not.toContain('Older cancelled input');
  expect(queuedInputSnapshot(controller.state, history).items).toEqual([]);
  controller.state.sessionKey = 'another-session';
  expect(queuedInputSnapshot(controller.state, history).items).toEqual([]);
});
