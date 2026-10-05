// @vitest-environment jsdom
import type { SwarmSnapshot } from '@shared/cowork/swarm';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import type { Subtask } from './subtaskPresentation';
import SwarmPanel, { SwarmGraph } from './SwarmPanel';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const snapshot: SwarmSnapshot = {
  groups: [
    {
      groupId: 'group',
      createdAt: 10,
      queued: 0,
      running: 1,
      done: 1,
      failed: 0,
      children: [
        { sessionKey: 'a', status: 'running' },
        { sessionKey: 'deleted', status: 'done' },
      ],
    },
  ],
  otherActiveGroups: 0,
};
const tasks: Subtask[] = [
  {
    id: 'a',
    taskName: 'a',
    sessionKey: 'a',
    label: 'Security review',
    labelSource: 'label',
    status: 'running',
  },
  {
    id: 'other',
    taskName: 'other',
    sessionKey: 'other',
    label: 'Ordinary subagent',
    labelSource: 'label',
    status: 'running',
  },
];
const setup = () => i18nService.setLanguage('en', { persist: false });
test('waits for native stop confirmation without changing collector states optimistically', async () => {
  setup();
  let finish!: (value: boolean) => void;
  const stop = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        finish = resolve;
      }),
  );
  render(
    <SwarmGraph
      snapshot={snapshot}
      tasks={tasks}
      parentRunning
      loading={false}
      stale={false}
      onRefresh={vi.fn()}
      onOpenTask={vi.fn()}
      onStop={stop}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Stop the current conversation run and its subtasks' }),
  );
  expect(screen.getByRole('button', { name: 'Stopping' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Security review: Running' })).toBeTruthy();
  await act(async () => finish(false));
  expect(screen.getByText(/Stop could not be confirmed/)).toBeTruthy();
});
test('pauses polling when the tab is hidden', () => {
  const read = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { getSwarmSnapshot: read } },
  });
  render(
    <SwarmPanel
      sessionId="parent"
      tasks={tasks}
      parentRunning
      active={false}
      onOpenTask={vi.fn()}
    />,
  );
  expect(read).not.toHaveBeenCalled();
});
test('draws only native collector members and opens the existing task detail', () => {
  setup();
  const open = vi.fn();
  render(
    <SwarmGraph
      snapshot={snapshot}
      tasks={tasks}
      parentRunning
      loading={false}
      stale={false}
      onRefresh={vi.fn()}
      onOpenTask={open}
    />,
  );
  expect(screen.queryByText('Ordinary subagent')).toBeNull();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Security review: Running' }), {
    key: 'Enter',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Open native activity' }));
  expect(open).toHaveBeenCalledWith(tasks[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Subtask 2: Done' }));
  expect(screen.getByText(/Session details for this member are unavailable/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Open native activity' })).toBeNull();
});
test('reports incomplete native projection and expands large batches without inventing nodes', () => {
  setup();
  const large = {
    groups: [
      {
        ...snapshot.groups[0],
        done: 99,
        running: 1,
        children: Array.from({ length: 12 }, (_, i) => ({
          sessionKey: String(i),
          status: 'done' as const,
        })),
      },
    ],
    otherActiveGroups: 3,
  };
  render(
    <SwarmGraph
      snapshot={large}
      tasks={[]}
      parentRunning={false}
      loading={false}
      stale={false}
      onRefresh={vi.fn()}
      onOpenTask={vi.fn()}
    />,
  );
  expect(screen.getByText('Showing 9/100 members')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Expand task group' }));
  expect(screen.getByText('Showing 12/100 members')).toBeTruthy();
  expect(screen.getByTitle('3 more active groups not shown')).toBeTruthy();
});
test('keeps the last native snapshot when a later refresh fails', async () => {
  setup();
  const read = vi
    .fn()
    .mockResolvedValueOnce({ success: true, snapshot })
    .mockResolvedValue({ success: false });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { getSwarmSnapshot: read } },
  });
  render(
    <SwarmPanel sessionId="parent" tasks={tasks} parentRunning={false} onOpenTask={vi.fn()} />,
  );
  await screen.findByRole('button', { name: 'Security review: Running' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await screen.findByText(/Latest status unavailable/);
  expect(screen.getByRole('button', { name: 'Security review: Running' })).toBeTruthy();
});
test('ignores a response after the panel is disposed and reads the new session independently', async () => {
  setup();
  let resolve!: (value: unknown) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ success: true, snapshot: { groups: [], otherActiveGroups: 0 } });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { getSwarmSnapshot: read } },
  });
  const view = render(
    <SwarmPanel
      key="old"
      sessionId="old"
      tasks={tasks}
      parentRunning={false}
      onOpenTask={vi.fn()}
    />,
  );
  view.rerender(
    <SwarmPanel key="new" sessionId="new" tasks={[]} parentRunning={false} onOpenTask={vi.fn()} />,
  );
  await waitFor(() => expect(read).toHaveBeenCalledWith('new'));
  await act(async () => resolve({ success: true, snapshot }));
  expect(screen.queryByRole('button', { name: 'Security review: Running' })).toBeNull();
});
