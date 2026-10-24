import { expect, test, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import { createNativeWorktreeDiscovery } from './nativeWorktreeDiscovery';

test('queues one fresh scan for changes arriving after the first native snapshot', async () => {
  const parent = { id: 'parent', agentId: 'main', nativeSessionKey: 'agent:main:justdo:parent' };
  const child = (id: string) => ({
    key: `agent:main:subagent:${id}`,
    parentSessionKey: parent.nativeSessionKey,
    worktree: { id },
  });
  const known = new Set<string>();
  let finishDescription!: (value: unknown) => void;
  const firstDescription = new Promise(resolve => {
    finishDescription = resolve;
  });
  let scans = 0;
  const requestGateway = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sessions.list') {
      scans += 1;
      return { sessions: scans === 1 ? [child('one')] : [child('one'), child('two')] };
    }
    const key = (params as { key: string }).key;
    if (key.endsWith(':one')) return firstDescription;
    return { session: { worktree: { id: 'two' }, spawnedCwd: 'E:\\repo\\two' } };
  });
  const onSessionsChanged = vi.fn();
  const store = {
    listSessionDirectory: () => [parent],
    getSession: () => parent,
    getSessionByNativeKey: (key: string) => (known.has(key) ? { id: key } : null),
    adoptNativeSession: vi.fn((key: string) => {
      known.add(key);
      return { id: key };
    }),
  };
  const discover = createNativeWorktreeDiscovery({
    getCoworkStore: () => store as unknown as CoworkStore,
    requestGateway: requestGateway as <T>(method: string, params?: unknown) => Promise<T>,
    onSessionsChanged,
  });

  const first = discover();
  await vi.waitFor(() =>
    expect(requestGateway).toHaveBeenCalledWith('sessions.describe', { key: child('one').key }),
  );
  const queued = discover();
  expect(discover()).toBe(queued);
  expect(queued).not.toBe(first);
  expect(scans).toBe(1);
  finishDescription({ session: { worktree: { id: 'one' }, spawnedCwd: 'E:\\repo\\one' } });
  await queued;

  expect(scans).toBe(2);
  expect(store.adoptNativeSession.mock.calls.map(([key]) => key)).toEqual([
    child('one').key,
    child('two').key,
  ]);
  expect(onSessionsChanged).toHaveBeenCalledTimes(2);
});

test('a refresh triggered by adoption stops after its trailing scan finds no new worktrees', async () => {
  const parent = { id: 'parent', agentId: 'main', nativeSessionKey: 'agent:main:justdo:parent' };
  let adopted = false;
  const requestGateway = vi.fn(async (method: string) =>
    method === 'sessions.list'
      ? {
          sessions: [
            {
              key: 'agent:main:subagent:one',
              parentSessionKey: parent.nativeSessionKey,
              worktree: { id: 'one' },
            },
          ],
        }
      : { session: { worktree: { id: 'one' }, spawnedCwd: 'E:\\repo\\one' } },
  );
  const store = {
    listSessionDirectory: () => [parent],
    getSession: () => parent,
    getSessionByNativeKey: () => (adopted ? { id: 'one' } : null),
    adoptNativeSession: vi.fn(() => {
      adopted = true;
      return { id: 'one' };
    }),
  };
  let trailing: Promise<void> | undefined;
  const onSessionsChanged = vi.fn(() => {
    trailing = discover();
  });
  const discover = createNativeWorktreeDiscovery({
    getCoworkStore: () => store as unknown as CoworkStore,
    requestGateway: requestGateway as <T>(method: string, params?: unknown) => Promise<T>,
    onSessionsChanged,
  });

  await discover();
  await trailing;

  expect(requestGateway.mock.calls.filter(([method]) => method === 'sessions.list')).toHaveLength(
    2,
  );
  expect(store.adoptNativeSession).toHaveBeenCalledOnce();
  expect(onSessionsChanged).toHaveBeenCalledOnce();
});
