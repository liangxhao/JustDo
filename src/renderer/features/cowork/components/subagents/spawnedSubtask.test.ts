import type { CoworkSubagentDetailTask } from '@shared/cowork/subagentDetails';
import { expect, test, vi } from 'vitest';

import { loadSpawnedSubtask } from './spawnedSubtask';

const child: CoworkSubagentDetailTask = {
  id: 'native-task-id', taskName: 'review', sessionKey: 'agent:main:subagent:child',
  label: 'Review', labelSource: 'label', status: 'done',
};

test('resolves the full native task from the parent list before opening details', async () => {
  const load = vi.fn().mockResolvedValue({ success: true, subagents: [
    { ...child, id: 'other', sessionKey: 'other-child' }, child,
  ] });
  expect(await loadSpawnedSubtask(load, 'parent-id', child.sessionKey)).toBe(child);
  expect(load).toHaveBeenCalledWith('parent-id', true);
});

test('does not substitute another agent when the target is missing or loading fails', async () => {
  for (const result of [{ success: true, subagents: [child] }, { success: false, subagents: [child] }]) {
    expect(await loadSpawnedSubtask(vi.fn().mockResolvedValue(result), 'parent', 'missing')).toBeNull();
  }
});
