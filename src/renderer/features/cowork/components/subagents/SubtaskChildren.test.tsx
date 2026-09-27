// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SubtaskChildren from './SubtaskChildren';
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

it('loads one native level on demand, preserves pages after errors, and blocks ancestry cycles', async () => {
  i18nService.setLanguage('en', { persist: false });
  const child = {
    ...task,
    id: 'task-2',
    label: 'Two',
    parentTaskId: task.id,
    execution: { state: 'waiting', wait: { kind: 'approval' } },
  };
  const list = vi
    .fn()
    .mockResolvedValueOnce({
      success: true,
      subagents: [task, child, { ...task, id: 'ancestor' }],
      nextCursor: 'page2',
    })
    .mockResolvedValueOnce({ success: false, error: 'offline' })
    .mockResolvedValueOnce({
      success: true,
      subagents: [child, { ...task, id: 'task-3', label: 'Three' }],
      nextCursor: 'page2',
    });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { listSubTaskChildren: list } },
  });
  const open = vi.fn();
  render(<SubtaskChildren sessionId="root" task={task} ancestors={['ancestor']} onOpen={open} />);
  expect(list).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'View child tasks' }));
  const row = await screen.findByRole('button', { name: 'Two Waiting for approval' });
  expect(screen.queryByText('One')).toBeNull();
  fireEvent.click(row);
  expect(open).toHaveBeenCalledWith(child);
  fireEvent.click(screen.getByRole('button', { name: 'Load more child tasks' }));
  await screen.findByRole('alert');
  expect(screen.getByText('Two')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('sessionDetailsRetry') }));
  await screen.findByText('Three');
  expect(screen.getAllByText('Two')).toHaveLength(1);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Load more child tasks' })).toBeNull(),
  );
  expect(list).toHaveBeenLastCalledWith('root', 'task-1', 'page2');
});

it('retries a failed refresh from the first page and replaces obsolete children', async () => {
  i18nService.setLanguage('en', { persist: false });
  const list = vi
    .fn()
    .mockResolvedValueOnce({
      success: true,
      subagents: [{ ...task, id: 'old', label: 'Old' }],
      nextCursor: 'page2',
    })
    .mockResolvedValueOnce({ success: false, error: 'offline' })
    .mockResolvedValueOnce({ success: true, subagents: [{ ...task, id: 'new', label: 'New' }] });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { listSubTaskChildren: list } },
  });
  render(<SubtaskChildren sessionId="root" task={task} ancestors={[]} onOpen={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'View child tasks' }));
  await screen.findByText('Old');
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('subtaskRefresh') }));
  await screen.findByRole('alert');
  expect(screen.getByText('Old')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('sessionDetailsRetry') }));
  await screen.findByText('New');
  expect(screen.queryByText('Old')).toBeNull();
  expect(list).toHaveBeenLastCalledWith('root', task.id, undefined);
  expect(screen.queryByRole('button', { name: 'Load more child tasks' })).toBeNull();
});

it('resets children and ignores an old response when navigating to another task', async () => {
  i18nService.setLanguage('en', { persist: false });
  let resolve!: (value: unknown) => void;
  const list = vi
    .fn()
    .mockReturnValueOnce(
      new Promise(r => {
        resolve = r;
      }),
    )
    .mockResolvedValueOnce({
      success: true,
      subagents: [{ ...task, id: 'new-child', label: 'New child' }],
    });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { listSubTaskChildren: list } },
  });
  const view = render(
    <SubtaskChildren sessionId="root" task={task} ancestors={[]} onOpen={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'View child tasks' }));
  view.rerender(
    <SubtaskChildren
      sessionId="root"
      task={{ ...task, id: 'other' }}
      ancestors={[]}
      onOpen={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'View child tasks' }));
  await screen.findByText('New child');
  resolve({ success: true, subagents: [{ ...task, id: 'old-child', label: 'Old child' }] });
  await waitFor(() => expect(screen.queryByText('Old child')).toBeNull());
  expect(list).toHaveBeenLastCalledWith('root', 'other', undefined);
});
