// @vitest-environment jsdom
import type { ScheduledTask } from '@shared/scheduledTask/types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { CreateEditDialog } from './CronView';

vi.mock('@/features/scheduled-tasks/scheduledTaskService', () => ({
  scheduledTaskService: { listChannels: vi.fn().mockResolvedValue([]) },
}));
afterEach(cleanup);

const models = [
  { id: 'shared', name: 'First', providerKey: 'openai' },
  { id: 'shared', name: 'Second', providerKey: 'anthropic' },
  { id: 'plan', name: 'Plan', isServerModel: true },
  { id: 'blocked', name: 'Blocked', providerKey: 'openai', available: false },
];
const job = {
  id: 'task',
  name: 'Report',
  enabled: true,
  schedule: { kind: 'every', everyMs: 60000 },
  sessionTarget: 'isolated',
  wakeMode: 'now',
  payload: {
    kind: 'agentTurn',
    message: 'Summarize updates',
    model: 'external/legacy',
    thinking: 'high',
  },
  delivery: { mode: 'none' },
  state: {},
} as ScheduledTask;
const modelSelect = () =>
  screen.getByLabelText(i18nService.t('cronDialogModelTitle')) as HTMLSelectElement;
const save = () => fireEvent.click(screen.getByText(i18nService.t('cronDialogSaveChanges')));

test('creates a task with its own provider-qualified model and defaults to inheritance', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<CreateEditDialog open models={models} onSave={onSave} onClose={() => {}} />);
  expect(modelSelect().value).toBe('');
  expect(Array.from(modelSelect().options, option => option.value)).toEqual([
    '',
    'openai/shared',
    'anthropic/shared',
    'justdo/plan',
    'openai/blocked',
  ]);
  expect((screen.getByRole('option', { name: /Blocked/ }) as HTMLOptionElement).disabled).toBe(
    true,
  );
  fireEvent.change(screen.getByPlaceholderText(i18nService.t('cronDialogTaskNamePlaceholder')), {
    target: { value: 'Report' },
  });
  fireEvent.change(screen.getByPlaceholderText(i18nService.t('cronDialogMessagePlaceholder')), {
    target: { value: 'Summarize' },
  });
  fireEvent.change(modelSelect(), { target: { value: 'anthropic/shared' } });
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('cronDialogCreateTitle') }));
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave.mock.calls[0][0].payload.model).toBe('anthropic/shared');
});

test('preserves a model outside the catalog, clears it explicitly, and resets on reopening', async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const props = { models, onSave, onClose: () => {} };
  const { rerender } = render(<CreateEditDialog {...props} open job={job} />);
  expect(modelSelect().value).toBe('external/legacy');
  save();
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  expect(onSave.mock.calls[0][0].payload).toMatchObject({
    model: 'external/legacy',
    thinking: 'high',
  });
  await waitFor(() =>
    expect(
      (screen.getByText(i18nService.t('cronDialogSaveChanges')) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.change(modelSelect(), { target: { value: '' } });
  save();
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  expect(onSave.mock.calls[1][0].payload).toMatchObject({ model: '', thinking: 'high' });
  rerender(<CreateEditDialog {...props} open={false} job={job} />);
  rerender(<CreateEditDialog {...props} open job={job} />);
  expect(modelSelect().value).toBe('external/legacy');
});

test('system events do not offer a task model override', () => {
  render(
    <CreateEditDialog
      open
      job={{ ...job, sessionTarget: 'main', payload: { kind: 'systemEvent', text: 'Wake up' } }}
      models={models}
      onSave={vi.fn()}
      onClose={() => {}}
    />,
  );
  expect(screen.queryByLabelText(i18nService.t('cronDialogModelTitle'))).toBeNull();
});
