/** @vitest-environment jsdom */
import { PRODUCT_NAME } from '@shared/productMetadata';
import { nothing, render } from 'lit';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { chatStyles } from '../justdo-chat.styles';
import { renderTerminalTimelineMessage, renderTimelineItem } from './active-turn-timeline';
import type { TerminalErrorMessage } from './terminal-error-message';

let style: HTMLStyleElement | undefined;

afterEach(() => {
  render(nothing, document.body);
  style?.remove();
  style = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each([
  '⚠ Provider request failed.',
  'Provider request failed.\nThe connection closed before the response completed.',
  'Provider request failed. '.repeat(12),
  `${'Provider request failed. '.repeat(12)}\nThe connection closed.`,
])('keeps the error copy button hidden until interaction: %s', async message => {
  style = document.createElement('style');
  style.textContent = chatStyles.map(styles => styles.cssText).join('\n');
  document.head.append(style);
  render(renderTerminalTimelineMessage(message, 'error'), document.body);
  await document.querySelector<TerminalErrorMessage>('chat-terminal-error')?.updateComplete;
  expect(document.querySelector('.process-terminal--error')?.textContent).not.toContain('⚠');

  const copy = document.querySelector<HTMLButtonElement>('.message-copy')!;
  expect(getComputedStyle(copy).opacity).toBe('0');
  expect(getComputedStyle(copy).pointerEvents).toBe('none');
});

test.each(['\n', '\r\n'])(
  'joins short error details and copies the complete diagnostic with %j line endings',
  async lineEnding => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const summary = 'Provider request failed.';
    const detail = 'The connection closed before the response completed.';
    const message = `⚠️ ${summary}${lineEnding}${detail}`;
    render(renderTerminalTimelineMessage(message, 'error'), document.body);
    const error = document.querySelector<TerminalErrorMessage>('chat-terminal-error')!;
    await error.updateComplete;
    expect(error.querySelector('.process-terminal__error-text')?.textContent).toBe(
      `${summary}: ${detail}`,
    );
    expect(error.querySelector<HTMLButtonElement>('button')?.hidden).toBe(true);
    expect(error.textContent?.split(summary)).toHaveLength(2);
    expect(error.textContent).not.toContain('⚠');
    expect(document.querySelectorAll('.chat-avatar.error')).toHaveLength(1);
    expect(document.querySelector('.chat-avatar.assistant')).toBeNull();
    const copy = document.querySelector<HTMLButtonElement>('.message-copy')!;
    copy.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(message);
    expect(copy.getAttribute('aria-label')).toBe(i18nService.t('copied'));
    vi.advanceTimersByTime(1500);
    expect(copy.getAttribute('aria-label')).toBe(i18nService.t('coworkCopyError'));
  },
);

test.each([
  'For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.',
  'If it continues, open Settings → Logs in the Control UI or run `openclaw logs --follow`.',
  'Troubleshooting: run `openclaw logs --follow` in a terminal.',
])('displays and copies the branded failure without the native log hint: %s', async hint => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const detail = 'Provider finish_reason: content_filter';
  const message = `⚠️ OpenClaw couldn't finish this reply. ${hint}\n${detail}`;

  render(renderTerminalTimelineMessage(message, 'error'), document.body);
  await document.querySelector<TerminalErrorMessage>('chat-terminal-error')?.updateComplete;

  expect(document.querySelector('.process-terminal__error-text')?.textContent).toBe(
    `${PRODUCT_NAME} couldn't finish this reply.: ${detail}`,
  );
  expect(document.querySelector('.process-terminal')?.textContent).not.toContain(hint);
  document.querySelector<HTMLButtonElement>('.message-copy')!.click();
  await Promise.resolve();
  expect(writeText).toHaveBeenCalledExactlyOnceWith(
    `⚠️ ${PRODUCT_NAME} couldn't finish this reply.\n${detail}`,
  );
});

test('updates the working stage and timer without announcing every elapsed tick', () => {
  render(
    renderTimelineItem({
      kind: 'waiting',
      key: 'waiting:run-1',
      stage: 'responding',
      notice: { kind: 'reconnecting', tone: 'warning', quietMs: 30000 },
    }),
    document.body,
  );
  const label = document.querySelector('[role="status"]');
  expect(label?.textContent).toBe(i18nService.t('coworkWaitingReconnecting'));
  render(
    renderTimelineItem(
      {
        kind: 'waiting',
        key: 'waiting:run-1',
        startedAt: 1000,
        stage: 'thinking',
      },
      65000,
    ),
    document.body,
  );
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    i18nService.t('coworkWorkingThinking'),
  );
  expect(document.querySelector('[role="status"]')).toBe(label);
  expect(document.querySelector('.chat-working-indicator--warning')).toBeNull();
  expect(document.querySelector('.chat-working-indicator__elapsed')?.textContent).toBe('1m 4s');
  expect(
    document.querySelector('.chat-working-indicator__elapsed')?.getAttribute('aria-live'),
  ).toBe('off');
  render(
    renderTimelineItem(
      {
        kind: 'waiting',
        key: 'waiting:run-1',
        startedAt: 1000,
        stage: 'responding',
      },
      66000,
    ),
    document.body,
  );
  expect(document.querySelectorAll('.chat-working-indicator')).toHaveLength(1);
  expect(
    document.querySelector('.chat-group__avatar > .chat-working-indicator__spark'),
  ).not.toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    i18nService.t('coworkWorkingResponding'),
  );
});
