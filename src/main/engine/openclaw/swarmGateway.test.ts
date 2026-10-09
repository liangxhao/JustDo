import { expect, test, vi } from 'vitest';

import { buildSwarmWorkflowInstruction } from '../../../shared/cowork/swarmWorkflow';
import { parseSwarmSnapshot, readSwarmSnapshot } from './swarmGateway';

const snapshot = {
  groups: [
    {
      groupId: 'g1',
      createdAt: 10,
      queued: 0,
      running: 1,
      done: 70,
      failed: 2,
      children: [{ sessionKey: 'native-child', status: 'running' }],
    },
  ],
  otherActiveGroups: 2,
};
test('preserves authoritative totals when the native member projection is incomplete', () => {
  expect(parseSwarmSnapshot(snapshot)).toEqual(snapshot);
});
test.each([
  null,
  { groups: [] },
  { ...snapshot, otherActiveGroups: -1 },
  {
    ...snapshot,
    groups: [{ ...snapshot.groups[0], children: [{ sessionKey: 'x', status: 'guessed' }] }],
  },
])('rejects malformed native state instead of inventing an empty successful workflow', value => {
  expect(() => parseSwarmSnapshot(value)).toThrow();
});
test('reads only host-resolved native parents and deduplicates aliases', async () => {
  const request = vi.fn().mockResolvedValue({ session: { swarm: snapshot } });
  expect(await readSwarmSnapshot({ request }, ['owned', 'owned'])).toEqual(snapshot);
  expect(request.mock.calls).toEqual([['sessions.describe', { key: 'owned' }]]);
});
test('does not turn a missing native session into successful empty history', async () => {
  const request = vi.fn().mockResolvedValue({});
  await expect(readSwarmSnapshot({ request }, ['owned'])).rejects.toThrow();
});
test('encodes the independent flow mode without delegating native collector control', () => {
  const instruction = buildSwarmWorkflowInstruction({ mode: 'review', verify: true });
  expect(instruction).toBe('<justdo-swarm-workflow mode="review"/>');
  expect(buildSwarmWorkflowInstruction({ mode: 'research', verify: false })).toBe('<justdo-swarm-workflow mode="research"/>');
});
