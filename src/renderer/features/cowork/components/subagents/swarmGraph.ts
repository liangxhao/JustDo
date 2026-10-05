import type { SwarmGroup } from '@shared/cowork/swarm';

import type { Subtask } from './subtaskPresentation';

export const SWARM_COLUMNS = 3;
export const SWARM_COLLAPSE_AFTER = 9;
export function swarmMembers(group: SwarmGroup, tasks: readonly Subtask[]) {
  const byKey = new Map(tasks.map(task => [task.sessionKey, task]));
  // Native membership is authoritative; ordinary subagents are never inferred to be collectors.
  return group.children.map(child => ({ ...child, task: byKey.get(child.sessionKey) }));
}
export const swarmTotal = (group: SwarmGroup) =>
  group.queued + group.running + group.done + group.failed;
export function layoutSwarmMembers(keys: readonly string[], columns = SWARM_COLUMNS) {
  return keys.map((key, index) => ({
    key,
    x: 30 + (index % columns) * 180,
    y: 200 + Math.floor(index / columns) * 116,
  }));
}
