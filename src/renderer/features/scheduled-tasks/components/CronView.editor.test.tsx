// @vitest-environment jsdom
import type { ScheduledTask } from '@shared/scheduledTask/types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { CreateEditDialog } from './CronView';

vi.mock('@/features/scheduled-tasks/scheduledTaskService', () => ({
  scheduledTaskService: { listChannels: vi.fn().mockResolvedValue([]) },
}));

const originalLanguage = i18nService.getLanguage();
beforeEach(() => i18nService.setLanguage('en', { persist: false }));
afterEach(() => {
  cleanup();
  i18nService.setLanguage(originalLanguage, { persist: false });
});
const t = (key: string) => i18nService.t(key);
const job: ScheduledTask = {
  id: 'report',
  name: 'Report',
  description: '',
  enabled: true,
  schedule: { kind: 'cron', expr: '0 9 * 12 *', tz: 'America/New_York', staggerMs: 57 },
  sessionTarget: 'isolated',
  wakeMode: 'now',
  payload: { kind: 'agentTurn', message: 'Prepare the report', thinking: 'unknown-native-level' },
  delivery: { mode: 'none' },
  agentId: 'main',
  sessionKey: null,
  management: 'editable',
  state: {
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastStatus: null,
    lastError: null,
    lastDurationMs: null,
    runningAtMs: null,
    consecutiveErrors: 0,
  },
  createdAt: '',
  updatedAt: '',
};

function save() {
  fireEvent.click(screen.getByRole('button', { name: t('cronDialogSaveChanges') }));
}

test.each([
  { kind: 'cron' as const, expr: '0 9 * 12 *', tz: 'America/New_York', staggerMs: 57 },
  { kind: 'cron' as const, expr: '0 * * * 1' },
  { kind: 'at' as const, at: '2020-01-01T01:00:45.123Z' },
])(
  'editing only the name leaves native schedule and unexposed overrides untouched: $kind',
  async schedule => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CreateEditDialog open job={{ ...job, schedule }} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(t('cronDialogTaskNamePlaceholder')), {
      target: { value: 'Renamed report' },
    });
    save();
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('schedule');
    expect(onSave.mock.calls[0][0].payload).not.toHaveProperty('thinking');
  },
);

test('advanced options stay folded and new tasks keep native defaults', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<CreateEditDialog open onSave={onSave} onClose={() => {}} />);
  expect(screen.getByText(t('cronAdvancedSettingsTitle')).closest('details')?.open).toBe(false);
  expect(screen.queryByLabelText('Thinking level')).toBeNull();
  expect(screen.queryByLabelText('Timezone')).toBeNull();
  fireEvent.change(screen.getByPlaceholderText(t('cronDialogTaskNamePlaceholder')), {
    target: { value: 'Report' },
  });
  fireEvent.change(screen.getByPlaceholderText(t('cronDialogMessagePlaceholder')), {
    target: { value: 'Prepare report' },
  });
  fireEvent.click(screen.getByRole('button', { name: t('cronDialogCreateTitle') }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave.mock.calls[0][0].payload).toEqual({ kind: 'agentTurn', message: 'Prepare report' });
  expect(onSave.mock.calls[0][0]).not.toHaveProperty('deleteAfterRun');
});

test('advanced edits send native reset values without replaying other options', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <CreateEditDialog
      open
      job={{
        ...job,
        payload: {
          ...job.payload,
          kind: 'agentTurn',
          message: 'Report',
          timeoutSeconds: 60,
          fallbacks: ['internal/backup'],
          lightContext: true,
        },
      }}
      onSave={onSave}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByText(t('cronAdvancedSettingsTitle')));
  fireEvent.change(screen.getByLabelText(t('cronAdvancedTimeout')), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText(t('cronAdvancedFallbacks')), {
    target: { value: 'inherit' },
  });
  fireEvent.click(
    screen.getByRole('checkbox', { name: new RegExp(t('cronAdvancedLightContext')) }),
  );
  save();
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave.mock.calls[0][0].payload).toMatchObject({
    timeoutSeconds: null,
    fallbacks: null,
    lightContext: false,
  });
  expect(onSave.mock.calls[0][0].payload).not.toHaveProperty('thinking');
  expect(onSave.mock.calls[0][0]).not.toHaveProperty('schedule');
});

test('one-time task retention uses the existing form without changing the timestamp', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const schedule = { kind: 'at' as const, at: '2030-01-01T01:00:45.123Z' };
  render(
    <CreateEditDialog
      open
      job={{ ...job, schedule, deleteAfterRun: true }}
      onSave={onSave}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByText(t('cronAdvancedSettingsTitle')));
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(t('cronAdvancedKeepOnce')) }));
  save();
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave.mock.calls[0][0]).toMatchObject({ deleteAfterRun: false });
  expect(onSave.mock.calls[0][0]).not.toHaveProperty('schedule');
});

test('an unchanged schedule shows the authoritative next run in its saved timezone', () => {
  render(
    <CreateEditDialog
      open
      job={{ ...job, state: { ...job.state, nextRunAtMs: Date.parse('2030-01-01T14:00:00Z') } }}
      onSave={vi.fn()}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText(/America\/New_York/).textContent).toContain('9:00:00');
  expect(screen.queryByText(t('cronSchedulePreviewHint'))).toBeNull();
});
