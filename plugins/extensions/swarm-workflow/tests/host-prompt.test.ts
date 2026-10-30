import { expect, test } from 'vitest';

import { buildSwarmWorkflowInstruction } from '../app/contracts';

test('encodes the independent flow mode without delegating native collector control', () => {
  expect(buildSwarmWorkflowInstruction({ mode: 'review', verify: true }))
    .toBe('<swarm-workflow mode="review"/>');
  expect(buildSwarmWorkflowInstruction({ mode: 'research', verify: false }))
    .toBe('<swarm-workflow mode="research"/>');
});
