// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRunActivityView,
  formatElapsed,
} from '../conversation-overlay/modules/sidepanel-activity.js';
import { sidePanelText as t } from '../conversation-overlay/modules/sidepanel-i18n.js';

describe('side panel run activity', () => {
  afterEach(() => vi.useRealTimers());

  it('updates admitted stages, counts and elapsed time while preserving the animation and announcement nodes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const element = document.createElement('div');
    const view = createRunActivityView(element);
    const activity = {
      runId: 'run-1',
      stage: 'generating-tool-input',
      startedAt: 8000,
      lastAgentEventAt: 10_000,
      progress: {
        kind: 'tool-input',
        name: 'write',
        toolCallId: 'call-1',
        receivedChars: 500,
        complete: false,
      },
    };
    view.render(activity);
    const icon = element.querySelector('.run-activity-icon');
    const label = element.querySelector('.run-activity-label');
    expect(label?.textContent).toBe(t('generating-tool-input'));
    expect(element.querySelector('.run-activity-detail')?.textContent).toContain('500');
    expect(element.querySelector('.run-activity-elapsed')?.textContent).toBe('2s');
    view.render({ ...activity, progress: { ...activity.progress, receivedChars: 750 } });
    vi.advanceTimersByTime(2000);
    expect(element.querySelector('.run-activity-icon')).toBe(icon);
    expect(element.querySelector('.run-activity-label')).toBe(label);
    expect(element.querySelector('.run-activity-elapsed')?.textContent).toBe('4s');
    expect(element.querySelector('.run-activity-elapsed')?.getAttribute('aria-live')).toBe('off');
    expect(element.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(element.textContent).not.toContain('%');
    view.render(null);
    expect(element.classList.contains('hidden')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    view.dispose();
  });

  it('only shows retry counts and countdowns supplied by native activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const element = document.createElement('div');
    const view = createRunActivityView(element);
    view.render({ runId: 'run-1', stage: 'retrying', startedAt: 1000, lastAgentEventAt: 9000 });
    expect(element.querySelector('.run-activity-detail')?.textContent).toBe('');
    view.render({
      runId: 'run-1',
      stage: 'retrying',
      startedAt: 1000,
      lastAgentEventAt: 9000,
      retryAttempt: 1,
      maxRetries: 3,
      retryAt: 12_000,
    });
    expect(element.querySelector('.run-activity-detail')?.textContent).toContain(
      t('retryCount', { attempt: 1, total: 3 }),
    );
    expect(element.querySelector('.run-activity-detail')?.textContent).toContain(
      t('retryIn', { seconds: 2 }),
    );
    view.dispose();
  });

  it('formats elapsed time without an estimated completion time', () => {
    expect(formatElapsed(-500)).toBe('0s');
    expect(formatElapsed(61_000)).toBe('1:01');
  });
});
