import { expect, test } from 'vitest';

import { isSwarmWorkflowActive, type SwarmWorkflowView, validFlowList } from './index';

const flow: SwarmWorkflowView = {
  id: 'flow',
  revision: 1,
  goal: 'Inspect project',
  createdAt: 1,
  status: 'running',
  nodes: [],
};
const actions = { pause: true, resume: false, stop: true, retry: false };

test('accepts an optional complete boolean action mapping', () => {
  expect(validFlowList({ flows: [flow] })).toBe(true);
  expect(validFlowList({ flows: [{ ...flow, actions }] })).toBe(true);
});

test('accepts only a boolean all-history activity summary when present', () => {
  expect(validFlowList({ flows: [], running: true })).toBe(true);
  expect(validFlowList({ flows: [flow], running: false })).toBe(true);
  for (const running of [undefined, null, 0, 1, 'true', [], {}]) {
    expect(validFlowList({ flows: [flow], running })).toBe(false);
  }
});

test.each(['paused', 'blocked'] as const)(
  'counts unsettled workers in %s flows, including batch stage counts',
  status => {
    const paused = { ...flow, status };
    expect(isSwarmWorkflowActive(paused)).toBe(false);
    for (const nodeStatus of ['preparing', 'running', 'uncertain'] as const) {
      expect(isSwarmWorkflowActive({ ...paused, nodes: [{ status: nodeStatus }] })).toBe(true);
      expect(
        isSwarmWorkflowActive({
          ...paused,
          nodes: [{
            status: 'queued',
            batchCounts: {
              total: 1, queued: 0, preparing: 0, running: 0, uncertain: 0,
              done: 0, failed: 0, cancelled: 0, [nodeStatus]: 1,
            },
          }],
        }),
      ).toBe(true);
    }
  },
);

test.each(['completed', 'cancelled'] as const)(
  'does not treat stale node counts in %s history as current execution',
  status => {
    expect(isSwarmWorkflowActive({ ...flow, status, nodes: [{ status: 'running' }] })).toBe(false);
  },
);

test.each([
  null,
  'running',
  [true, false, true, false],
  {},
  { pause: true, resume: false, stop: true },
  { ...actions, retry: 'yes' },
  { ...actions, pause: undefined },
])('rejects malformed action availability in the Gateway view: %j', value => {
  expect(validFlowList({ flows: [{ ...flow, actions: value }] })).toBe(false);
});
