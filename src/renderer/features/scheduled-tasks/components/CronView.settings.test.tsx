// @vitest-environment jsdom
import type { ScheduledTask } from '@shared/scheduledTask/types';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { CronView } from './CronView';

const state = {
  scheduledTask: {
    tasks: [] as ScheduledTask[],
    loading: false,
    error: null,
    unreadResultCount: 0,
    runs: {},
  },
  agent: { agents: [] as { id: string; name: string; deletedAt?: number }[] },
};
vi.mock('react-redux', () => ({
  useSelector: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key, getLanguage: () => 'en' },
}));
vi.mock('@/app/shell/window/WindowTitleBar', () => ({ default: () => null }));
vi.mock('@/features/scheduled-tasks/scheduledTaskService', () => ({
  scheduledTaskService: { loadTasks: vi.fn(), listChannels: vi.fn().mockResolvedValue([]) },
}));
vi.mock('./memoryDreamingControl', async importOriginal => ({
  ...(await importOriginal<typeof import('./memoryDreamingControl')>()),
  useMemoryDreamingControl: () => ({ settings: null }),
  withMemoryDreamingCard: (tasks: unknown[]) => tasks,
}));
vi.mock('./SchedulerSettingsDialog', () => ({
  default: ({
    onSaved,
    onClose,
  }: {
    onSaved: (settings: { enabled: boolean }) => void;
    onClose: () => void;
  }) => (
    <button
      onClick={() => {
        onSaved({ enabled: false });
        onClose();
      }}
    >
      save-paused
    </button>
  ),
}));
afterEach(() => {
  cleanup();
  state.scheduledTask.tasks = [];
  state.agent.agents = [];
});

test('removes a deleted assistant from skill review members when the roster refreshes', async () => {
  const { withMemoryDreamingCard } =
    await vi.importActual<typeof import('./memoryDreamingControl')>('./memoryDreamingControl');
  const base = withMemoryDreamingCard([], {
    memoryDreamingEnabled: false,
    memoryAvailable: true,
    skillMode: 'auto',
  })[0];
  state.scheduledTask.tasks = ['main', 'reviewer'].map(agentId => ({
    ...base,
    id: agentId,
    agentId,
    declarationKey: `skill-collection-review:${agentId}`,
    payload: { kind: 'agentTurn', message: 'Review skills' },
  }));
  state.agent.agents = [
    { id: 'main', name: 'Main' },
    { id: 'reviewer', name: 'Reviewer' },
  ];
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', scheduledTasks: {} },
  });
  const { rerender } = render(<CronView />);
  expect(screen.getByText('@Reviewer')).toBeTruthy();
  state.agent.agents = [
    { id: 'main', name: 'Main' },
    { id: 'reviewer', name: 'Reviewer', deletedAt: 123 },
  ];
  rerender(<CronView />);
  expect(screen.queryByText('@Reviewer')).toBeNull();
  expect(screen.getByText('@Main')).toBeTruthy();
  expect(screen.getByText('cronSkillReviewMembers (1)')).toBeTruthy();
  expect(state.scheduledTask.tasks).toHaveLength(2);
});

test('a delayed initial settings read does not overwrite the saved scheduling state', async () => {
  let resolveInitial!: (value: unknown) => void;
  const getSchedulerSettings = vi.fn(
    () =>
      new Promise(resolve => {
        resolveInitial = resolve;
      }),
  );
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { platform: 'win32', scheduledTasks: { getSchedulerSettings } },
  });
  render(<CronView />);
  fireEvent.click(screen.getByRole('button', { name: 'schedulerSettingsTitle' }));
  fireEvent.click(screen.getByRole('button', { name: 'save-paused' }));
  expect(screen.getByText('schedulerSettingsPaused')).toBeTruthy();
  await act(async () => {
    resolveInitial({ success: true, snapshot: { settings: { enabled: true } } });
  });
  expect(screen.getByText('schedulerSettingsPaused')).toBeTruthy();
});
