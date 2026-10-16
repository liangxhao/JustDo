/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ChatController } from '../gateway/chat-controller';
import type { GatewayMessage } from '../types';
import type { JustDoChatElement } from './justdo-chat';

const controllers: ChatController[] = [];

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  document.body.replaceChildren();
  for (const controller of controllers.splice(0)) controller.disconnect();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function processMessages(entryId: string): GatewayMessage[] {
  return [
    { role: 'user', content: 'Inspect the configuration', __openclaw: { id: 'prompt' } },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'read-config', name: 'read', arguments: {} }],
      __openclaw: { id: entryId },
    },
    {
      role: 'toolResult',
      toolCallId: 'read-config',
      toolName: 'read',
      content: 'Configuration loaded',
      __openclaw: { id: `${entryId}-result` },
    },
  ];
}

describe('chat update cycle', () => {
  test('finishes the initial render without scheduling a second update', async () => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    document.body.append(chat);

    expect(await chat.updateComplete).toBe(true);
  });

  test('resets individual disclosure choices in the same update as bulk controls', async () => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.messages = processMessages('tool-entry');
    document.body.append(chat);
    await chat.updateComplete;
    await chat.updateComplete;
    const summary = () => chat.shadowRoot!.querySelector<HTMLElement>('[data-process-summary-key]')!;
    summary().click();
    await chat.updateComplete;

    chat.processSummariesExpanded = true;
    expect(await chat.updateComplete).toBe(true);
    summary().click();
    await chat.updateComplete;
    expect(summary().getAttribute('aria-expanded')).toBe('false');

    chat.processSummariesExpanded = false;
    expect(await chat.updateComplete).toBe(true);
    chat.processSummariesExpanded = true;
    expect(await chat.updateComplete).toBe(true);
    expect(summary().getAttribute('aria-expanded')).toBe('true');
  });

  test.each([false, true])(
    'carries individual disclosure choices across history replacement (bulk expanded: %s)',
    async bulkExpanded => {
      const chat = document.createElement('justdo-chat') as JustDoChatElement;
      chat.messages = processMessages('live-tool-entry');
      chat.processSummariesExpanded = bulkExpanded;
      document.body.append(chat);
      await chat.updateComplete;
      await chat.updateComplete;
      const original = chat.shadowRoot!.querySelector<HTMLElement>('[data-process-summary-key]')!;
      original.click();
      await chat.updateComplete;
      original.focus();

      chat.messages = processMessages('persisted-tool-entry');
      expect(await chat.updateComplete).toBe(true);
      const replacement = chat.shadowRoot!.querySelector<HTMLElement>('[data-process-summary-key]')!;
      expect(replacement.dataset.processSummaryKey).not.toBe(original.dataset.processSummaryKey);
      expect(replacement.getAttribute('aria-expanded')).toBe(String(!bulkExpanded));
      if (!bulkExpanded) expect(chat.shadowRoot!.activeElement).toBe(replacement);
    },
  );

  test('restores replaced summary focus without scrolling the paused reading anchor', async () => {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    const messages = (entryId: string): GatewayMessage[] => [
      ...processMessages(entryId),
      { role: 'user', content: 'Next question', __openclaw: { id: 'next-prompt' } },
    ];
    chat.messages = messages('live-tool-entry');
    let top = 0;
    Object.defineProperties(chat, {
      clientHeight: { value: 300 },
      scrollHeight: { value: 1_000 },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, 700));
        },
      },
    });
    document.body.append(chat);
    await chat.updateComplete;
    const root = chat.shadowRoot!;
    const original = root.querySelector<HTMLElement>('[data-process-summary-key]')!;
    original.click();
    await chat.updateComplete;
    original.focus();
    top = 400;
    chat.dispatchEvent(new Event('scroll'));
    const anchor = root.querySelector<HTMLElement>('[data-entry-id="next-prompt"]')!;
    anchor.getBoundingClientRect = () => new DOMRect(0, 500 - top, 100, 100);
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      focus.call(this, options);
      // Model the browser scrolling an offscreen focus target into view.
      if (this.dataset.processSummaryKey && !options?.preventScroll) top = 100;
    });

    chat.messages = messages('persisted-tool-entry');
    expect(await chat.updateComplete).toBe(true);

    expect(top).toBe(400);
    expect(root.querySelector('[data-entry-id="next-prompt"]')).toBe(anchor);
    const replacement = root.querySelector<HTMLElement>('[data-process-summary-key]')!;
    expect(root.activeElement).toBe(replacement);
    expect(replacement.getAttribute('aria-expanded')).toBe('true');
  });

  test('updates the scroll indicator without rendering the transcript again', async () => {
    const controller = new ChatController();
    controllers.push(controller);
    const showLatest = vi.spyOn(controller, 'showLatestHistory');
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.controller = controller;
    let height = 1_000;
    let top = 0;
    Object.defineProperties(chat, {
      clientHeight: { value: 300 },
      scrollHeight: { get: () => height },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, height - 300));
        },
      },
    });
    document.body.append(chat);
    await chat.updateComplete;
    await chat.updateComplete;
    const render = vi.spyOn(chat, 'render');
    const indicator = () =>
      chat.shadowRoot!.querySelector<HTMLButtonElement>('[data-jump-to-latest]');
    expect(indicator()?.hidden ?? true).toBe(true);

    top = 400;
    chat.dispatchEvent(new Event('scroll'));
    await chat.updateComplete;
    expect(render).not.toHaveBeenCalled();
    expect(indicator()?.hidden).toBe(false);

    height = 1_200;
    controller.state.transcript.revision += 1;
    chat.requestUpdate();
    expect(await chat.updateComplete).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
    expect(top).toBe(400);
    expect(indicator()?.hidden).toBe(false);

    indicator()!.click();
    await chat.updateComplete;
    expect(showLatest).toHaveBeenCalledOnce();
    expect(top).toBe(900);
    expect(indicator()?.hidden ?? true).toBe(true);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
