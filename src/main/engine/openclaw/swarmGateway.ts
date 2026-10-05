import type { SwarmGroup, SwarmSnapshot } from '../../../shared/cowork/swarm';
import type { GatewayRequestClient } from './subagentGateway';

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// Read only the native selected-parent projection; never query transcript files or invent edges.
export function parseSwarmSnapshot(value: unknown): SwarmSnapshot {
  if (value === undefined) return { groups: [], otherActiveGroups: 0 };
  if (
    !record(value) ||
    !Array.isArray(value.groups) ||
    value.groups.length > 5 ||
    !count(value.otherActiveGroups)
  )
    throw new Error('Invalid native Swarm projection');
  const groups: SwarmGroup[] = value.groups.map(group => {
    if (
      !record(group) ||
      typeof group.groupId !== 'string' ||
      !group.groupId ||
      !count(group.createdAt) ||
      !count(group.queued) ||
      !count(group.running) ||
      !count(group.done) ||
      !count(group.failed) ||
      !Array.isArray(group.children) ||
      group.children.length > 64
    )
      throw new Error('Invalid native Swarm group');
    const children = group.children.map(child => {
      if (
        !record(child) ||
        typeof child.sessionKey !== 'string' ||
        !child.sessionKey ||
        !['queued', 'running', 'done', 'failed'].includes(String(child.status))
      )
        throw new Error('Invalid native Swarm member');
      return {
        sessionKey: child.sessionKey,
        status: child.status as SwarmGroup['children'][number]['status'],
      };
    });
    return {
      groupId: group.groupId,
      createdAt: group.createdAt,
      queued: group.queued,
      running: group.running,
      done: group.done,
      failed: group.failed,
      children,
    };
  });
  return { groups, otherActiveGroups: value.otherActiveGroups };
}

export async function readSwarmSnapshot(
  client: GatewayRequestClient,
  keys: string[],
): Promise<SwarmSnapshot> {
  if (!keys.length) throw new Error('Missing native session');
  const groups = new Map<string, SwarmGroup>();
  let otherActiveGroups = 0;
  for (const key of new Set(keys)) {
    const result = await client.request<{ session?: Record<string, unknown> }>(
      'sessions.describe',
      { key },
    );
    if (!result.session) throw new Error('Native session unavailable');
    const snapshot = parseSwarmSnapshot(result.session.swarm);
    for (const group of snapshot.groups) groups.set(group.groupId, group);
    otherActiveGroups += snapshot.otherActiveGroups;
  }
  return {
    groups: [...groups.values()].sort((a, b) => b.createdAt - a.createdAt),
    otherActiveGroups,
  };
}
