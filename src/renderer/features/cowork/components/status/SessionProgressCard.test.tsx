// @vitest-environment jsdom

import { type ProgressCard, ProgressCardStepStatus } from '@shared/openclaw/progressCard';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SessionProgressCard from './SessionProgressCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
    const { container } = render(<SessionProgressCard card={activeCard} runState="running" />);

    expect(screen.getByRole('region', { name: '任务进度' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '任务进度', level: 3 })).toBeTruthy();
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
      />,
    );

    expect(screen.getByText('任务进度')).toBeTruthy();
    expect(screen.queryByText('查看当前状态')).toBeNull();
  });

  it('lets the user collapse an active card without losing it', () => {
    i18nService.setLanguage('en', { persist: false });
    render(<SessionProgressCard card={activeCard} runState="running" />);

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
    render(<SessionProgressCard card={completedCard} runState="completed" />);

    expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
    expect(screen.getByText('检查代码')).toBeTruthy();
  });

  it('presents an orphaned in-progress step as paused without changing its data', () => {
    i18nService.setLanguage('zh', { persist: false });
    render(<SessionProgressCard card={activeCard} runState="idle" />);

    expect(screen.getByRole('img', { name: '已暂停' }).textContent).toBe('Ⅱ');
    expect(activeCard.steps?.[1]?.status).toBe(ProgressCardStepStatus.InProgress);
  });

  it('presents an incomplete plan as waiting when its run finishes normally', () => {
    i18nService.setLanguage('zh', { persist: false });
    const { container } = render(<SessionProgressCard card={activeCard} runState="completed" />);

    expect(screen.getByRole('button', { name: /等待继续/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: '等待继续' }).textContent).toBe('Ⅱ');
    expect(screen.getByText('已完成 1/3')).toBeTruthy();
    expect(container.querySelector('.cowork-progress-card__state--waiting')).toBeTruthy();
    expect(activeCard.steps?.[1]?.status).toBe(ProgressCardStepStatus.InProgress);
  });

  it('preserves the user disclosure choice across progress revisions', async () => {
    i18nService.setLanguage('en', { persist: false });
    const { rerender } = render(<SessionProgressCard card={activeCard} runState="running" />);
    fireEvent.click(screen.getByRole('button', { expanded: true }));

    rerender(
      <SessionProgressCard
        card={{ ...activeCard, revision: activeCard.revision + 1 }}
        runState="running"
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
      render(<SessionProgressCard card={activeCard} runState={runState} />);

      expect(screen.getByRole('img', { name: label })).toBeTruthy();
      expect(screen.queryByRole('img', { name: 'Paused' })).toBeNull();
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeTruthy();
    },
  );
});

describe('progress note disclosure', () => {
  const card: ProgressCard = {
    sessionKey: 'agent:main:progress-note',
    revision: 1,
    updatedAt: 1,
    markdown:
      '| 项目 | 状态 |\n| --- | --- |\n| 阅读 | 已完成 |\n\n[详细材料](https://example.com/details)',
    steps: [{ step: '核对结果', status: ProgressCardStepStatus.Pending }],
  };

  function mockNoteLayout(initialHeight: number) {
    let height = initialHeight;
    let resized = () => {};
    const disconnect = vi.fn();
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('cowork-progress-card__markdown') ? height : 0;
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    return {
      resize(nextHeight: number) {
        height = nextHeight;
        act(() => resized());
      },
      disconnect,
    };
  }

  it('shows notes within the fifteen-line preview completely without an expansion button', () => {
    i18nService.setLanguage('zh', { persist: false });
    mockNoteLayout(275);
    render(<SessionProgressCard card={card} runState="idle" />);

    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('link', { name: '详细材料' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '展开全部' })).toBeNull();
    expect(screen.getByText('核对结果')).toBeTruthy();
  });

  it('expands and collapses only the note while retaining its rich content and the steps', () => {
    i18nService.setLanguage('zh', { persist: false });
    mockNoteLayout(300);
    render(<SessionProgressCard card={card} runState="idle" />);
    const toggle = screen.getByRole('button', { name: '展开全部', expanded: false });
    const preview = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    const savedHtml = preview.innerHTML;
    expect(preview.style.maxHeight).not.toBe('');
    expect(screen.getByText('核对结果')).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: '收起', expanded: true })).toBe(toggle);
    expect(preview.style.maxHeight).toBe('');
    expect(preview.innerHTML).toBe(savedHtml);
    expect(screen.getByText('核对结果')).toBeTruthy();

    fireEvent.click(toggle);
    expect(preview.style.maxHeight).not.toBe('');
    expect(preview.innerHTML).toBe(savedHtml);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('核对结果')).toBeTruthy();
  });

  it('retains an expanded note across revisions and resets it when switching sessions', () => {
    i18nService.setLanguage('en', { persist: false });
    mockNoteLayout(300);
    const { rerender } = render(<SessionProgressCard card={card} runState="idle" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));

    const updated = { ...card, revision: 2, markdown: 'New progress note.' };
    rerender(<SessionProgressCard card={updated} runState="idle" />);
    expect(screen.getByRole('button', { name: 'Show less', expanded: true })).toBeTruthy();
    expect(screen.getByText('New progress note.')).toBeTruthy();

    rerender(
      <SessionProgressCard
        card={{ ...updated, sessionKey: 'agent:main:next-note' }}
        runState="idle"
      />,
    );
    expect(screen.getByRole('button', { name: 'Show all', expanded: false })).toBeTruthy();
    expect(screen.getByText('核对结果')).toBeTruthy();
  });

  it('rechecks overflow after layout changes and disconnects its observer on unmount', () => {
    i18nService.setLanguage('en', { persist: false });
    const layout = mockNoteLayout(80);
    const { unmount } = render(<SessionProgressCard card={card} runState="idle" />);
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();

    layout.resize(300);
    expect(screen.getByRole('button', { name: 'Show all' })).toBeTruthy();
    layout.resize(80);
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    expect(screen.getByText('核对结果')).toBeTruthy();

    unmount();
    expect(layout.disconnect).toHaveBeenCalledOnce();
  });

  it('reveals the complete note when a link receives keyboard focus', () => {
    i18nService.setLanguage('en', { persist: false });
    mockNoteLayout(300);
    render(<SessionProgressCard card={card} runState="idle" />);
    expect(screen.getByRole('button', { name: 'Show all', expanded: false })).toBeTruthy();

    fireEvent.focus(screen.getByRole('link', { name: '详细材料' }));
    expect(screen.getByRole('button', { name: 'Show less', expanded: true })).toBeTruthy();
    expect(screen.getByText('核对结果')).toBeTruthy();
  });
});

describe('progress refresh', () => {
  const card: ProgressCard = {
    sessionKey: 'agent:main:progress-refresh',
    revision: 7,
    updatedAt: Date.now(),
    markdown: 'Saved status',
  };

  it('keeps saved progress visible and unlocks when the read finishes with no revision change', async () => {
    let finishRead!: (value: boolean) => void;
    const onRefresh = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          finishRead = resolve;
        }),
    );
    render(<SessionProgressCard card={card} runState="idle" onRefresh={onRefresh} />);
    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: i18nService.t('coworkProgressCardRefresh'),
    });

    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Saved status')).toBeTruthy();
    await act(async () => finishRead(true));

    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    await act(async () => finishRead(true));
  });

  it.each(['failed', 'rejected'])('reports a %s read and lets the user retry', async outcome => {
    const onRefresh = vi.fn().mockResolvedValue(true);
    if (outcome === 'failed') onRefresh.mockResolvedValueOnce(false);
    else onRefresh.mockRejectedValueOnce(new Error('Disconnected'));
    render(<SessionProgressCard card={card} runState="idle" onRefresh={onRefresh} />);
    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: i18nService.t('coworkProgressCardRefresh'),
    });

    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        i18nService.t('coworkProgressCardRefreshFailed'),
      ),
    );
    expect(button.disabled).toBe(false);
    expect(screen.getByText('Saved status')).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('waits for the read to finish even if a new revision arrives while pending', async () => {
    let finishRead!: (value: boolean) => void;
    const onRefresh = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          finishRead = resolve;
        }),
    );
    const { rerender } = render(
      <SessionProgressCard card={card} runState="idle" onRefresh={onRefresh} />,
    );
    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: i18nService.t('coworkProgressCardRefresh'),
    });
    fireEvent.click(button);

    rerender(
      <SessionProgressCard
        card={{ ...card, revision: 8, markdown: 'New status' }}
        runState="idle"
        onRefresh={onRefresh}
      />,
    );
    expect(button.disabled).toBe(true);
    expect(screen.getByText('New status')).toBeTruthy();
    await act(async () => finishRead(true));
    expect(button.disabled).toBe(false);
  });

  it('keeps a timed-out read failed when its late result arrives', async () => {
    vi.useFakeTimers();
    let finishRead!: (value: boolean) => void;
    const onRefresh = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          finishRead = resolve;
        }),
    );
    render(<SessionProgressCard card={card} runState="idle" onRefresh={onRefresh} />);
    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: i18nService.t('coworkProgressCardRefresh'),
    });
    fireEvent.click(button);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(button.disabled).toBe(false);
    expect(screen.getByRole('status')).toBeTruthy();
    await act(async () => finishRead(true));
    expect(screen.getByRole('status')).toBeTruthy();
  });
});
