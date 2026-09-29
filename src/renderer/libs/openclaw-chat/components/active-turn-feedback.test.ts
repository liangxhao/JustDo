/** @vitest-environment jsdom */
import { nothing, render } from 'lit';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { renderTerminalTimelineMessage, renderTimelineItem } from './active-turn-timeline';

afterEach(() => {
  render(nothing, document.body);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('keeps long errors collapsed and copies the complete displayed diagnostic', async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const message = 'Provider request failed.\nThe connection closed before the response completed.';
  render(renderTerminalTimelineMessage(message, 'error'), document.body);
  const details = document.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(details.querySelector('summary')?.textContent).toContain('Provider request failed.');
  expect(details.querySelector('pre')?.textContent).toBe(message);
  expect(document.querySelectorAll('.chat-avatar.error')).toHaveLength(1);
  expect(document.querySelector('.chat-avatar.assistant')).toBeNull();
  const copy = document.querySelector<HTMLButtonElement>('.message-copy')!;
  copy.click();
  await Promise.resolve();
  expect(writeText).toHaveBeenCalledExactlyOnceWith(message);
  expect(copy.getAttribute('aria-label')).toBe(i18nService.t('copied'));
  vi.advanceTimersByTime(1500);
  expect(copy.getAttribute('aria-label')).toBe(i18nService.t('coworkCopyError'));
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
