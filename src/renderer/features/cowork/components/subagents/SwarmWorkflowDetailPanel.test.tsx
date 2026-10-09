// @vitest-environment jsdom
import type { SwarmWorkflowNode } from '@shared/cowork/swarmWorkflow';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
afterEach(cleanup);
const node: SwarmWorkflowNode = {
  id: 'work',
  title: 'Work',
  kind: 'work',
  status: 'done',
  deps: ['plan'],
  sessionKey: 'untrusted-renderer-key',
};
const source = { ...node, id: 'plan', result: 'newer result that was never sent' };
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
    value: { cowork: { getSwarmWorkflowDetail: read } },
  });
  return read;
}
const props = { sessionId: 'product', flowId: 'flow', node, active: true, onBack: () => {} };
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
test('uses the authorized native session and closes history when inactive', async () => {
  fixture();
  const view = render(<SwarmWorkflowDetailPanel {...props} />);
  await screen.findByText('history:authorized-native');
  view.rerender(<SwarmWorkflowDetailPanel {...props} active={false} />);
  expect(screen.queryByText('history:authorized-native')).toBeNull();
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
