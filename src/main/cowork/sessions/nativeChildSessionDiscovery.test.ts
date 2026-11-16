import path from 'path';
import { expect, test, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import { createNativeChildSessionDiscovery } from './nativeChildSessionDiscovery';

const parent = { id: 'parent', agentId: 'main', nativeSessionKey: 'agent:main:justdo:parent' };

const child = (id: number) => ({
  key: `agent:main:dashboard:00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  sessionId: `native-child-${id}`,
  parentSessionKey: parent.nativeSessionKey,
  createdVia: 'spawn',
  spawnDepth: 1,
  label: `Child ${id}`,
  sessionRoot: path.resolve('project', String(id)),
  permissionMode: 'workspace',
});

const createStore = () => {
  const known = new Set<string>();
  return {
    listSessionDirectory: () => [parent],
    getSession: vi.fn<(_id: string) => typeof parent | null>(() => parent),
    getSessionByNativeKey: (key: string) => (known.has(key) ? { id: key } : null),
    adoptNativeSession: vi.fn((key: string) => {
      known.add(key);
      return { id: key };
    }),
  };
};

test('queues one fresh scan for changes arriving after the first native snapshot', async () => {
  const firstChild = child(1);
  const secondChild = child(2);
  let finishDescription!: (value: unknown) => void;
  const firstDescription = new Promise(resolve => {
    finishDescription = resolve;
  });
  let scans = 0;
  const requestGateway = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sessions.list') {
      scans += 1;
      return { sessions: scans === 1 ? [firstChild] : [firstChild, secondChild] };
    }
    const key = (params as { key: string }).key;
    return key === firstChild.key ? firstDescription : { session: secondChild };
  });
  const store = createStore();
  const discover = createNativeChildSessionDiscovery({
    getCoworkStore: () => store as unknown as CoworkStore,
    requestGateway: requestGateway as <T>(method: string, params?: unknown) => Promise<T>,
  });

  const first = discover();
  await vi.waitFor(() =>
    expect(requestGateway).toHaveBeenCalledWith('sessions.describe', { key: firstChild.key }),
  );
  const queued = discover();
  expect(discover()).toBe(queued);
  expect(queued).not.toBe(first);
  expect(scans).toBe(1);
  finishDescription({ session: firstChild });
  await queued;

  expect(scans).toBe(2);
  expect(store.adoptNativeSession.mock.calls.map(([key]) => key)).toEqual([
    firstChild.key,
    secondChild.key,
  ]);
  expect(store.adoptNativeSession).toHaveBeenCalledWith(
    firstChild.key,
    parent,
    firstChild.label,
    firstChild.sessionRoot,
    'auto',
  );
});

test('keeps ordinary, hidden, and ineligible sessions out of the interactive child bindings', async () => {
  const hidden = {
    ...child(1),
    key: 'agent:main:subagent:00000000-0000-4000-8000-000000000001',
    worktree: { id: 'hidden', branch: 'child', repoRoot: path.resolve('project') },
  };
  const operatorFork = { ...child(2), createdVia: 'operator', spawnDepth: 0 };
  const crossAgent = { ...child(3), key: child(3).key.replace('main', 'other') };
  const incognito = { ...child(4), incognito: true };
  const remote = { ...child(5), repositoryWorkspaceId: 'cloud-workspace' };
  const replacement = child(6);
  const unsupported = { ...child(7), permissionMode: 'read-only' };
  const store = createStore();
  const requestGateway = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sessions.list') {
      return {
        sessions: [hidden, operatorFork, crossAgent, incognito, remote, replacement, unsupported],
      };
    }
    const key = (params as { key: string }).key;
    return {
      session:
        key === replacement.key
          ? { ...replacement, sessionId: 'replacement-incarnation' }
          : unsupported,
    };
  });
  const discover = createNativeChildSessionDiscovery({
    getCoworkStore: () => store as unknown as CoworkStore,
    requestGateway: requestGateway as <T>(method: string, params?: unknown) => Promise<T>,
  });

  await discover();

  expect(requestGateway.mock.calls.filter(([method]) => method === 'sessions.describe')).toEqual([
    ['sessions.describe', { key: replacement.key }],
    ['sessions.describe', { key: unsupported.key }],
  ]);
  expect(store.adoptNativeSession).not.toHaveBeenCalled();
});

test('skips adoption if the product parent is removed during the detail query', async () => {
  const nativeChild = child(1);
  const store = createStore();
  const requestGateway = vi.fn(async (method: string) => {
    if (method === 'sessions.list') return { sessions: [nativeChild] };
    store.getSession.mockReturnValue(null);
    return { session: nativeChild };
  });
  const discover = createNativeChildSessionDiscovery({
    getCoworkStore: () => store as unknown as CoworkStore,
    requestGateway: requestGateway as <T>(method: string, params?: unknown) => Promise<T>,
  });

  await discover();

  expect(store.adoptNativeSession).not.toHaveBeenCalled();
});
