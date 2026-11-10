// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMessageRenderer } from '../conversation-overlay/modules/sidepanel-messages.js';
import { messageCopyText } from '../conversation-overlay/modules/sidepanel-rich-content.js';
import { sidePanelText as t } from '../conversation-overlay/modules/sidepanel-i18n.js';

const answer = (text: string, key = 'answer') => ({ role: 'assistant', key, text });
const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};

describe('side panel answer and code copying', () => {
  let renderer: ReturnType<typeof createMessageRenderer>;
  let messages: HTMLElement;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '<main id="messages"></main>';
    messages = document.getElementById('messages')!;
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText },
    });
    renderer = createMessageRenderer(messages, {
      latestButton: document.createElement('button'),
      processDetailsButton: document.createElement('button'),
      readImage: vi.fn(),
    });
  });
  afterEach(() => {
    renderer.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  const copy = () => messages.querySelector<HTMLButtonElement>('.message-copy')!;
  const status = () => messages.querySelector<HTMLElement>('.message-copy-status')!;

  it('copies only the selected normalized answer, excluding reasoning, cards and attachments', async () => {
    const entry = {
      ...answer('Fallback must not be copied'),
      rawMessage: { role: 'assistant', content: [
        { type: 'text', text: '**First answer**' },
        { type: 'thinking', text: 'Private reasoning' },
        { type: 'browser_annotation', annotation: {
          title: 'Internal page title', comment: 'Page annotation', displayUrl: 'https://example.com',
        } },
        { type: 'attachment', attachment: { kind: 'file', url: 'localfile:/secret.txt', label: 'Secret file' } },
        { type: 'text', text: 'Last paragraph' },
      ] },
    };
    renderer.render([entry, answer('Different answer', 'other')], 'one');
    expect(messageCopyText(entry)).toBe('**First answer**\n\nLast paragraph');
    expect(messages.querySelector('.assistant-heading')?.textContent).toContain(t('assistant'));
    copy().click();
    await vi.waitFor(() => expect(status().textContent).toBe(t('copied')));
    expect(writeText).toHaveBeenCalledExactlyOnceWith('**First answer**\n\nLast paragraph');
  });

  it('keeps its controls and focus stable while streaming and clears feedback when the body changes', async () => {
    renderer.render([answer('First')], 'one');
    const button = copy();
    const feedback = status();
    button.focus();
    button.click();
    await vi.waitFor(() => expect(feedback.textContent).toBe(t('copied')));
    renderer.render([answer('First continues')], 'one');
    expect(copy()).toBe(button);
    expect(status()).toBe(feedback);
    expect(document.activeElement).toBe(button);
    expect(feedback.textContent).toBe('');
    button.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith('First continues'));
  });

  it('shows an actionable failure and does not let earlier requests overwrite the latest result', async () => {
    const first = deferred();
    const second = deferred();
    writeText.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderer.render([answer('Answer')], 'one');
    copy().click();
    copy().click();
    second.reject(new Error('Clipboard unavailable'));
    await vi.waitFor(() => expect(status().textContent).toBe(t('copyFailed')));
    first.resolve();
    await Promise.resolve();
    expect(status().textContent).toBe(t('copyFailed'));
    expect(copy().dataset.copyState).toBe('failed');
  });

  it('ignores a clipboard result after a body update or scope change and after disposal', async () => {
    const pending = [deferred(), deferred(), deferred()];
    pending.forEach(result => writeText.mockReturnValueOnce(result.promise));
    renderer.render([answer('Before')], 'one');
    copy().click();
    renderer.render([answer('After')], 'one');
    pending[0].resolve();
    await Promise.resolve();
    expect(status().textContent).toBe('');
    copy().click();
    const oldFeedback = status();
    renderer.render([answer('Other scope')], 'two');
    pending[1].resolve();
    await Promise.resolve();
    expect(oldFeedback.textContent).toBe('');
    expect(status().textContent).toBe('');
    copy().click();
    renderer.dispose();
    pending[2].resolve();
    await Promise.resolve();
    expect(status().textContent).toBe('');
  });

  it('copies exact code text through the icon and leaves inline code without controls', async () => {
    renderer.render([answer('`inline`\n\n```ts\nconst value = "<tag>";\n\n```')], 'one');
    const button = messages.querySelector<HTMLButtonElement>('.code-copy')!;
    expect(messages.querySelector('.code-block-language')?.textContent).toBe('ts');
    expect(messages.querySelectorAll('.code-copy')).toHaveLength(1);
    button.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(button.dataset.copyState).toBe('copied'));
    expect(writeText).toHaveBeenCalledExactlyOnceWith('const value = "<tag>";\n\n');
  });

  it('preserves user code feedback on pending metadata changes and retires it when the body changes', async () => {
    const entry = { role: 'user', key: 'user', text: '```\noriginal\n```' };
    renderer.render([{ ...entry, pendingInput: { state: 'queued' } }], 'one');
    const button = messages.querySelector<HTMLButtonElement>('.code-copy')!;
    const feedback = messages.querySelector<HTMLElement>('.code-copy-status')!;
    button.click();
    await vi.waitFor(() => expect(feedback.textContent).toBe(t('copied')));
    renderer.render([{ ...entry, pendingInput: { state: 'cancelled' } }], 'one');
    expect(messages.querySelector('.code-copy')).toBe(button);
    expect(feedback.textContent).toBe(t('copied'));
    renderer.render([{ ...entry, text: '```\nchanged\n```' }], 'one');
    expect(feedback.textContent).toBe('');
    expect(messages.querySelector('.code-copy-status')?.textContent).toBe('');
  });

  it('ignores a code-copy result after its live Thinking source is updated', async () => {
    const result = deferred();
    writeText.mockReturnValueOnce(result.promise);
    const entry = (text: string) => ({ role: 'live-process', key: 'thinking', item: {
      type: 'thinking', key: 'thought', title: 'Thinking', status: 'inProgress', text,
    } });
    renderer.render([entry('```\nfirst\n```')], 'one');
    messages.querySelector<HTMLButtonElement>('.code-copy')!.click();
    renderer.render([entry('```\nsecond\n```')], 'one');
    result.resolve();
    await Promise.resolve();
    expect(messages.querySelector('.code-copy-status')?.textContent).toBe('');
    expect(messages.querySelector('.code-copy')?.getAttribute('data-copy-state')).toBeNull();
  });

  it('expires success feedback without letting an earlier timer clear a later result', async () => {
    vi.useFakeTimers();
    renderer.render([answer('Answer')], 'one');
    copy().click();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1500);
    copy().click();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(600);
    expect(status().textContent).toBe(t('copied'));
    await vi.advanceTimersByTimeAsync(1400);
    expect(status().textContent).toBe('');
    expect(copy().title).toBe(t('copyAnswer'));
  });

  it('keeps media-only answers visible without an empty copy action', () => {
    renderer.render([{
      ...answer(''), rawMessage: { role: 'assistant', content: [
        { type: 'attachment', attachment: { kind: 'image', url: 'data:image/png;base64,AA==', label: 'Image' } },
      ] },
    }], 'one');
    expect(messages.querySelector('.assistant-content img')).not.toBeNull();
    expect(copy().parentElement?.hidden).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });
});
