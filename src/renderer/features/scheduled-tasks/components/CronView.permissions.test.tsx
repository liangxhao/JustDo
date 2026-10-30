// @vitest-environment jsdom
import type { ScheduledTask } from '@shared/scheduledTask/types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { CreateEditDialog } from './CronView';

vi.mock('@/features/scheduled-tasks/scheduledTaskService', () => ({
  scheduledTaskService: { listChannels: vi.fn().mockResolvedValue([]) },
}));
afterEach(cleanup);

const job = {
  id: 'task',
  name: 'Report',
  description: '',
  enabled: true,
  schedule: { kind: 'every', everyMs: 60000 },
  sessionTarget: 'isolated',
  wakeMode: 'now',
  payload: {
    kind: 'agentTurn',
    message: 'Report updates',
    toolsAllow: ['*'],
    permissionMode: 'full',
  },
  delivery: { mode: 'none' },
  state: {},
} as ScheduledTask;

function permissionSelect() {
  return screen.getByLabelText(i18nService.t('cronDialogPermissionTitle')) as HTMLSelectElement;
}

describe('scheduled task permission form', () => {
  test('preserves legacy wildcard permissions until Full is explicitly selected', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateEditDialog
        open
        job={{
          ...job,
          payload: { kind: 'agentTurn', message: 'Report updates', toolsAllow: ['*'] },
        }}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    expect(permissionSelect().value).toBe('custom');
    fireEvent.click(screen.getByText(i18nService.t('cronDialogSaveChanges')));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('permissionMode');
    expect(onSave.mock.calls[0][0].payload).toEqual({
      kind: 'agentTurn',
      message: 'Report updates',
    });

    await waitFor(() =>
      expect(
        (screen.getByText(i18nService.t('cronDialogSaveChanges')) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.change(permissionSelect(), { target: { value: 'full' } });
    fireEvent.click(screen.getByText(i18nService.t('cronDialogSaveChanges')));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0]).toMatchObject({ permissionMode: 'full' });
  });

  test('creates isolated tasks with main by default and offers only existing assistants', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateEditDialog
        open
        agents={[{ id: 'research', name: 'Research', enabled: true }]}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    const assistant = screen.getByLabelText(
      i18nService.t('cronDialogAgentTitle'),
    ) as HTMLSelectElement;
    expect(assistant.value).toBe('main');
    expect(Array.from(assistant.options, option => option.value)).toEqual(['main', 'research']);
    fireEvent.change(screen.getByPlaceholderText(i18nService.t('cronDialogTaskNamePlaceholder')), {
      target: { value: 'Report' },
    });
    fireEvent.change(screen.getByPlaceholderText(i18nService.t('cronDialogMessagePlaceholder')), {
      target: { value: 'Summarize updates' },
    });
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('cronDialogCreateTitle') }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      agentId: 'main',
      sessionTarget: 'isolated',
      permissionMode: 'read-only',
    });
  });

  test('system events show inherited permissions and save without a permission preset', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateEditDialog
        open
        job={{ ...job, sessionTarget: 'main', payload: { kind: 'systemEvent', text: 'Wake up' } }}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    expect(document.querySelector('#scheduled-task-permission')).toBeNull();
    expect(screen.getByText(i18nService.t('cronDialogPermissionInheritedHint'))).toBeTruthy();
    fireEvent.click(screen.getByText(i18nService.t('cronDialogSaveChanges')));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('permissionMode');
  });

  test('saves the selected assistant and clears an existing assistant session binding', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateEditDialog
        open
        job={{ ...job, agentId: 'main', sessionKey: 'agent:main:custom' }}
        agents={[
          { id: 'research', name: 'Research', enabled: true },
          { id: 'disabled', name: 'Disabled', enabled: false },
        ]}
        onSave={onSave}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('option', { name: 'Disabled' })).toBeNull();
    fireEvent.change(screen.getByLabelText(i18nService.t('cronDialogAgentTitle')), {
      target: { value: 'research' },
    });
    fireEvent.click(screen.getByText(i18nService.t('cronDialogSaveChanges')));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toMatchObject({ agentId: 'research', sessionKey: null });
  });

  test('saves an explicit mode change and resets permissions each time the dialog opens', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const props = { onSave, onClose: () => {} };
    const { rerender } = render(<CreateEditDialog {...props} open job={job} />);
    expect(permissionSelect().value).toBe('full');
    fireEvent.change(permissionSelect(), { target: { value: 'read-only' } });
    fireEvent.click(screen.getByText(i18nService.t('cronDialogSaveChanges')));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].permissionMode).toBe('read-only');

    rerender(<CreateEditDialog {...props} open={false} />);
    rerender(<CreateEditDialog {...props} open job={job} />);
    expect(permissionSelect().value).toBe('full');
    rerender(<CreateEditDialog {...props} open={false} />);
    rerender(<CreateEditDialog {...props} open />);
    expect(permissionSelect().value).toBe('read-only');
  });
});
