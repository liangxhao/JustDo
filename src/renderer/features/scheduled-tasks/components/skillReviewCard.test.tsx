// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import type { ScheduledTask, SystemTaskSettings } from '@shared/scheduledTask/types';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, expect, test, vi } from 'vitest';

import { CronJobCard } from './CronView';
import { useMemoryDreamingControl, withMemoryDreamingCard } from './memoryDreamingControl';
import {
  excludeDeletedSkillReviewTasks,
  SKILL_REVIEW_CARD_ID,
  withSkillReviewCard,
} from './skillReviewCard';
import { isSkillCollectionReviewTask } from './utils';

const settings: SystemTaskSettings = {
  memoryDreamingEnabled: true,
  memoryAvailable: true,
  skillMode: 'off',
};
const empty: ScheduledTask[] = [];
const member = (id: string): ScheduledTask => ({
  ...withMemoryDreamingCard([], settings)[0],
  id,
  agentId: id,
  enabled: true,
  declarationKey: `skill-collection-review:${id}`,
  payload: { kind: 'agentTurn', message: 'Audit the Workshop collection.' },
});
afterEach(cleanup);

test('excludes deleted assistants from current skill members and aggregate state without removing history', () => {
  const deleted = member('deleted');
  deleted.state = { ...deleted.state, lastStatus: 'error', lastRunAtMs: 100, nextRunAtMs: 200 };
  const active = member('main');
  active.state = { ...active.state, lastStatus: 'success', lastRunAtMs: 50, nextRunAtMs: 500 };
  const disabled = member('disabled');
  disabled.enabled = false;
  const unknown = member('native-only');
  unknown.enabled = false;
  const userTask = { ...deleted, id: 'user-task', management: 'editable' as const };
  const tasks = [deleted, active, disabled, unknown, userTask];
  const visible = excludeDeletedSkillReviewTasks(tasks, [
    { id: 'deleted', deletedAt: 123 },
    { id: 'main' },
    { id: 'disabled' },
  ]);
  expect(visible).toEqual([active, disabled, unknown, userTask]);
  const card = withSkillReviewCard(visible, { ...settings, skillMode: 'auto' }).find(
    task => task.id === SKILL_REVIEW_CARD_ID,
  )!;
  expect(card.state).toMatchObject({ lastStatus: 'success', nextRunAtMs: 500 });
  expect(tasks[0]).toBe(deleted);
  expect(excludeDeletedSkillReviewTasks(tasks, [])).toEqual(tasks);
  expect(
    withSkillReviewCard(
      excludeDeletedSkillReviewTasks([deleted], [{ id: 'deleted', deletedAt: 123 }]),
      settings,
    )[0].state.nextRunAtMs,
  ).toBeNull();
});

test('groups six native agentTurn monitors without absorbing lookalike user or other managed jobs', () => {
  const members = Array.from({ length: 6 }, (_, index) => member(`agent-${index}`));
  const lookalikes = [undefined, 'heartbeat:main', 'skill-collection-review:', 'custom:review'].map(
    declarationKey => ({
      ...member('user-job'),
      declarationKey,
      name: 'Skill collection review (main)',
    }),
  );
  const result = withSkillReviewCard([...members, ...lookalikes], null);
  expect(result).toHaveLength(5);
  expect(result.slice(0, 4)).toEqual(lookalikes);
  expect(result[4]).toMatchObject({
    id: SKILL_REVIEW_CARD_ID,
    declarationKey: null,
    enabled: true,
  });
  expect(isSkillCollectionReviewTask(result[4])).toBe(true);
  expect(isSkillCollectionReviewTask({ ...members[0], management: 'editable' })).toBe(false);
  expect(members[0].payload.kind).toBe('agentTurn');
});

test('groups all skill monitors into one disabled card while preserving native jobs and other tasks', () => {
  const first = member('main');
  const second = member('research');
  const memory = withMemoryDreamingCard([], settings)[0];
  const tasks = [first, second, memory];
  const result = withSkillReviewCard(tasks, settings);
  expect(result).toHaveLength(2);
  expect(result[0]).toBe(memory);
  expect(result[1]).toMatchObject({ id: SKILL_REVIEW_CARD_ID, agentId: null, enabled: false });
  expect(tasks).toHaveLength(3);
  expect(first.enabled).toBe(true);
  expect(withSkillReviewCard([], settings)[0]).toMatchObject({ enabled: false });
  expect(withSkillReviewCard([], null)).toEqual([]);
});

test('retains failed-member visibility and uses the earliest enabled member schedule', () => {
  const failure = member('research');
  failure.state = {
    ...failure.state,
    lastStatus: 'error',
    lastRunAtMs: 100,
    nextRunAtMs: 500,
    lastError: 'failed',
  };
  const success = member('main');
  success.state = { ...success.state, lastStatus: 'success', lastRunAtMs: 200, nextRunAtMs: 300 };
  const [card] = withSkillReviewCard([failure, success], { ...settings, skillMode: 'auto' });
  expect(card.state).toMatchObject({ lastStatus: 'error', lastError: 'failed', nextRunAtMs: 300 });
  expect(withSkillReviewCard([failure, success], settings)[0].state.nextRunAtMs).toBeNull();
});

test('aggregate switch controls the feature and history/details use native member IDs', () => {
  const members = [member('research')];
  const store = configureStore({
    reducer: { agent: () => ({ agents: [{ id: 'research', name: 'Researcher' }] }) },
  });
  const onToggle = vi.fn();
  const onMemberHistory = vi.fn();
  const onMemberDetails = vi.fn();
  render(
    <Provider store={store}>
      <CronJobCard
        job={withSkillReviewCard(members, settings)[0]}
        skillToggleDisabled={false}
        skillMembers={members}
        onMemberHistory={onMemberHistory}
        onMemberDetails={onMemberDetails}
        onToggle={onToggle}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onTrigger={vi.fn()}
        onHistory={vi.fn()}
        onDetails={vi.fn()}
      />
    </Provider>,
  );
  fireEvent.click(screen.getByRole('switch'));
  expect(onToggle).toHaveBeenCalledWith(true);
  expect(screen.getByText('@Researcher')).toBeTruthy();
  const summary = document.querySelector('summary')!;
  fireEvent.click(summary);
  const buttons = screen.getAllByRole('button');
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]);
  fireEvent.click(buttons[1]);
  expect(onMemberHistory).toHaveBeenCalledWith('research');
  expect(onMemberDetails).toHaveBeenCalledWith('research');
});

test('skill toggle writes global mode only and retains its state when saving fails', async () => {
  const updateSystemSettings = vi.fn().mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      scheduledTasks: {
        getSystemSettings: vi.fn().mockResolvedValue({ success: true, settings }),
        updateSystemSettings,
      },
    },
  });
  const { result } = renderHook(() => useMemoryDreamingControl(empty));
  await waitFor(() => expect(result.current.settings).toEqual(settings));
  await act(() => result.current.toggleSkills(true));
  expect(updateSystemSettings).toHaveBeenLastCalledWith({ skillMode: 'auto' });
  expect(result.current.settings?.memoryDreamingEnabled).toBe(true);
  updateSystemSettings.mockResolvedValueOnce({ success: false });
  await act(async () => {
    await expect(result.current.toggleSkills(false)).rejects.toThrow();
  });
  expect(result.current.settings?.skillMode).toBe('auto');
  await act(() => result.current.toggleSkills(false));
  expect(updateSystemSettings).toHaveBeenLastCalledWith({ skillMode: 'off' });
  expect(result.current.settings?.skillMode).toBe('off');
});
