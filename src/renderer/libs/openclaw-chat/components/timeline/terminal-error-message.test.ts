/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { formatTerminalErrorText, TerminalErrorMessage } from './terminal-error-message';

const originalLanguage = i18nService.getLanguage();

afterEach(() => {
  document.body.replaceChildren();
  i18nService.setLanguage(originalLanguage, { persist: false });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('terminal error text', () => {
  test.each(['\n', '\r\n'])(
    'decodes the native rejection summary and joins its detail with %j line endings',
    newline => {
      expect(
        formatTerminalErrorText(
          String.raw`LLM request rejected: Unsupported model mimo\-v2\.5` +
            newline +
            '400 Unsupported model mimo-v2.5',
        ),
      ).toBe('LLM request rejected: Unsupported model mimo-v2.5: 400 Unsupported model mimo-v2.5');
    },
  );

  test.each([
    [String.raw`Could not read C\:\\Models\\\.cache`, String.raw`Could not read C:\Models\.cache`],
    [String.raw`Could not read \\\\server\\model`, String.raw`Could not read \\server\model`],
    [String.raw`Invalid regex \\\.\*`, String.raw`Invalid regex \.*`],
  ])('restores literal backslashes in a fully escaped native payload: %s', (escaped, plain) => {
    expect(formatTerminalErrorText(`LLM request rejected: ${escaped}`)).toBe(
      `LLM request rejected: ${plain}`,
    );
  });

  test.each([
    String.raw`LLM request rejected: Could not read C:\Models\.cache`,
    String.raw`LLM request rejected: Invalid regex /\./`,
    String.raw`Could not read \\server\model`,
    String.raw`Invalid regex \.*`,
  ])('preserves diagnostics without the complete native escaping format: %s', message => {
    expect(formatTerminalErrorText(message)).toBe(message);
  });

  test('retains raw detail escapes and subsequent diagnostic lines', () => {
    const detail = String.raw`C:\Models\.cache` + '\n' + String.raw`\\server\model`;
    expect(formatTerminalErrorText(`LLM request rejected: Invalid field\n${detail}`)).toBe(
      `LLM request rejected: Invalid field: ${detail}`,
    );
  });

  test.each([
    ['', ''],
    ['\n', ''],
    ['Failure\n\n', 'Failure'],
    ['Failure:\nCause', 'Failure: Cause'],
    ['Failure.\nCause', 'Failure: Cause'],
    ['失败。\n原因', '失败: 原因'],
    ['失败：\n原因', '失败： 原因'],
  ])('handles empty text and existing separators: %j', (message, expected) => {
    expect(formatTerminalErrorText(message)).toBe(expected);
  });
});

describe('terminal error disclosure', () => {
  let resize: () => void;
  let contentHeight: number;
  let width: number;
  const disconnect = vi.fn();

  beforeEach(() => {
    contentHeight = 20;
    width = 320;
    disconnect.mockClear();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
  });

  async function mount(message = 'Failure\nCause') {
    const error = document.createElement('chat-terminal-error') as TerminalErrorMessage;
    error.message = message;
    document.body.append(error);
    await error.updateComplete;
    const text = error.querySelector<HTMLElement>('.process-terminal__error-text')!;
    text.style.lineHeight = '20px';
    vi.spyOn(text, 'getBoundingClientRect').mockImplementation(() => ({ width }) as DOMRect);
    vi.spyOn(text, 'scrollHeight', 'get').mockImplementation(() => contentHeight);
    resize();
    await error.updateComplete;
    return { error, text, button: error.querySelector<HTMLButtonElement>('button')! };
  }

  test.each([20, 40, 60, 61])(
    'keeps errors fitting three lines visible without a button (%ipx)',
    async height => {
      contentHeight = height;
      const { text, button } = await mount();
      expect(text.textContent).toBe('Failure: Cause');
      expect(button.hidden).toBe(true);
    },
  );

  test('expands and collapses one complete text node only when actual layout exceeds three lines', async () => {
    contentHeight = 80;
    const { error, text, button } = await mount();
    expect(button.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe(text.id);
    button.click();
    await error.updateComplete;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toContain(i18nService.t('coworkErrorCollapse'));
    expect(text.classList.contains('is-expanded')).toBe(true);
    expect(error.querySelectorAll('.process-terminal__error-text')).toHaveLength(1);
    expect(error.textContent?.split('Failure: Cause')).toHaveLength(2);
    button.click();
    await error.updateComplete;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(text.classList.contains('is-expanded')).toBe(false);
  });

  test('remeasures on resize, retains expansion for the same message and resets for changed text', async () => {
    const { error, button } = await mount();
    contentHeight = 100;
    resize();
    await error.updateComplete;
    expect(button.hidden).toBe(false);
    button.click();
    await error.updateComplete;
    error.message = 'Failure\nCause';
    await error.updateComplete;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    error.message = 'Different failure\nDifferent cause';
    await error.updateComplete;
    await error.updateComplete;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    await error.updateComplete;
    contentHeight = 40;
    resize();
    await error.updateComplete;
    expect(button.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  test('preserves overflow while hidden, cleans up and measures again after reconnect', async () => {
    contentHeight = 80;
    const { error, button } = await mount();
    width = 0;
    contentHeight = 0;
    resize();
    await error.updateComplete;
    expect(button.hidden).toBe(false);
    error.remove();
    expect(disconnect).toHaveBeenCalledOnce();
    width = 320;
    contentHeight = 20;
    document.body.append(error);
    await error.updateComplete;
    await error.updateComplete;
    expect(button.hidden).toBe(true);
  });

  test('treats decoded HTML and Markdown as text and assigns unique disclosure targets', async () => {
    const { error, text } = await mount(
      String.raw`LLM request rejected: \<img src\=x onerror\=alert\(1\)\> \[link\]\(https\:\/\/example\.com\)`,
    );
    const second = await mount();
    expect(text.textContent).toBe(
      'LLM request rejected: <img src=x onerror=alert(1)> [link](https://example.com)',
    );
    expect(error.querySelector('img, a, script')).toBeNull();
    expect(text.id).not.toBe(second.text.id);
  });

  test('reveals a search match synchronously before its caller measures the target', async () => {
    contentHeight = 100;
    const { error, text, button } = await mount();
    error.revealText();
    expect(text.classList.contains('is-expanded')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  test('updates disclosure labels when the language changes without changing the message', async () => {
    contentHeight = 100;
    i18nService.setLanguage('en', { persist: false });
    const { error, button } = await mount();
    expect(button.textContent).toContain('Error details');
    i18nService.setLanguage('zh', { persist: false });
    await error.updateComplete;
    expect(button.textContent).toContain('错误详情');
    button.click();
    await error.updateComplete;
    expect(button.textContent).toContain('收起详情');
    i18nService.setLanguage('en', { persist: false });
    await error.updateComplete;
    expect(button.textContent).toContain('Show less');
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  test('unsubscribes language updates while disconnected and refreshes on reconnect', async () => {
    const subscribe = i18nService.subscribe.bind(i18nService);
    const unsubscribe = vi.fn();
    vi.spyOn(i18nService, 'subscribe').mockImplementation(listener => {
      const remove = subscribe(listener);
      return () => {
        remove();
        unsubscribe();
      };
    });
    contentHeight = 100;
    i18nService.setLanguage('en', { persist: false });
    const { error, button } = await mount();
    error.remove();
    expect(unsubscribe).toHaveBeenCalledOnce();
    i18nService.setLanguage('zh', { persist: false });
    document.body.append(error);
    await error.updateComplete;
    expect(button.textContent).toContain('错误详情');
  });
});
