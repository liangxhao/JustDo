// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SubtaskControls from './SubtaskControls';
import type { Subtask } from './subtaskPresentation';

afterEach(cleanup);
const task: Subtask = {
  id: 'task-1',
  taskName: 'one',
  label: 'One',
  labelSource: 'label',
  sessionKey: 'child-session',
  status: 'running',
};
const install = (controlSubTask = vi.fn(), getSubTaskDetails = vi.fn()) => {
  i18nService.setLanguage('en', { persist: false });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { controlSubTask, getSubTaskDetails } },
  });
};

describe('SubtaskControls', () => {
  it('cancels a running child by exact session identity and prevents duplicate submission', async () => {
    let resolve!: (value: { success: true }) => void;
    const control = vi.fn().mockReturnValue(
      new Promise(r => {
        resolve = r;
      }),
    );
    install(control);
    const refresh = vi.fn();
    render(<SubtaskControls sessionId="parent" task={task} onRefresh={refresh} />);
    const button = screen.getByRole('button', { name: 'Cancel this task' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(control).toHaveBeenCalledExactlyOnceWith('parent', 'task-1', 'cancel');
    resolve({ success: true });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Verify state' })).toBeTruthy();
  });

  it('keeps uncertain operations blocked until an authoritative task is verified', async () => {
    const control = vi.fn().mockRejectedValue(new Error('disconnected'));
    const details = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'offline' })
      .mockResolvedValueOnce({ success: true, subagent: { ...task, status: 'done' } });
    install(control, details);
    const refresh = vi.fn();
    render(<SubtaskControls sessionId="parent" task={task} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this task' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify state' }));
    await waitFor(() => expect(details).toHaveBeenCalledOnce());
    expect(refresh).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Cancel this task' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Verify state' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Verify state' }));
    await waitFor(() =>
      expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' })),
    );
    expect(control).toHaveBeenCalledOnce();
  });

  it('offers cancellation only for active tasks and communicates native duplicate risk', async () => {
    const control = vi.fn().mockResolvedValue({ success: true, duplicateRisk: true });
    install(control);
    const view = render(
      <SubtaskControls
        sessionId="parent"
        task={{ ...task, status: 'running' }}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Deliver result again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this task' }));
    await screen.findByText(i18nService.t('subtaskControlDuplicateRisk'));
    expect(control).toHaveBeenCalledWith('parent', 'task-1', 'cancel');
    view.unmount();
    render(
      <SubtaskControls sessionId="parent" task={{ ...task, status: 'done' }} onRefresh={vi.fn()} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

it('ignores completed mutations for a task that is no longer selected', async () => {
  let resolve!: (value: unknown) => void;
  const control = vi.fn().mockReturnValue(
    new Promise(r => {
      resolve = r;
    }),
  );
  install(control);
  const refresh = vi.fn();
  const view = render(<SubtaskControls sessionId="parent" task={task} onRefresh={refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel this task' }));
  view.rerender(
    <SubtaskControls
      sessionId="parent"
      task={{ ...task, id: 'other', status: 'running' }}
      onRefresh={refresh}
    />,
  );
  resolve({ success: true });
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Cancel this task' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Verify state' })).toBeNull();
});

it('uses the verified state even before the parent applies the refreshed task', async () => {
  install(
    vi.fn().mockRejectedValue(new Error('offline')),
    vi.fn().mockResolvedValue({ success: true, subagent: { ...task, status: 'done' } }),
  );
  render(<SubtaskControls sessionId="parent" task={task} onRefresh={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel this task' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Verify state' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Cancel this task' })).toBeNull(),
  );
});

it('rejects verification for a different native session', async () => {
  install(
    vi.fn().mockRejectedValue(new Error('offline')),
    vi
      .fn()
      .mockResolvedValue({ success: true, subagent: { ...task, sessionKey: 'wrong-session' } }),
  );
  const refresh = vi.fn();
  render(<SubtaskControls sessionId="parent" task={task} onRefresh={refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel this task' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Verify state' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Verify state' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(refresh).not.toHaveBeenCalled();
  expect(
    (screen.getByRole('button', { name: 'Cancel this task' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
