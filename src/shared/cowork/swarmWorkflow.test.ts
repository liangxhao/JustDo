import { expect, test } from 'vitest';

import { type SwarmWorkflowView, validFlowList } from './swarmWorkflow';

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
