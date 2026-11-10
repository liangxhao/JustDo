// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMessageRenderer } from '../conversation-overlay/modules/sidepanel-messages.js';
import { messagesFromThread } from '../conversation-overlay/modules/sidepanel-state.js';
import { sidePanelText as t } from '../conversation-overlay/modules/sidepanel-i18n.js';

const timestampMs = Date.parse('2026-11-10T10:30:45.000Z');
const answer = (display?: Record<string, unknown>) => ({
  role: 'assistant', key: 'answer', text: 'Native **answer**', ...(display ? { display } : {}),
});

describe('side panel native message metadata', () => {
  let renderer: ReturnType<typeof createMessageRenderer>;
  let messages: HTMLElement;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '<main id="messages"></main>';
    messages = document.getElementById('messages')!;
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderer = createMessageRenderer(messages, {
      latestButton: document.createElement('button'),
      processDetailsButton: document.createElement('button'), readImage: vi.fn(),
    });
  });
  afterEach(() => {
    renderer.dispose();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('preserves native history metadata through the browser projection and shows an accessible time', () => {
    const display = { timestampMs, modelName: 'internal/family/model' };
    const entries = messagesFromThread({ id: 'one', turns: [{ id: 'turn', items: [
      { id: 'native', type: 'agentMessage', text: 'Native **answer**', display },
    ] }] });
    renderer.render(entries, 'one');
    const time = messages.querySelector<HTMLTimeElement>('.message-time')!;
    expect(time.dateTime).toBe('2026-11-10T10:30:45.000Z');
    expect(time.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(time.title).toContain('2026');
    expect(time.getAttribute('aria-label')).toBe(time.title);
    expect(messages.querySelector('.message-model')?.textContent).toBe(display.modelName);
    expect(messages.querySelector<HTMLElement>('.message-model')!.title).toContain(t('responseModel'));
  });

  it('keeps body selection, copy focus and feedback when only metadata is added, changed or removed', async () => {
    renderer.render([answer()], 'one');
    const body = messages.querySelector('.assistant-content p')!;
    const copy = messages.querySelector<HTMLButtonElement>('.message-copy')!;
    copy.focus();
    copy.click();
    await vi.waitFor(() => expect(messages.querySelector('.message-copy-status')?.textContent).toBe(t('copied')));
    const range = document.createRange();
    range.selectNodeContents(body);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    for (const display of [{ timestampMs, modelName: 'model-a' }, { timestampMs: timestampMs + 1000, modelName: 'model-b' }, undefined]) {
      renderer.render([answer(display)], 'one');
      expect(messages.querySelector('.assistant-content p')).toBe(body);
      expect(messages.querySelector('.message-copy')).toBe(copy);
      expect(document.activeElement).toBe(copy);
      expect(document.getSelection()!.toString()).toBe('Native answer');
      expect(messages.querySelector('.message-copy-status')?.textContent).toBe(t('copied'));
    }
    expect(writeText).toHaveBeenCalledExactlyOnceWith('Native **answer**');
  });

  it('hides missing and invalid times without using local activity or current model selection', () => {
    renderer.render([{ ...answer(), startedAt: timestampMs, updatedAt: timestampMs, modelRef: 'selected-model' }], 'one');
    const time = messages.querySelector<HTMLTimeElement>('.message-time')!;
    expect(time.hidden).toBe(true);
    expect(time.hasAttribute('datetime')).toBe(false);
    expect(messages.querySelector<HTMLElement>('.message-metadata')!.hidden).toBe(true);
    renderer.render([answer({ timestampMs, modelName: 'native-model' })], 'one');
    renderer.render([answer({ timestampMs: Infinity })], 'one');
    expect(time.hidden).toBe(true);
    expect(time.textContent).toBe('');
    expect(time.hasAttribute('datetime')).toBe(false);
    expect(time.hasAttribute('title')).toBe(false);
    expect(messages.querySelector<HTMLElement>('.message-model')!.hidden).toBe(true);
  });

  it('can show media metadata without exposing an empty copy action and renders model names as text', () => {
    renderer.render([{
      ...answer({ timestampMs, modelName: '<img src=x onerror=alert(1)>' }), text: '',
      rawMessage: { role: 'assistant', content: [{ type: 'attachment', attachment: {
        kind: 'image', url: 'data:image/png;base64,AA==', label: 'Image',
      } }] },
    }], 'one');
    expect(messages.querySelector('.assistant-content img')).not.toBeNull();
    expect(messages.querySelector<HTMLButtonElement>('.message-copy')!.hidden).toBe(true);
    expect(messages.querySelector<HTMLElement>('.message-actions')!.hidden).toBe(false);
    expect(messages.querySelector('.message-model')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(messages.querySelector('.message-model img')).toBeNull();
  });
});
