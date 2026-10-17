// @vitest-environment jsdom
import type { SwarmWorkflowChangedEvent,SwarmWorkflowNode } from '@shared/cowork/swarm-workflow';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SwarmWorkflowDetailPanel, { handoffContent } from './SwarmWorkflowDetailPanel';

vi.mock('../chat/ChatMessageDisplay', () => ({
  default: ({ gatewayMessages }: { gatewayMessages: unknown }) => (
    <div>{JSON.stringify(gatewayMessages)}</div>
  ),
}));
vi.mock('./SwarmWorkflowNodeHistory', () => ({
  default: ({ sessionKey }: { sessionKey: string }) => <div>history:{sessionKey}</div>,
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const node: SwarmWorkflowNode = {
  id: 'work',
  title: 'Work',
  kind: 'work',
  status: 'done',
  deps: ['plan'],
  sessionKey: 'untrusted-renderer-key',
};
const source = { ...node, id: 'plan', result: 'newer result that was never sent' };
let notifyReset: (event: SwarmWorkflowChangedEvent) => void = () => {};
function fixture(submission = 'submitted', dispatch?: { message: string; createdAt: number }) {
  i18nService.setLanguage('en', { persist: false });
  const read = vi.fn().mockResolvedValue({
    success: true,
    detail: {
      flowId: 'flow',
      nodeId: 'work',
      sessionKey: 'authorized-native',
      workingDirectory: '/project',
      submission,
      dispatch,
    },
  });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      cowork: {
        getSwarmWorkflowDetail: read,
        onSwarmWorkflowsChanged: (listener: typeof notifyReset) => {
          notifyReset = listener;
          return () => {
            notifyReset = () => {};
          };
        },
      },
    },
  });
  return read;
}
const props = { sessionId: 'product', flowId: 'flow', node, active: true, onBack: () => {} };
test('stops polling when the detail response confirms that a previously running item ended', async () => {
  vi.useFakeTimers();
  const read = fixture();
  read.mockResolvedValue({
    success: true,
    detail: {
      flowId: 'flow',
      nodeId: 'work',
      sessionKey: 'authorized-native',
      workingDirectory: '/project',
      submission: 'submitted',
      status: 'done',
    },
  });
  render(<SwarmWorkflowDetailPanel {...props} node={{ ...node, status: 'running' }} />);
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(read).toHaveBeenCalledTimes(1);
});
test('shows the selected persisted handoff and exposes the full original request', async () => {
  const message = JSON.stringify({
    assignedTask: 'Inspect',
    inputs: [
      { id: 'plan', result: 'original result' },
      { id: 'other', result: 'other result' },
    ],
  });
  const read = fixture('submitted', { message, createdAt: 1 });
  render(<SwarmWorkflowDetailPanel {...props} source={source} />);
  await screen.findByText('Task submitted.');
  expect(read).toHaveBeenCalledWith('product', 'flow', 'work', 'plan');
  expect(screen.queryByText(/newer result/)).toBeNull();
  expect(screen.getByText(message)).toBeTruthy();
  expect(handoffContent(message, 'plan')).toEqual({ result: 'original result', task: 'Inspect' });
  expect(handoffContent(message, 'missing')).toBeUndefined();
});

test('revalidates terminal details on flow changes and follows retries beyond the old item snapshot', async () => {
  vi.useFakeTimers();
  const read = fixture();
  const detail = {
    flowId: 'flow',
    nodeId: 'work',
    sessionKey: 'old-native',
    workingDirectory: '/project',
    submission: 'submitted',
    status: 'failed',
    revision: 1,
  };
  read.mockResolvedValue({ success: true, detail });
  const selected = { ...node, status: 'failed' as const };
  const view = render(<SwarmWorkflowDetailPanel {...props} node={selected} revision={1} />);
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({ success: true, detail: { ...detail, revision: 2 } });
  view.rerender(<SwarmWorkflowDetailPanel {...props} node={selected} revision={2} />);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(read).toHaveBeenCalledTimes(2);
  read.mockResolvedValue({
    success: true,
    detail: {
      ...detail,
      revision: 3,
      status: 'queued',
      sessionKey: 'retry-native',
      submission: 'not_sent',
    },
  });
  view.rerender(<SwarmWorkflowDetailPanel {...props} node={selected} revision={3} />);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(read).toHaveBeenCalledTimes(3);
  read.mockResolvedValue({
    success: true,
    detail: { ...detail, revision: 4, status: 'running', sessionKey: 'retry-native' },
  });
  await act(async () => vi.advanceTimersByTimeAsync(2_500));
  expect(read).toHaveBeenCalledTimes(4);
  expect(screen.getByText('history:retry-native')).toBeTruthy();
  read.mockResolvedValue({
    success: true,
    detail: { ...detail, revision: 5, status: 'done', sessionKey: 'retry-native' },
  });
  await act(async () => vi.advanceTimersByTimeAsync(2_500));
  expect(read).toHaveBeenCalledTimes(5);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(read).toHaveBeenCalledTimes(5);
});
test('uses the authorized native session and closes history when inactive', async () => {
  fixture();
  const view = render(<SwarmWorkflowDetailPanel {...props} />);
  await screen.findByText('history:authorized-native');
  view.rerender(<SwarmWorkflowDetailPanel {...props} active={false} />);
  expect(screen.queryByText('history:authorized-native')).toBeNull();
});

test('coalesces revisions during a slow detail read into one follow-up', async () => {
  vi.useFakeTimers();
  const read = fixture();
  let finish!: (result: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const view = render(<SwarmWorkflowDetailPanel {...props} revision={1} />);
  view.rerender(<SwarmWorkflowDetailPanel {...props} revision={2} />);
  view.rerender(<SwarmWorkflowDetailPanel {...props} revision={3} />);
  view.rerender(<SwarmWorkflowDetailPanel {...props} revision={4} />);
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({
      success: true,
      detail: {
        flowId: 'flow',
        nodeId: 'work',
        sessionKey: 'outdated',
        workingDirectory: '/project',
        submission: 'submitted',
        status: 'done',
      },
    }),
  );
  expect(screen.queryByText('history:outdated')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByText('history:authorized-native')).toBeTruthy();
});

test('recovers a terminal detail read on reconnect even when the flow revision is unchanged', async () => {
  vi.useFakeTimers();
  const read = fixture();
  read.mockRejectedValueOnce(new Error('Disconnected'));
  render(<SwarmWorkflowDetailPanel {...props} revision={1} />);
  await act(async () => {});
  expect(screen.getByRole('alert')).toBeTruthy();
  act(() => notifyReset({}));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('history:authorized-native')).toBeTruthy();
});
test('does not open native history before dispatch and retries failed reads', async () => {
  const read = fixture('not_sent');
  read.mockRejectedValueOnce(new Error('offline'));
  render(<SwarmWorkflowDetailPanel {...props} />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await screen.findByText('Task has not been sent.');
  expect(screen.queryByText(/history:/)).toBeNull();
});
test('does not fabricate missing historical dispatches', async () => {
  fixture();
  render(<SwarmWorkflowDetailPanel {...props} source={source} />);
  await screen.findByText('This historical task has no saved dispatch content.');
  expect(screen.queryByText(/newer result/)).toBeNull();
});
