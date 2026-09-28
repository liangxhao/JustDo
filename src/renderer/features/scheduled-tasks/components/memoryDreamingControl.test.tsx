// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import type { ScheduledTask } from '@shared/scheduledTask/types';
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

import { i18nService } from '@/services/i18n';

import { CronJobCard } from './CronView';
import {
  MEMORY_DREAMING_CARD_ID,
  useMemoryDreamingControl,
  withMemoryDreamingCard,
} from './memoryDreamingControl';

const enabled = { memoryDreamingEnabled: true, memoryAvailable: true, skillMode: 'auto' as const };
const emptyTasks: ScheduledTask[] = [];
afterEach(cleanup);

test('retains a disabled feature card after the native job is removed without mutating task data', () => {
  const tasks = withMemoryDreamingCard(emptyTasks, { ...enabled, memoryDreamingEnabled: false });
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ id: MEMORY_DREAMING_CARD_ID, enabled: false });
  expect(emptyTasks).toEqual([]);
  const real = { ...tasks[0], id: 'native-memory-job', enabled: true };
  expect(withMemoryDreamingCard([real], { ...enabled, memoryDreamingEnabled: false })).toEqual([
    { ...real, enabled: false },
  ]);
  expect(real.enabled).toBe(true);
});

test('toggles native feature configuration off and on and keeps its previous state on failure', async () => {
  const updateSystemSettings = vi.fn().mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      scheduledTasks: {
        getSystemSettings: vi.fn().mockResolvedValue({ success: true, settings: enabled }),
        updateSystemSettings,
      },
    },
  });
  const { result } = renderHook(() => useMemoryDreamingControl(emptyTasks));
  await waitFor(() => expect(result.current.settings).toEqual(enabled));
  await act(() => result.current.toggle(false));
  expect(updateSystemSettings).toHaveBeenLastCalledWith({ memoryDreamingEnabled: false });
  expect(result.current.settings?.memoryDreamingEnabled).toBe(false);
  await act(() => result.current.toggle(true));
  expect(updateSystemSettings).toHaveBeenLastCalledWith({ memoryDreamingEnabled: true });
  updateSystemSettings.mockResolvedValueOnce({ success: false });
  await act(async () => {
    await expect(result.current.toggle(false)).rejects.toThrow();
  });
  expect(result.current.settings?.memoryDreamingEnabled).toBe(true);
  expect(result.current.busy).toBe(false);
});

test('memory cards expose a feature switch while skill cleanup cards show status without a switch', () => {
  const store = configureStore({ reducer: { agent: () => ({ agents: [] }) } });
  const job = withMemoryDreamingCard([], enabled)[0];
  const onToggle = vi.fn();
  const props = {
    onToggle,
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onTrigger: vi.fn(),
    onHistory: vi.fn(),
    onDetails: vi.fn(),
  };
  const { rerender } = render(
    <Provider store={store}>
      <CronJobCard job={job} memoryToggleDisabled={false} {...props} />
    </Provider>,
  );
  fireEvent.click(screen.getByRole('switch'));
  expect(onToggle).toHaveBeenCalledWith(false);
  expect(screen.queryByRole('button')).toBeNull();
  rerender(
    <Provider store={store}>
      <CronJobCard
        job={{ ...job, id: 'skill-review', payload: { kind: 'skillCollectionReview' } }}
        {...props}
      />
    </Provider>,
  );
  expect(screen.queryByRole('switch')).toBeNull();
});

test('reports a suppressed simultaneous toggle without sending a second mutation', async () => {
  let finishUpdate!: (value: { success: boolean }) => void;
  const updateSystemSettings = vi.fn().mockImplementation(
    () =>
      new Promise(resolve => {
        finishUpdate = resolve;
      }),
  );
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      scheduledTasks: {
        getSystemSettings: vi.fn().mockResolvedValue({ success: true, settings: enabled }),
        updateSystemSettings,
      },
    },
  });
  const { result } = renderHook(() => useMemoryDreamingControl(emptyTasks));
  await waitFor(() => expect(result.current.settings).toEqual(enabled));
  await act(async () => {
    const first = result.current.toggleSkills(false);
    expect(await result.current.toggle(false)).toBe(false);
    expect(updateSystemSettings).toHaveBeenCalledOnce();
    finishUpdate({ success: true });
    expect(await first).toBe(true);
  });
  expect(result.current.settings).toMatchObject({ skillMode: 'off', memoryDreamingEnabled: true });
});

test('an older config read cannot overwrite a successfully saved feature setting', async () => {
  let finishRead!: (value: { success: boolean; settings: typeof enabled }) => void;
  const getSystemSettings = vi
    .fn()
    .mockResolvedValueOnce({ success: true, settings: enabled })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishRead = resolve;
        }),
    );
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      scheduledTasks: {
        getSystemSettings,
        updateSystemSettings: vi.fn().mockResolvedValue({ success: true }),
      },
    },
  });
  const { result, rerender } = renderHook(({ tasks }) => useMemoryDreamingControl(tasks), {
    initialProps: { tasks: emptyTasks },
  });
  await waitFor(() => expect(result.current.settings).toEqual(enabled));
  rerender({ tasks: [...emptyTasks] });
  await waitFor(() => expect(getSystemSettings).toHaveBeenCalledTimes(2));
  await act(async () => {
    expect(await result.current.toggleSkills(false)).toBe(true);
    finishRead({ success: true, settings: enabled });
  });
  expect(result.current.settings?.skillMode).toBe('off');
});

test('keeps a paused native job paused while the feature switch remains enabled', () => {
  const job = {
    ...withMemoryDreamingCard([], enabled)[0],
    id: 'native-memory-job',
    enabled: false,
  };
  expect(withMemoryDreamingCard([job], enabled)[0].enabled).toBe(false);
  const onToggle = vi.fn();
  const store = configureStore({ reducer: { agent: () => ({ agents: [] }) } });
  render(
    <Provider store={store}>
      <CronJobCard
        job={job}
        memoryFeatureEnabled
        memoryToggleDisabled={false}
        onToggle={onToggle}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onTrigger={vi.fn()}
        onHistory={vi.fn()}
        onDetails={vi.fn()}
      />
    </Provider>,
  );
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText(i18nService.t('cronMemoryJobPaused'))).toBeTruthy();
  expect(screen.getByRole('switch', { name: i18nService.t('cronMemoryFeatureOn') })).toBeTruthy();
  fireEvent.click(screen.getByRole('switch'));
  expect(onToggle).toHaveBeenCalledWith(false);
});
