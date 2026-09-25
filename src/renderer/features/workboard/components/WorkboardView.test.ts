// @vitest-environment jsdom

import { WORKBOARD_STATUSES, type WorkboardCard } from '@shared/openclaw/workboard';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { workboardService } from '../workboardService';
import WorkboardView from './WorkboardView';

vi.mock('react-redux', () => ({ useSelector: () => [] }));
vi.mock('@/app/shell/window/WindowTitleBar', () => ({ default: () => null }));
vi.mock('./WorkboardSessionDrawer', () => ({
  default: (props: { sessionKey: string; canStop: boolean; onStop: () => void }) =>
    createElement(
      'div',
      { 'data-testid': 'session' },
      props.sessionKey,
      props.canStop ? createElement('button', { onClick: props.onStop }, 'stop-session') : null,
    ),
}));
vi.mock('../workboardService', () => ({
  workboardService: {
    getSnapshot: vi.fn(),
    onChanged: vi.fn(() => vi.fn()),
    resolveSession: vi.fn(),
    stopCard: vi.fn(),
    moveCard: vi.fn(),
  },
}));

const card = (id: string): WorkboardCard => ({
  id,
  title: id,
  status: 'running',
  priority: 'normal',
  labels: [],
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  sessionKey: `session-${id}`,
  runId: `run-${id}`,
});
const snapshot = (cards: WorkboardCard[]) => ({ cards, boards: [], statuses: WORKBOARD_STATUSES });
const mount = () =>
  render(
    createElement(WorkboardView, {
      isSidebarCollapsed: false,
      onToggleSidebar: vi.fn(),
      onNewChat: vi.fn(),
    }),
  );

beforeEach(() => {
  Object.defineProperty(window, 'electron', { configurable: true, value: { platform: 'win32' } });
  i18nService.setLanguage('zh', { persist: false });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Workboard session selection', () => {
  it('preserves task-only identity when stopping from details', async () => {
    const taskCard = { ...card('a'), sessionKey: undefined, runId: undefined, taskId: 'task-a' };
    vi.mocked(workboardService.getSnapshot).mockResolvedValue(snapshot([taskCard]));
    vi.mocked(workboardService.stopCard).mockResolvedValue(taskCard);
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: i18nService.t('workboardViewDetails') }),
    );
    fireEvent.click(await screen.findByRole('button', { name: '停止执行' }));
    await waitFor(() =>
      expect(workboardService.stopCard).toHaveBeenCalledWith('a', {
        sessionKey: undefined,
        runId: undefined,
        taskId: 'task-a',
      }),
    );
  });

  it('sends the displayed execution identity when stopping', async () => {
    vi.mocked(workboardService.getSnapshot).mockResolvedValue(
      snapshot([{ ...card('a'), taskId: 'task-a' }]),
    );
    vi.mocked(workboardService.resolveSession).mockResolvedValue({ sessionKey: 'canonical-a' });
    vi.mocked(workboardService.stopCard).mockResolvedValue(card('a'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '查看会话' }));
    fireEvent.click(await screen.findByRole('button', { name: 'stop-session' }));
    await waitFor(() =>
      expect(workboardService.stopCard).toHaveBeenCalledWith('a', {
        sessionKey: 'canonical-a',
        runId: 'run-a',
        taskId: 'task-a',
      }),
    );
  });

  it('keeps the last clicked session when resolution responses arrive out of order', async () => {
    vi.mocked(workboardService.getSnapshot).mockResolvedValue(snapshot([card('a'), card('b')]));
    let resolveFirst!: (value: { sessionKey: string }) => void;
    vi.mocked(workboardService.resolveSession)
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ sessionKey: 'canonical-b' });
    mount();
    const buttons = await screen.findAllByRole('button', { name: '查看会话' });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(screen.getByTestId('session').textContent).toContain('canonical-b'));
    await act(async () => resolveFirst({ sessionKey: 'canonical-a' }));
    expect(screen.getByTestId('session').textContent).toContain('canonical-b');
  });

  it('does not let an old session drawer stop a newly linked execution', async () => {
    let changed!: Parameters<typeof workboardService.onChanged>[0];
    vi.mocked(workboardService.onChanged).mockImplementation(listener => {
      changed = listener;
      return vi.fn();
    });
    vi.mocked(workboardService.getSnapshot).mockResolvedValue(snapshot([card('a')]));
    vi.mocked(workboardService.resolveSession).mockResolvedValue({ sessionKey: 'canonical-a' });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '查看会话' }));
    await screen.findByRole('button', { name: 'stop-session' });
    vi.mocked(workboardService.getSnapshot).mockResolvedValue(
      snapshot([{ ...card('a'), updatedAt: 2, sessionKey: 'session-new', runId: 'run-new' }]),
    );
    await act(async () => changed({}));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'stop-session' })).toBeNull());
    expect(screen.getByTestId('session').textContent).toBe('canonical-a');
    expect(workboardService.stopCard).not.toHaveBeenCalled();
  });
});

describe('simplified workboard', () => {
  it('submits the displayed card version when confirming a result', async () => {
    const reviewed = { ...card('reviewed'), status: 'review' as const, updatedAt: 42 };
    vi.mocked(workboardService.getSnapshot).mockResolvedValue(snapshot([reviewed]));
    vi.mocked(workboardService.moveCard).mockResolvedValue({ ...reviewed, status: 'done' });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: i18nService.t('workboardViewDetails') }));
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('workboardConfirmDone') }));
    await waitFor(() => expect(workboardService.moveCard).toHaveBeenCalledWith('reviewed', 'done', 1024, 42));
  });

  it('keeps live review cards in progress without saying that the run has finished', async () => {
    vi.mocked(workboardService.getSnapshot).mockResolvedValue(
      snapshot([
        {
          ...card('live-review'),
          status: 'review',
          execution: {
            id: 'execution-1',
            kind: 'agent-session',
            mode: 'manual',
            status: 'running',
            startedAt: 1,
            updatedAt: 2,
          },
        },
      ]),
    );
    mount();
    await screen.findByRole('heading', { name: 'live-review' });
    const running = screen.getByRole('region', {
      name: i18nService.t('workboardColumn_running'),
    });
    expect(within(running).getByRole('heading', { name: 'live-review' })).toBeTruthy();
    expect(screen.queryByText(i18nService.t('workboardReason_review'))).toBeNull();
  });

  it('groups all native states into four columns without hiding cards or exposing fake execution moves', async () => {
    vi.mocked(workboardService.getSnapshot).mockResolvedValue(
      snapshot(
        WORKBOARD_STATUSES.map(status => ({
          ...card(status),
          status,
          sessionKey: undefined,
          runId: undefined,
        })),
      ),
    );
    mount();
    await screen.findByRole('heading', { name: 'todo' });
    const groups = {
      pending: ['triage', 'backlog', 'todo', 'scheduled', 'ready'],
      running: ['running'],
      attention: ['review', 'blocked'],
      done: ['done'],
    };
    for (const [column, statuses] of Object.entries(groups)) {
      const region = screen.getByRole('region', {
        name: i18nService.t(`workboardColumn_${column}`),
      });
      for (const status of statuses)
        expect(within(region).getByRole('heading', { name: status })).toBeTruthy();
    }
    expect(document.querySelector('[draggable="true"]')).toBeNull();
  });
});
