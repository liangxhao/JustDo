// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { bindBrowserHost } from './workflowBrowserPorts';
import { createBrowserHost, i18nService, setHistoryRenderer } from '../../tests/browserRuntime';
import SwarmWorkflowNodeHistory from './SwarmWorkflowNodeHistory';

afterEach(cleanup);
const props = {
  sessionKey: 'agent:reviewer:subagent:swarm-workflow-first',
  workingDirectory: '/project',
  agentId: 'reviewer',
  name: 'Reviewer',
};

test('delegates native history to the SDK host with the exact workflow identity and labels', () => {
  const history = vi.fn(input => (
    <div data-testid="native-history">{String(input.sessionKey)}</div>
  ));
  setHistoryRenderer(history);
  render(<SwarmWorkflowNodeHistory {...props} active />);
  expect(screen.getByTestId('native-history').textContent).toBe(props.sessionKey);
  expect(history).toHaveBeenLastCalledWith({
    ...props,
    active: true,
    labels: {
      loading: i18nService.t('swarmWorkflowHistory_loading'),
      empty: i18nService.t('swarmWorkflowHistory_empty'),
      error: i18nService.t('swarmWorkflowHistory_error'),
      retry: i18nService.t('sessionDetailsRetry'),
    },
  });
});

test('forwards active state and changed native identity without creating a plugin history controller', () => {
  const history = vi.fn(() => null);
  setHistoryRenderer(history);
  const view = render(<SwarmWorkflowNodeHistory {...props} active={false} />);
  expect(history).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionKey: props.sessionKey, active: false }),
  );
  const sessionKey = 'agent:reviewer:subagent:swarm-workflow-second';
  view.rerender(<SwarmWorkflowNodeHistory {...props} sessionKey={sessionKey} active />);
  expect(history).toHaveBeenLastCalledWith(expect.objectContaining({ sessionKey, active: true }));
});

test('does not retain a native view after its public browser host is detached', () => {
  const history = vi.fn(() => <div>Host-owned native history</div>);
  setHistoryRenderer(history);
  const release = bindBrowserHost(createBrowserHost(new AbortController().signal));
  const view = render(<SwarmWorkflowNodeHistory {...props} />);
  expect(screen.getByText('Host-owned native history')).toBeTruthy();
  release();
  view.rerender(<SwarmWorkflowNodeHistory {...props} />);
  expect(screen.queryByText('Host-owned native history')).toBeNull();
  expect(history).toHaveBeenCalledTimes(1);
});
