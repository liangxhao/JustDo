// @vitest-environment jsdom

import { type ProgressCard, ProgressCardStepStatus } from '@shared/openclaw/progressCard';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SessionProgressCard from './SessionProgressCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SessionProgressCard', () => {
  const activeCard: ProgressCard = {
    sessionKey: 'agent:main:justdo:session-1',
    revision: 3,
    updatedAt: Date.now(),
    markdown:
      '正在运行测试。\n\n<progress value="3" max="7"></progress>\n\n<script>alert(1)</script>',
    steps: [
      { step: '检查代码', status: ProgressCardStepStatus.Completed },
      { step: '运行测试', status: ProgressCardStepStatus.InProgress },
      { step: '整理结果', status: ProgressCardStepStatus.Pending },
    ],
  };

  it('shows the current durable card with safe Markdown and an accessible progress bar', () => {
    i18nService.setLanguage('zh', { persist: false });
    const { container } = render(
      <SessionProgressCard card={activeCard} runState="running" onClose={vi.fn()} />,
    );

    expect(screen.getByRole('complementary', { name: '任务进度' })).toBeTruthy();
    expect(screen.getAllByText('运行测试')).toHaveLength(1);
    expect(screen.getByText('已完成 1/3')).toBeTruthy();
    const progress = container.querySelector('progress');
    expect(progress?.getAttribute('value')).toBe('3');
    expect(progress?.getAttribute('max')).toBe('7');
    expect(screen.getByRole('progressbar', { name: '任务完成进度' })).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).not.toContain('alert(1)');
  });

  it('does not add a redundant status subtitle to a Markdown-only card', () => {
    i18nService.setLanguage('zh', { persist: false });
    render(
      <SessionProgressCard
        card={{
          sessionKey: activeCard.sessionKey,
          revision: 4,
          updatedAt: Date.now(),
          markdown: '当前任务：等待新任务',
        }}
        runState="idle"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('任务进度')).toBeTruthy();
    expect(screen.queryByText('查看当前状态')).toBeNull();
  });

  it('lets the user collapse an active card without losing it', () => {
    i18nService.setLanguage('en', { persist: false });
    render(<SessionProgressCard card={activeCard} runState="running" onClose={vi.fn()} />);

    const disclosure = screen.getByRole('button', { expanded: true });
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('检查代码')).toBeNull();
  });

  it('opens a restored completed card so the user can review its steps', () => {
    i18nService.setLanguage('zh', { persist: false });
    const completedCard: ProgressCard = {
      ...activeCard,
      revision: 4,
      markdown: '全部完成。',
      steps: activeCard.steps?.map(step => ({
        ...step,
        status: ProgressCardStepStatus.Completed,
      })),
    };
    render(<SessionProgressCard card={completedCard} runState="completed" onClose={vi.fn()} />);

    expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
    expect(screen.getByText('检查代码')).toBeTruthy();
  });

  it('presents an orphaned in-progress step as paused without changing its data', () => {
    i18nService.setLanguage('zh', { persist: false });
    render(<SessionProgressCard card={activeCard} runState="idle" onClose={vi.fn()} />);

    expect(screen.getByRole('img', { name: '已暂停' }).textContent).toBe('Ⅱ');
    expect(activeCard.steps?.[1]?.status).toBe(ProgressCardStepStatus.InProgress);
  });

  it('presents an incomplete plan as waiting when its run finishes normally', () => {
    i18nService.setLanguage('zh', { persist: false });
    const { container } = render(
      <SessionProgressCard card={activeCard} runState="completed" onClose={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: /等待继续/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: '等待继续' }).textContent).toBe('Ⅱ');
    expect(screen.getByText('已完成 1/3')).toBeTruthy();
    expect(container.querySelector('.cowork-progress-card__state--waiting')).toBeTruthy();
    expect(activeCard.steps?.[1]?.status).toBe(ProgressCardStepStatus.InProgress);
  });

  it('hides locally without mutating the durable progress card', () => {
    i18nService.setLanguage('en', { persist: false });
    const onClose = vi.fn();
    render(<SessionProgressCard card={activeCard} runState="running" onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide task progress' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('preserves the user disclosure choice across progress revisions', async () => {
    i18nService.setLanguage('en', { persist: false });
    const { rerender } = render(
      <SessionProgressCard card={activeCard} runState="running" onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { expanded: true }));

    rerender(
      <SessionProgressCard
        card={{ ...activeCard, revision: activeCard.revision + 1 }}
        runState="running"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { expanded: false })).toBeTruthy());
  });

  it.each([
    ['failed', 'Failed'],
    ['aborted', 'Stopped'],
  ] as const)(
    'shows a terminal %s outcome instead of calling the active step paused',
    (runState, label) => {
      i18nService.setLanguage('en', { persist: false });
      render(<SessionProgressCard card={activeCard} runState={runState} onClose={vi.fn()} />);

      expect(screen.getByRole('img', { name: label })).toBeTruthy();
      expect(screen.queryByRole('img', { name: 'Paused' })).toBeNull();
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy();
    },
  );
});
