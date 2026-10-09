/** @vitest-environment jsdom */
import { nothing, render } from 'lit';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { renderTerminalTimelineMessage } from './active-turn-timeline';
import { renderCopyButton, renderMessageBlock, renderStreamingGroup } from './message-render';

afterEach(() => {
  render(nothing, document.body);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each(['user', 'assistant', 'streaming'])(
  'copies the original Markdown from a %s bubble',
  async role => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const text = 'First paragraph\n\n**Bold**\n\n```ts\nconst value = 1;\n```';
    const template =
      role === 'streaming'
        ? renderStreamingGroup(text, 1)
        : renderMessageBlock({
            kind: 'group',
            key: `${role}-group`,
            role,
            messages: [{ key: `${role}-message`, message: { role, content: text } }],
            timestamp: 1,
            isStreaming: false,
          });
    render(template, document.body);
    const copy = document.querySelector<HTMLButtonElement>('.message-copy')!;
    copy.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
    expect(copy.classList.contains('message-copy--copied')).toBe(true);
    expect(copy.title).toBe(i18nService.t('copied'));
    vi.advanceTimersByTime(1500);
    expect(copy.title).toBe(i18nService.t('copyToClipboard'));
    expect(copy.getAttribute('aria-label')).toBe(i18nService.t('copyToClipboard'));
  },
);

test.each(['rejected', 'unavailable'])(
  'shows a failure notice when the clipboard is %s and restores the error label after retry',
  async clipboardState => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'));
    vi.stubGlobal('navigator', clipboardState === 'rejected' ? { clipboard: { writeText } } : {});
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const text = 'Provider request failed.\nThe connection closed.';
    render(renderTerminalTimelineMessage(text, 'error'), document.body);
    const copy = document.querySelector<HTMLButtonElement>('.message-copy')!;
    copy.click();
    await Promise.resolve();

    expect(copy.classList.contains('message-copy--copied')).toBe(false);
    expect(copy.title).toBe(i18nService.t('messageCopyFailed'));
    expect(copy.getAttribute('aria-label')).toBe(i18nService.t('messageCopyFailed'));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'app:showToast',
        detail: i18nService.t('messageCopyFailed'),
      }),
    );

    writeText.mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    copy.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenLastCalledWith(text);
    expect(copy.classList.contains('message-copy--copied')).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(copy.title).toBe(i18nService.t('coworkCopyError'));
    expect(copy.getAttribute('aria-label')).toBe(i18nService.t('coworkCopyError'));
  },
);

test('keeps success feedback visible for the latest copy and clears it on failure', async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(renderCopyButton('message text'), document.body);
  const copy = document.querySelector<HTMLButtonElement>('.message-copy')!;
  copy.click();
  await Promise.resolve();
  vi.advanceTimersByTime(1000);
  copy.click();
  await Promise.resolve();
  vi.advanceTimersByTime(500);
  expect(copy.classList.contains('message-copy--copied')).toBe(true);
  expect(copy.getAttribute('aria-label')).toBe(i18nService.t('copied'));

  writeText.mockRejectedValue(new Error('clipboard denied'));
  copy.click();
  await Promise.resolve();
  expect(copy.classList.contains('message-copy--copied')).toBe(false);
  vi.advanceTimersByTime(1500);
  expect(copy.getAttribute('aria-label')).toBe(i18nService.t('messageCopyFailed'));
});

test('does not let an earlier copy timer reset a later clipboard result', async () => {
  vi.useFakeTimers();
  let completeRetry!: () => void;
  const retry = new Promise<void>(resolve => {
    completeRetry = resolve;
  });
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(retry);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(renderCopyButton('message text'), document.body);
  const copy = document.querySelector<HTMLButtonElement>('.message-copy')!;
  copy.click();
  copy.click();
  await Promise.resolve();
  vi.advanceTimersByTime(1000);
  completeRetry();
  await Promise.resolve();
  vi.advanceTimersByTime(500);
  expect(copy.classList.contains('message-copy--copied')).toBe(true);
  vi.advanceTimersByTime(1000);
  expect(copy.classList.contains('message-copy--copied')).toBe(false);
  expect(copy.getAttribute('aria-label')).toBe(i18nService.t('copyToClipboard'));
});

test.each(['success', 'failure'])(
  'ignores an earlier clipboard result after the latest copy reports %s',
  async latestResult => {
    vi.useFakeTimers();
    let completeEarlier!: () => void;
    let rejectEarlier!: (error: Error) => void;
    const earlier = new Promise<void>((resolve, reject) => {
      completeEarlier = resolve;
      rejectEarlier = reject;
    });
    const writeText = vi.fn().mockReturnValueOnce(earlier);
    if (latestResult === 'success') writeText.mockResolvedValueOnce(undefined);
    else writeText.mockRejectedValueOnce(new Error('clipboard denied'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    render(renderCopyButton('message text'), document.body);
    const copy = document.querySelector<HTMLButtonElement>('.message-copy')!;
    copy.click();
    copy.click();
    await Promise.resolve();

    if (latestResult === 'success') rejectEarlier(new Error('older clipboard failure'));
    else completeEarlier();
    await Promise.resolve();

    const label = i18nService.t(latestResult === 'success' ? 'copied' : 'messageCopyFailed');
    expect(copy.title).toBe(label);
    expect(copy.getAttribute('aria-label')).toBe(label);
    expect(copy.classList.contains('message-copy--copied')).toBe(latestResult === 'success');
    expect(dispatch).toHaveBeenCalledTimes(latestResult === 'success' ? 0 : 1);
    vi.advanceTimersByTime(1500);
    expect(copy.title).toBe(
      i18nService.t(latestResult === 'success' ? 'copyToClipboard' : 'messageCopyFailed'),
    );
  },
);

test.each(['success', 'failure'])(
  'ignores a delayed clipboard %s after the bubble is removed',
  async result => {
    vi.useFakeTimers();
    let complete!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((resolve, rejectPromise) => {
      complete = resolve;
      reject = rejectPromise;
    });
    const writeText = vi.fn().mockReturnValue(pending);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    render(renderCopyButton('message text'), document.body);
    const copy = document.querySelector<HTMLButtonElement>('.message-copy')!;
    copy.click();
    render(nothing, document.body);

    if (result === 'success') complete();
    else reject(new Error('clipboard denied'));
    await Promise.resolve();

    expect(copy.classList.contains('message-copy--copied')).toBe(false);
    expect(copy.title).toBe(i18nService.t('copyToClipboard'));
    expect(dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
