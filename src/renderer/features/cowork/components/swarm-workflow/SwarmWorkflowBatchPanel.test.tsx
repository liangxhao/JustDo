// @vitest-environment jsdom
import type { SwarmWorkflowBatchPage, SwarmWorkflowNode, SwarmWorkflowView } from '@shared/cowork/swarmWorkflow';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';
vi.mock('./SwarmWorkflowDetailPanel', () => ({
  default: ({ node, onBack }: { node: SwarmWorkflowNode; onBack(): void }) => (
    <div data-testid="item-detail">
      {node.id}
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));
import SwarmWorkflowBatchPanel from './SwarmWorkflowBatchPanel';
afterEach(cleanup);
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
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { getSwarmWorkflowBatch: read, retrySwarmWorkflowBatch: retry } },
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
