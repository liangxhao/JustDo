import { setWorkflowTestPorts } from '../../tests/browserRuntime';
// @vitest-environment jsdom
import type {
  SwarmWorkflowBatchPage,
  SwarmWorkflowChangedEvent,
  SwarmWorkflowNode,
  SwarmWorkflowView,
} from '../contracts/index';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '../../tests/browserRuntime';
vi.mock('./SwarmWorkflowDetailPanel', () => ({
  default: ({
    node,
    onBack,
    revision,
  }: {
    node: SwarmWorkflowNode;
    onBack(): void;
    revision?: number;
  }) => (
    <div data-testid="item-detail" data-revision={revision}>
      {node.id}
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
import SwarmWorkflowBatchPanel from './SwarmWorkflowBatchPanel';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const counts = {
  total: 100,
  done: 42,
  failed: 3,
  running: 5,
  preparing: 0,
  uncertain: 0,
  cancelled: 0,
  queued: 50,
};
const stage: SwarmWorkflowNode = {
  id: 'batch',
  title: 'Process data',
  kind: 'batch',
  status: 'running',
  deps: ['plan'],
  sessionKey: '',
  batchCounts: counts,
};
const flow = {
  id: 'flow',
  revision: 7,
  createdAt: 1,
  goal: 'Process 100 files',
  status: 'running',
  nodes: [stage],
} as SwarmWorkflowView;
let notifyReset: (event: SwarmWorkflowChangedEvent) => void = () => {};
function fixture() {
  i18nService.setLanguage('en', { persist: false });
  const page: SwarmWorkflowBatchPage = {
    flowId: flow.id,
    stageId: stage.id,
    manifestVersion: 'v1',
    revision: 7,
    counts,
    matched: 100,
    retryable: 3,
    items: [{ id: 'item-1', title: 'Data 001', status: 'failed', agentName: 'Main', attempt: 1 }],
    cursor: 'first-cursor',
  };
  const read = vi.fn().mockResolvedValue({ success: true, page });
  const retry = vi.fn().mockResolvedValue({ success: true, retried: 1, skipped: 0 });
  setWorkflowTestPorts({
    getSwarmWorkflowBatch: read,
    retrySwarmWorkflowBatch: retry,
    onSwarmWorkflowsChanged: (listener: typeof notifyReset) => {
      notifyReset = listener;
      return () => {
        notifyReset = () => {};
      };
    },
  });
  const props = {
    sessionId: 'product',
    flow,
    stage,
    active: true,
    onBack: vi.fn(),
    onChanged: vi.fn(),
  };
  return { read, retry, page, props };
}
test('invalidates the old cursor immediately when search changes', async () => {
  const f = fixture();
  render(<SwarmWorkflowBatchPanel {...f.props} />);
  await screen.findByText('Data 001');
  const next = screen.getByLabelText(i18nService.t('swarmWorkflowBatchNext'));
  expect((next as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText(i18nService.t('swarmWorkflowBatchSearch')), {
    target: { value: 'invoice' },
  });
  expect((next as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(next);
  await waitFor(() =>
    expect(f.read).toHaveBeenLastCalledWith('product', 'flow', 'batch', {
      search: 'invoice',
      status: undefined,
      cursor: undefined,
    }),
  );
  expect(f.read.mock.calls.some(call => call[3].search === 'invoice' && call[3].cursor)).toBe(
    false,
  );
});
test('pauses batch polling while an item detail hides the list', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const view = render(<SwarmWorkflowBatchPanel {...f.props} />);
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(f.read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Data 001'));
  view.rerender(<SwarmWorkflowBatchPanel {...f.props} flow={{ ...flow, revision: 8 }} />);
  expect(screen.getByTestId('item-detail').getAttribute('data-revision')).toBe('8');
  await act(async () => vi.advanceTimersByTimeAsync(9_000));
  expect(f.read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Back'));
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(f.read).toHaveBeenCalledTimes(2);
});

test('serializes flow changes during a batch read and discards the invalidated page', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const view = render(<SwarmWorkflowBatchPanel {...f.props} />);
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(f.read).toHaveBeenCalledTimes(1);
  f.read.mockResolvedValue({
    success: true,
    page: { ...f.page, revision: 8, items: [{ ...f.page.items[0], title: 'Updated item' }] },
  });
  view.rerender(<SwarmWorkflowBatchPanel {...f.props} flow={{ ...flow, revision: 8 }} />);
  expect(f.read).toHaveBeenCalledTimes(1);
  await act(async () => finish({ success: true, page: f.page }));
  expect(screen.queryByText('Data 001')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Updated item')).toBeTruthy();
});
test('retains the list query while visiting an item and sends only selected retries', async () => {
  const f = fixture();
  render(<SwarmWorkflowBatchPanel {...f.props} />);
  await screen.findByText('Data 001');
  fireEvent.click(screen.getByText('Data 001'));
  expect(screen.getByTestId('item-detail').textContent).toContain('item-1');
  fireEvent.click(screen.getByText('Back'));
  expect(screen.getByLabelText(i18nService.t('swarmWorkflowBatchSearch'))).toBeTruthy();
  fireEvent.click(screen.getByLabelText(i18nService.t('swarmWorkflowBatchSelect') + ' Data 001'));
  fireEvent.click(screen.getByText(i18nService.t('swarmWorkflowBatchRetrySelected') + ' (1)'));
  await waitFor(() =>
    expect(f.retry).toHaveBeenCalledWith('product', 'flow', 'batch', 7, expect.any(String), [
      'item-1',
    ]),
  );
});

test('refreshes a static failed batch revision before retrying after a main-chat update', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const failedStage = { ...stage, status: 'failed' as const };
  const blockedFlow = { ...flow, status: 'blocked' as const };
  const view = render(
    <SwarmWorkflowBatchPanel {...f.props} stage={failedStage} flow={blockedFlow} />,
  );
  await act(async () => vi.advanceTimersByTimeAsync(200));
  await act(async () => vi.advanceTimersByTimeAsync(6_000));
  expect(f.read).toHaveBeenCalledTimes(1);
  f.read.mockResolvedValue({ success: true, page: { ...f.page, revision: 8 } });
  view.rerender(
    <SwarmWorkflowBatchPanel
      {...f.props}
      stage={failedStage}
      flow={{ ...blockedFlow, revision: 8 }}
    />,
  );
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(f.read).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByText(i18nService.t('swarmWorkflowBatchRetryFailed')));
  await act(async () => {});
  expect(f.retry).toHaveBeenCalledWith(
    'product',
    'flow',
    'batch',
    8,
    expect.any(String),
    undefined,
  );
});
test('shows the actual failure when a batch could not freeze its input', () => {
  const f = fixture();
  render(
    <SwarmWorkflowBatchPanel
      {...f.props}
      stage={{
        ...stage,
        status: 'failed',
        batchCounts: undefined,
        error: 'Input directory is missing.',
      }}
    />,
  );
  expect(screen.getByText('Input directory is missing.')).toBeTruthy();
  expect(f.read).not.toHaveBeenCalled();
});

test('recovers a static batch page after reconnect without requiring a changed flow revision', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.read.mockRejectedValueOnce(new Error('Disconnected'));
  render(<SwarmWorkflowBatchPanel {...f.props} stage={{ ...stage, status: 'failed' }} />);
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(f.read).toHaveBeenCalledTimes(1);
  act(() => notifyReset({}));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Data 001')).toBeTruthy();
});
